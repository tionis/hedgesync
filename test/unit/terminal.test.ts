import { afterEach, describe, expect, test } from 'bun:test';
import { HedgeDocClient } from '../../src/hedgedoc-client.js';
import { NoteTerminal, findTerminalBlock, sanitizeTerminalOutput, type NoteTerminalOptions } from '../../src/terminal.js';
import { TextOperation } from '../../src/text-operation.js';
import { SimServer, tick } from '../sim/sim-server.js';
import { connectClient, stopAll } from './helpers.js';

let clients: HedgeDocClient[] = [];
let terminals: NoteTerminal[] = [];

afterEach(() => {
  for (const t of terminals) t.stop();
  stopAll(clients);
  clients = [];
  terminals = [];
});

/** A note with the terminal host and a human collaborator. */
async function setup(document: string, options: NoteTerminalOptions = {}) {
  const server = new SimServer({ document });
  const host = await connectClient(server);
  const human = await connectClient(server);
  clients.push(host, human);
  const terminal = new NoteTerminal(host, { shell: 'sh', debounceMs: 5, flushIntervalMs: 10, ...options });
  terminals.push(terminal);
  const pump = async (until: () => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      server.drain();
      await tick(5);
      if (until()) {
        server.drain();
        await tick(2);
        server.drain();
        return;
      }
    }
    throw new Error(`condition not met; server doc: ${JSON.stringify(server.document)}`);
  };
  /** Type at the end of the prompt line and press Enter. */
  const submit = (command: string) => {
    const doc = human.document;
    const fence = doc.lastIndexOf('```\n');
    human.insert(fence - 1, command + '\n');
  };
  const identify = (userid: string | null, name = 'Human') => {
    host.users.set(human.socket!.id!, { id: human.socket!.id!, userid, name });
  };
  return { server, host, human, terminal, pump, submit, identify };
}

describe('findTerminalBlock', () => {
  test('finds the named block and skips others', () => {
    const doc = '```sh\n$ not this\n```\n\n````terminal\n$ ls\n````\n';
    const block = findTerminalBlock(doc, 'terminal')!;
    expect(doc.slice(block.contentStart, block.closeStart)).toBe('$ ls\n');
    expect(block.fenceLength).toBe(4);
    expect(block.closed).toBe(true);
  });

  test('does not mistake a terminal fence inside another block', () => {
    expect(findTerminalBlock('~~~md\n```terminal\n~~~\n', 'terminal')).toBeNull();
  });

  test('reports an unclosed block', () => {
    expect(findTerminalBlock('```terminal\n$ \n', 'terminal')!.closed).toBe(false);
  });
});

describe('sanitizeTerminalOutput', () => {
  test('strips colours and applies carriage returns', () => {
    expect(sanitizeTerminalOutput('\x1b[31mred\x1b[0m\n10%\r50%\r100%\n')).toBe('red\n100%\n');
  });

  test('defuses lines that would close the fence', () => {
    expect(sanitizeTerminalOutput('a\n```\nb', '`', 3)).toBe('a\n​```\nb');
    expect(sanitizeTerminalOutput('```', '`', 4)).toBe('```');
  });
});

describe('TextOperation.transformPosition', () => {
  test('a position inside a deletion after an insert lands at the deletion', () => {
    // "0123456789": insert "xx" at 0, delete [2, 5); position 3 was deleted.
    const op = new TextOperation().insert('xx').retain(2).delete(3).retain(5);
    expect(TextOperation.transformPosition(3, op)).toBe(4);
  });
});

