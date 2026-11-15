/**
 * EditorBridge: position helpers, and a randomised convergence test with a
 * simulated editor that follows Neovim's rules (on_bytes positions in a model
 * where every line ends with "\n", stale remote edits dropped by base).
 *
 * Reproduce a failure with FUZZ_SEED=<seed> bun test test/unit/editor-bridge.test.ts
 */
import { describe, expect, test } from 'bun:test';
import {
  EditorBridge,
  indexFromPos,
  posFromIndex,
  toWireEdits,
  utf8Length,
  type BridgeMessage,
  type EditorMessage,
  type WireEdit,
} from '../../src/editor-bridge.js';
import { TextOperation } from '../../src/text-operation.js';
import { SimpleEventEmitter } from '../../src/simple-event-emitter.js';
import type { CursorPosition } from '../../src/cursor.js';
import type { UserInfo } from '../../src/hedgedoc-client.js';
import { rng } from '../sim/sim-server.js';

describe('position helpers', () => {
  test('byte columns and UTF-16 offsets', () => {
    const text = 'aé🙂b\nxy\n';
    expect(indexFromPos(text, 0, 0)).toBe(0);
    expect(indexFromPos(text, 0, 1)).toBe(1);
    expect(indexFromPos(text, 0, 3)).toBe(2); // after é (2 bytes)
    expect(indexFromPos(text, 0, 7)).toBe(4); // after 🙂 (4 bytes, 2 code units)
    expect(indexFromPos(text, 0, 9)).toBe(6); // the newline itself
    expect(indexFromPos(text, 0, 10)).toBeNull();
    expect(indexFromPos(text, 1, 2)).toBe(8);
    expect(indexFromPos(text, 2, 0)).toBe(9); // one past the last line
    expect(indexFromPos(text, 3, 0)).toBeNull();
    expect(posFromIndex(text, 5)).toEqual({ row: 0, col: 8 });
    expect(posFromIndex(text, 6)).toEqual({ row: 1, col: 0 });
  });

  test('wire edits apply back to front', () => {
    const base = 'one\ntwo\nthree';
    const op = new TextOperation().retain(1).delete(2).insert('NE').retain(5).insert('!').retain(5);
    const edits = toWireEdits(base, op);
    expect(edits).toEqual([
      { sr: 2, sc: 0, er: 2, ec: 0, text: '!' },
      { sr: 0, sc: 1, er: 0, ec: 3, text: 'NE' },
    ]);
    expect(applyWire(base, edits)).toBe(op.apply(base));
  });
});

function applyWire(text: string, edits: WireEdit[]): string {
  for (const e of edits) {
    const model = text + '\n';
    const start = indexFromPos(model, e.sr, e.sc)!;
    const end = indexFromPos(model, e.er, e.ec)!;
    text = text.slice(0, start) + e.text + text.slice(end);
  }
  return text;
}

class FakeClient extends SimpleEventEmitter {
  document: string;
  connected = true;
  users = new Map<string, UserInfo>();
  cursor: CursorPosition | null = null;

  constructor(text: string) {
    super();
    this.document = text;
  }

  getDocument(): string {
    return this.document;
  }

  applyOperation(op: TextOperation): void {
    if (!this.connected) throw new Error('Client not ready. Wait for connection to complete.');
    if (op.baseLength !== this.document.length) throw new Error('base length mismatch');
    this.document = op.apply(this.document);
  }

  setCursor(cursor: CursorPosition | null): void {
    this.cursor = cursor;
  }

  remote(op: TextOperation): void {
    this.document = op.apply(this.document);
    this.emit('change', { type: 'remote', operation: op });
  }
}

/** Behaves like the Lua plugin. */
class FakeEditor {
  text = '';
  E = 0;
  R = 0;
  epoch = 0;
  stale = 0;

  constructor(private readonly out: EditorMessage[]) {}

  receive(msg: BridgeMessage): void {
    if (msg.t === 'reset') {
      this.text = msg.text;
      this.epoch = msg.epoch;
      this.E = 0;
      this.R = msg.seq;
    } else if (msg.t === 'edit') {
      if (msg.base !== this.E) {
        this.stale++;
        return;
      }
      this.text = applyWire(this.text, msg.edits);
      this.R = msg.seq;
    }
  }

  /** Replace model range [s, e) with t, reporting it like on_bytes. */
  edit(s: number, e: number, t: string): void {
    const model = this.text + '\n';
    const next = model.slice(0, s) + t + model.slice(e);
    const start = posFromIndex(model, s);
    const end = posFromIndex(model, e);
    this.text = next.slice(0, -1);
    this.E++;
    this.out.push({
      t: 'change',
      epoch: this.epoch,
      seen: this.R,
      sr: start.row,
      sc: start.col,
      oer: end.row - start.row,
      oec: end.row === start.row ? end.col - start.col : end.col,
      text: t,
      size: utf8Length(next),
    });
  }
}

const ALPHABET = ['a', 'b', 'é', '中', '\n', 'xy', '\n\n'];

function randomText(r: () => number): string {
  let s = '';
  const n = Math.floor(r() * 3);
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(r() * ALPHABET.length)];
  return s;
}

