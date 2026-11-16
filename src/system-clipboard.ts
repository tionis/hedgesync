/**
 * The system clipboard through the usual command line tools: wl-copy and
 * wl-paste (Wayland), xclip or xsel (X11), pbcopy and pbpaste (macOS),
 * PowerShell (Windows). HEDGESYNC_CLIP_COPY_CMD, HEDGESYNC_CLIP_PASTE_CMD and
 * HEDGESYNC_CLIP_TYPES_CMD override them (shell commands; copy reads stdin),
 * and HEDGESYNC_CLIP_IMAGE_COPY_CMD / HEDGESYNC_CLIP_IMAGE_PASTE_CMD do the
 * same for PNG images (bytes on stdin / stdout).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  /** The clipboard's image as PNG, if it holds one and the tool can read it. */
  pasteImage?(): Buffer | null;
  /** Put a PNG image on the clipboard. */
  copyImage?(png: Buffer): void;
}

/** Whether the clipboard's types include an image. */
export function hasImage(types: string[]): boolean {
  return types.some(t => /^image\/png$|^public\.png$|^PNG$|^Bitmap$|^DeviceIndependentBitmap$|^System\.Drawing\.Bitmap$/i.test(t));
}

function runBytes(cmd: string, args: string[], input?: Buffer): Buffer | null {
  const r = spawnSync(cmd, args, { input, timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/** Run `fn` with a path in a fresh temporary directory, removed afterwards. */
function withTempFile<T>(name: string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hedgesync-clip-'));
  try {
    return fn(join(dir, name));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const nonEmpty = (b: Buffer | null) => (b && b.length > 0 ? b : null);

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
      ...(env.HEDGESYNC_CLIP_IMAGE_PASTE_CMD ? {
        pasteImage: () => nonEmpty(process.platform === 'win32'
          ? runBytes('cmd', ['/c', env.HEDGESYNC_CLIP_IMAGE_PASTE_CMD!])
          : runBytes('sh', ['-c', env.HEDGESYNC_CLIP_IMAGE_PASTE_CMD!])),
      } : {}),
      ...(env.HEDGESYNC_CLIP_IMAGE_COPY_CMD ? {
        copyImage: (png: Buffer) => {
          const out = process.platform === 'win32'
            ? runBytes('cmd', ['/c', env.HEDGESYNC_CLIP_IMAGE_COPY_CMD!], png)
            : runBytes('sh', ['-c', env.HEDGESYNC_CLIP_IMAGE_COPY_CMD!], png);
          if (out === null) fail('HEDGESYNC_CLIP_IMAGE_COPY_CMD', 'write');
        },
      } : {}),
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
      pasteImage: () => withTempFile('clip.png', (file) => {
        const ok = run('osascript', ['-e', `set f to open for access (POSIX file "${file}") with write permission`,
          '-e', 'try', '-e', 'write (the clipboard as «class PNGf») to f', '-e', 'end try', '-e', 'close access f']);
        return ok !== null && existsSync(file) ? nonEmpty(readFileSync(file)) : null;
      }),
      copyImage: (png: Buffer) => withTempFile('clip.png', (file) => {
        writeFileSync(file, png);
        if (run('osascript', ['-e', `set the clipboard to (read (POSIX file "${file}") as «class PNGf»)`]) === null) fail('osascript', 'write');
      }),
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
      pasteImage: () => withTempFile('clip.png', (file) => {
        const ok = ps(`Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $i = [Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${file.replace(/'/g, "''")}', [Drawing.Imaging.ImageFormat]::Png) }`);
        return ok !== null && existsSync(file) ? nonEmpty(readFileSync(file)) : null;
      }),
      copyImage: (png: Buffer) => withTempFile('clip.png', (file) => {
        writeFileSync(file, png);
        const ok = ps(`Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $i = [Drawing.Image]::FromFile('${file.replace(/'/g, "''")}'); [Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()`);
        if (ok === null) fail('PowerShell', 'write');
      }),
    };
  }
  if (env.WAYLAND_DISPLAY && has('wl-copy')) {
    return {
      name: 'wl-clipboard',
      copy: (t) => { if (run('wl-copy', [], t) === null) fail('wl-copy', 'write'); },
      // --type text: without it, an image alone on the clipboard would come back as "text".
      paste: () => run('wl-paste', ['--no-newline', '--type', 'text']),
      types: () => run('wl-paste', ['--list-types'])?.split('\n').filter(Boolean) ?? [],
      pasteImage: () => nonEmpty(runBytes('wl-paste', ['--type', 'image/png'])),
      copyImage: (png: Buffer) => { if (runBytes('wl-copy', ['--type', 'image/png'], png) === null) fail('wl-copy', 'write'); },
    };
  }
  if (env.DISPLAY && has('xclip')) {
    return {
      name: 'xclip',
      copy: (t) => { if (run('xclip', ['-selection', 'clipboard', '-i'], t) === null) fail('xclip', 'write'); },
      paste: () => run('xclip', ['-selection', 'clipboard', '-o']),
      types: () => run('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'])?.split('\n').filter(Boolean) ?? [],
      pasteImage: () => nonEmpty(runBytes('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'])),
      copyImage: (png: Buffer) => { if (runBytes('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i'], png) === null) fail('xclip', 'write'); },
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
