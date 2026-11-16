/**
 * The system clipboard through the usual command line tools: wl-copy and
 * wl-paste (Wayland), xclip or xsel (X11), pbcopy and pbpaste (macOS),
 * PowerShell (Windows). HEDGESYNC_CLIP_COPY_CMD, HEDGESYNC_CLIP_PASTE_CMD and
 * HEDGESYNC_CLIP_TYPES_CMD override them (shell commands; copy reads stdin).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SystemClipboard {
  name: string;
  copy(text: string): void;
  paste(): string | null;
  /**
   * The clipboard's content types, to recognise what password managers mark
   * as secret; null where they cannot be listed.
   */
  types(): string[] | null;
}

function run(cmd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string | null {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 5000, windowsHide: true, env: env ? { ...process.env, ...env } : undefined });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

const has = (cmd: string) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? [cmd] : ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
  return r.status === 0;
};

function sh(command: string, input?: string): string | null {
  return process.platform === 'win32' ? run('cmd', ['/c', command], input) : run('sh', ['-c', command], input);
}

function fail(name: string, what: string): never {
  throw new Error(`Could not ${what} the clipboard with ${name}`);
}

/** The clipboard tool for this session, or null if none is found. */
export function systemClipboard(env: NodeJS.ProcessEnv = process.env): SystemClipboard | null {
  if (env.HEDGESYNC_CLIP_COPY_CMD || env.HEDGESYNC_CLIP_PASTE_CMD) {
    const copyCmd = env.HEDGESYNC_CLIP_COPY_CMD;
    const pasteCmd = env.HEDGESYNC_CLIP_PASTE_CMD;
    const typesCmd = env.HEDGESYNC_CLIP_TYPES_CMD;
    return {
      name: 'custom commands',
      copy: (t) => { if (!copyCmd || sh(copyCmd, t) === null) fail('HEDGESYNC_CLIP_COPY_CMD', 'write'); },
      paste: () => (pasteCmd ? sh(pasteCmd) : null),
      types: () => (typesCmd ? (sh(typesCmd) ?? '').split('\n').filter(Boolean) : null),
    };
  }
  if (process.platform === 'darwin') {
    // pbcopy/pbpaste pick the text encoding from the locale; without one they mangle non-ASCII text.
    const utf8 = { LC_CTYPE: 'UTF-8' };
    // The pasteboard's types, through JavaScript for Automation (no extra tools needed).
    const typesScript = "ObjC.import('AppKit'); var t = $.NSPasteboard.generalPasteboard.types; var o = []; "
      + 'for (var i = 0; i < t.count; i++) o.push(ObjC.unwrap(t.objectAtIndex(i))); o.join("\\n")';
    return {
      name: 'pbcopy',
      copy: (t) => { if (run('pbcopy', [], t, utf8) === null) fail('pbcopy', 'write'); },
      paste: () => run('pbpaste', [], undefined, utf8),
      types: () => run('osascript', ['-l', 'JavaScript', '-e', typesScript])?.split('\n').map(t => t.trim()).filter(Boolean) ?? null,
    };
  }
  if (process.platform === 'win32') {
    // Windows PowerShell (STA, which the clipboard needs), told to speak UTF-8.
    const ps = (script: string) => run('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-Command',
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`]);
    return {
      name: 'PowerShell',
      copy: (t) => {
        // Through a file: stdin and arguments would mangle the encoding or hit length limits.
        const dir = mkdtempSync(join(tmpdir(), 'hedgesync-clip-'));
        try {
          const file = join(dir, 'clip.txt');
          writeFileSync(file, t);
          const out = ps(`Set-Clipboard -Value ([IO.File]::ReadAllText('${file.replace(/'/g, "''")}', [Text.Encoding]::UTF8))`);
          if (out === null) fail('PowerShell', 'write');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      paste: () => {
        const out = ps('$t = Get-Clipboard -Raw; if ($t) { [Console]::Out.Write($t) }');
        return out === null ? null : out;
      },
      types: () => ps('Add-Type -AssemblyName System.Windows.Forms; $d = [Windows.Forms.Clipboard]::GetDataObject(); if ($d) { $d.GetFormats() -join "`n" }')
        ?.split(/\r?\n/).map(t => t.trim()).filter(Boolean) ?? null,
    };
  }
  if (env.WAYLAND_DISPLAY && has('wl-copy')) {
    return {
      name: 'wl-clipboard',
      copy: (t) => { if (run('wl-copy', [], t) === null) fail('wl-copy', 'write'); },
      paste: () => run('wl-paste', ['--no-newline']),
      types: () => run('wl-paste', ['--list-types'])?.split('\n').filter(Boolean) ?? [],
    };
  }
  if (env.DISPLAY && has('xclip')) {
    return {
      name: 'xclip',
      copy: (t) => { if (run('xclip', ['-selection', 'clipboard', '-i'], t) === null) fail('xclip', 'write'); },
      paste: () => run('xclip', ['-selection', 'clipboard', '-o']),
      types: () => run('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'])?.split('\n').filter(Boolean) ?? [],
    };
  }
  if (env.DISPLAY && has('xsel')) {
    return {
      name: 'xsel',
      copy: (t) => { if (run('xsel', ['--clipboard', '--input'], t) === null) fail('xsel', 'write'); },
      paste: () => run('xsel', ['--clipboard', '--output']),
      types: () => null,
    };
  }
  return null;
}

/**
 * Content types password managers set to mark a clipboard entry as secret:
 * KDE's hint (KeePassXC, Plasma), the nspasteboard.org types on macOS, and
 * the formats Windows clipboard history and monitors are told to skip.
 */
export function isConcealed(types: string[]): boolean {
  return types.some(t => /passwordManagerHint|org\.nspasteboard\.(Concealed|Transient|AutoGenerated)Type|ExcludeClipboardContentFromMonitorProcessing|Clipboard Viewer Ignore|CanIncludeInClipboardHistory|CanUploadToCloudClipboard/i.test(t));
}