/** A local edit Neovim could report: the model must still end with "\n". */
function randomEditorEdit(editor: FakeEditor, r: () => number): void {
  const model = editor.text + '\n';
  for (;;) {
    const s = Math.floor(r() * (model.length + 1));
    const e = Math.min(model.length, s + Math.floor(r() * 5));
    let t = randomText(r);
    if (r() < 0.1) {
      // Line-wise edits around the end, like dd / o / :put on the last line.
      t = r() < 0.5 ? 'line\n' : '';
    }
    const next = model.slice(0, s) + t + model.slice(e);
    if (next.endsWith('\n') && (s !== e || t !== '')) {
      editor.edit(s, e, t);
      return;
    }
  }
}

function randomRemoteOp(doc: string, r: () => number): TextOperation {
  const pos = Math.floor(r() * (doc.length + 1));
  const len = Math.floor(r() * Math.min(4, doc.length - pos + 1));
  return new TextOperation().retain(pos).delete(len).insert(randomText(r) || 'R').retain(doc.length - pos - len);
}

function runFuzz(seed: number, steps: number): void {
  const r = rng(seed);
  const client = new FakeClient('hello\nworld\n');
  const toBridge: EditorMessage[] = [];
  const toEditor: BridgeMessage[] = [];
  const editor = new FakeEditor(toBridge);
  const desyncs: string[] = [];
  const bridge = new EditorBridge(client as any, m => toEditor.push(structuredClone(m)), {
    onDesync: reason => desyncs.push(reason),
    onSubmitError: (err) => {
      throw err;
    },
  });
  bridge.start();

  const deliverEditor = () => {
    const m = toEditor.shift();
    if (m) editor.receive(m);
  };
  // Messages reach the bridge in chunks, like lines in a pipe read.
  const deliverBridge = () => {
    const batch = toBridge.splice(0, 1 + Math.floor(r() * 4));
    if (batch.length) bridge.handleBatch(batch);
  };

  // The reset must arrive before the editor can type.
  deliverEditor();

  for (let i = 0; i < steps; i++) {
    const roll = r();
    if (roll < 0.3) randomEditorEdit(editor, r);
    else if (roll < 0.5) deliverBridge();
    else if (roll < 0.7) deliverEditor();
    else if (roll < 0.88) client.remote(randomRemoteOp(client.document, r));
    else if (roll < 0.92) {
      toBridge.push({ t: 'cursor', epoch: editor.epoch, seen: editor.R, row: 0, col: 0 });
    } else if (roll < 0.96) {
      client.connected = !client.connected;
      if (client.connected) client.emit('ready', {});
    } else {
      // Long bursts in one direction stress the resend path.
      for (let k = 0; k < 5; k++) randomEditorEdit(editor, r);
    }
  }

  if (!client.connected) {
    client.connected = true;
    client.emit('ready', {});
  }
  while (toBridge.length || toEditor.length) {
    deliverBridge();
    deliverEditor();
  }
  bridge.stop();

  expect(desyncs).toEqual([]);
  expect(bridge.hasHeldEdits()).toBe(false);
  expect(bridge.expectedEditorText).toBe(client.document);
  expect(editor.text).toBe(client.document);
}

describe('EditorBridge convergence', () => {
  const fixed = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : null;
  const seeds = fixed ?? Array.from({ length: Number(process.env.FUZZ_COUNT ?? 200) }, (_, i) => i + 1);
  test(`${seeds.length} random sessions converge`, () => {
    for (const seed of seeds) {
      try {
        runFuzz(seed, Number(process.env.FUZZ_STEPS ?? 300));
      } catch (err) {
        throw new Error(`seed ${seed}: ${(err as Error).message}`);
      }
    }
  }, 60_000);

  test('stale remote edits are dropped and resent', () => {
    const client = new FakeClient('abc');
    const toBridge: EditorMessage[] = [];
    const toEditor: BridgeMessage[] = [];
    const editor = new FakeEditor(toBridge);
    const bridge = new EditorBridge(client as any, m => toEditor.push(m));
    bridge.start();
    editor.receive(toEditor.shift()!);
    client.remote(new TextOperation().insert('X').retain(3)); // in flight...
    editor.edit(3, 3, 'Y'); // ...while the user types at the end
    editor.receive(toEditor.shift()!); // stale: dropped
    expect(editor.stale).toBe(1);
    bridge.handle(toBridge.shift()!);
    expect(client.document).toBe('XabcY');
    editor.receive(toEditor.shift()!); // the resend
    expect(editor.text).toBe('XabcY');
    bridge.stop();
  });

  test("other people's cursors are sent, this connection's own is not", async () => {
    const client = new FakeClient('ab\ncdé');
    (client as any).socket = { id: 'me' };
    client.users.set('me', { id: 'me', name: 'Me', color: '#123', cursor: { line: 0, ch: 1 } });
    client.users.set('other', { id: 'other', name: 'Ann', color: '#f00', cursor: { line: 1, ch: 3 } });
    const sent: BridgeMessage[] = [];
    const bridge = new EditorBridge(client as any, m => sent.push(m));
    bridge.start();
    client.emit('users', []);
    await new Promise(resolve => setTimeout(resolve, 60));
    bridge.stop();
    const cursors = sent.find(m => m.t === 'cursors');
    // Byte column: "cdé" is 4 bytes.
    expect(cursors).toEqual({ t: 'cursors', cursors: [{ id: 'other', name: 'Ann', color: '#f00', row: 1, col: 4 }] });
  });
});
