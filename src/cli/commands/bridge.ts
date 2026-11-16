/**
 * bridge: keystroke-level live editing from an editor plugin. Speaks
 * newline-delimited JSON on stdin/stdout (see src/editor-bridge.ts for the
 * protocol); status goes to stderr.
 */

import { BRIDGE_PROTOCOL, EditorBridge, type EditorMessage } from '../../editor-bridge.js';
import { VERSION } from '../../version.js';
import { connectionOptions, type Command } from '../context.js';
import { helpText } from '../help-text.js';
import { appendFileSync } from 'node:fs';
import { eprint } from '../ui.js';

export const bridge: Command = {
  name: 'bridge',
  summary: 'Live-edit a note from an editor plugin (JSON over stdio)',
  options: [...connectionOptions, { name: 'info', type: 'flag' }],
  help: helpText.bridge,
  async run(ctx) {
    if (ctx.flag('info')) {
      // For editor health checks: which protocol this binary speaks.
      process.stdout.write(JSON.stringify({ protocol: BRIDGE_PROTOCOL, version: VERSION }) + '\n');
      return;
    }
    const { url } = ctx.note(0, 'hedgesync bridge <url>');
    // HEDGESYNC_BRIDGE_LOG=<file> traces the protocol (for debugging plugins).
    const logFile = process.env.HEDGESYNC_BRIDGE_LOG;
    const trace = (dir: string, line: string) => {
      if (logFile) appendFileSync(logFile, `${Date.now()} ${dir} ${line}\n`);
    };
    const out = (message: object) => {
      const line = JSON.stringify(message);
      trace('>', line);
      process.stdout.write(line + '\n');
    };

    let client;
    try {
      client = await ctx.connect(0);
    } catch (err) {
      out({ t: 'error', message: (err as Error).message, fatal: true });
      throw err;
    }

    const noteState = () => {
      const { title, permission } = client.getNoteInfo();
      const editable = client.canEdit();
      return { title: title || '', editable, reason: editable ? undefined : shortReadOnlyReason(permission, client.serverUrl) };
    };
    out({ t: 'ready', protocol: BRIDGE_PROTOCOL, version: VERSION, url, noteId: client.noteId, ...noteState() });

    const editor = new EditorBridge(client, out, {
      onSubmitError: err => out({ t: 'error', message: `Edit not sent: ${err.message}` }),
      onDesync: reason => out({ t: 'status', state: 'desync', message: `Buffer resynchronised (${reason})` }),
    });
    editor.start();

    client.on('disconnect', (reason: string) => out({ t: 'status', state: 'disconnected', message: reason }));
    client.on('reconnect:attempting', () => out({ t: 'status', state: 'reconnecting' }));
    client.on('ready', () => out({ t: 'status', state: 'connected' }));
    client.on('reconnect:failed', () => out({ t: 'error', message: 'Reconnecting failed; edits are no longer synced', fatal: true }));
    client.on('permission', () => out({ t: 'note', ...noteState() }));
    client.on('refresh', () => out({ t: 'note', ...noteState() }));

    await new Promise<void>((resolve) => {
      let buffered = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        const messages: EditorMessage[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          trace('<', line);
          try {
            messages.push(JSON.parse(line));
          } catch {
            eprint(`bridge: ignoring malformed message: ${line.slice(0, 200)}`);
          }
        }
        if (messages.some(m => m.t === 'close')) {
          editor.handleBatch(messages.filter(m => m.t !== 'close'));
          resolve();
          return;
        }
        if (messages.length) editor.handleBatch(messages);
      });
      process.stdin.on('end', resolve);
      process.on('SIGTERM', resolve);
      process.on('SIGINT', resolve);
      client.on('delete', () => {
        out({ t: 'error', message: 'The note was deleted', fatal: true });
        resolve();
      });
    });

    editor.stop();
    try {
      await client.flush(5000);
    } catch (err) {
      eprint(`bridge: last edits may not have reached the server: ${(err as Error).message}`);
    }
    if (editor.hasHeldEdits()) eprint('bridge: some edits were made while disconnected and were not sent');
    client.disconnect();
    process.stdin.destroy();
  },
};

/** Why the note is read-only, short enough for one editor message line. */
function shortReadOnlyReason(permission: string | undefined, serverUrl: string): string | undefined {
  if (permission === 'editable' || permission === 'limited') return `log in: hedgesync login ${serverUrl} --save`;
  if (permission === 'locked' || permission === 'private' || permission === 'protected') return 'only the owner can edit';
  return undefined;
}