describe('NoteTerminal', () => {
  test('adds a terminal block to a note without one', async () => {
    const { server, terminal, pump } = await setup('# Notes\n');
    terminal.start();
    await pump(() => server.document.includes('```terminal'));
    expect(server.document).toBe('# Notes\n\n```terminal\n$ \n```\n');
  });

  test('runs a submitted command and shows its output', async () => {
    const { server, terminal, pump, submit } = await setup('');
    terminal.start();
    await pump(() => server.document.includes('$ '));
    submit('echo hello');
    await pump(() => server.document.endsWith('$ \n```\n') && server.document.includes('hello\n'));
    expect(server.document).toBe('```terminal\n$ echo hello\nhello\n$ \n```\n');
  });

  test('streams output while the command runs', async () => {
    const { server, terminal, pump, submit } = await setup('');
    let done = 0;
    terminal.on('done', () => done++);
    terminal.start();
    await pump(() => server.document.includes('$ '));
    submit('echo first; sleep 0.5; echo second');
    await pump(() => server.document.includes('second\nfirst'));
    expect(terminal.busy).toBe(true);
    expect(server.document).toBe('```terminal\n$ echo first; sleep 0.5; echo second\nfirst\n```\n');
    await pump(() => done === 1);
    expect(server.document).toBe('```terminal\n$ echo first; sleep 0.5; echo second\nfirst\nsecond\n$ \n```\n');
  });

  test('keeps shell state between commands and reports failures', async () => {
    const { server, terminal, pump, submit } = await setup('');
    let done = 0;
    terminal.on('done', () => done++);
    terminal.start();
    await pump(() => server.document.includes('$ '));
    submit('X=42; cd /');
    await pump(() => done === 1);
    submit('echo "$X $PWD"; false');
    await pump(() => done === 2);
    expect(server.document).toBe('```terminal\n$ X=42; cd /\n$ echo "$X $PWD"; false\n42 /\n[exit 1]\n$ \n```\n');
  });

  test('runs multi-line input once it ends in an empty line', async () => {
    const { server, terminal, pump, human } = await setup('```terminal\n$ \n```\n');
    let done = 0;
    terminal.on('done', () => done++);
    terminal.start();
    await pump(() => true);
    human.insert(13, 'cat <<EOF\nline one\nEOF\n');
    await tick(40);
    server.drain();
    expect(done).toBe(0);
    const fence = human.document.lastIndexOf('```');
    human.insert(fence, '\n');
    await pump(() => done === 1);
    expect(server.document).toBe('```terminal\n$ cat <<EOF\nline one\nEOF\nline one\n$ \n```\n');
  });

  test('starts a fresh prompt when the note already has unsent input', async () => {
    const { server, terminal, pump } = await setup('```terminal\n$ rm -rf ~\n```\n');
    terminal.start();
    await pump(() => server.document.includes('$ \n```'));
    expect(server.document).toBe('```terminal\n$ rm -rf ~\n$ \n```\n');
  });

  test('refuses input from users who are not allowed', async () => {
    const { server, terminal, pump, submit, identify } = await setup('', { allowedUserIds: ['alice'] });
    let ran = 0;
    terminal.on('command', () => ran++);
    terminal.start();
    await pump(() => server.document.includes('$ '));
    identify('mallory', 'Mallory');
    submit('echo pwned');
    await pump(() => server.document.includes('[refused'));
    expect(ran).toBe(0);
    expect(server.document).toBe('```terminal\n$ echo pwned\n[refused: edited by Mallory, who may not run commands here]\n$ \n```\n');
  });

  test('allows listed accounts', async () => {
    const { server, terminal, pump, submit, identify } = await setup('', { allowedUserIds: ['alice'] });
    terminal.start();
    await pump(() => server.document.includes('$ '));
    identify('alice', 'Alice');
    submit('echo hi');
    await pump(() => server.document.includes('hi\n$ '));
  });

  test('a timeout kills the command and the next one gets a new shell', async () => {
    const { server, terminal, pump, submit } = await setup('', { timeoutMs: 200 });
    let done = 0;
    terminal.on('done', () => done++);
    terminal.start();
    await pump(() => server.document.includes('$ '));
    submit('echo start; sleep 5');
    await pump(() => done === 1);
    expect(server.document).toContain('start\n[timed out after 0.2s; started a new shell]\n$ \n');
    submit('echo again');
    await pump(() => done === 2);
    expect(server.document).toContain('again\n$ \n');
  });

  test('stop marks the session closed', async () => {
    const { server, terminal, pump } = await setup('');
    terminal.start();
    await pump(() => server.document.includes('$ '));
    terminal.stop();
    await pump(() => server.document.includes('[terminal closed]'));
    expect(server.document).toBe('```terminal\n[terminal closed]\n```\n');
  });

  test('caps long output', async () => {
    const { server, terminal, pump, submit } = await setup('', { maxOutput: 100 });
    let done = 0;
    terminal.on('done', () => done++);
    terminal.start();
    await pump(() => server.document.includes('$ '));
    submit('seq 1 1000');
    await pump(() => done === 1);
    expect(server.document).toContain('[output truncated]\n$ \n');
    expect(server.document.length).toBeLessThan(200);
  });
});
