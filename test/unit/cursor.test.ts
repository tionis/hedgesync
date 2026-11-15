import { afterEach, describe, expect, test } from 'bun:test';
import type { HedgeDocClient } from '../../src/hedgedoc-client.js';
import { cursorFromIndex, indexFromCursor, isCursorPosition } from '../../src/cursor.js';
import { SimServer } from '../sim/sim-server.js';
import { connectClient, settle, stopAll } from './helpers.js';

describe('cursor conversion', () => {
  const text = 'ab\ncde\n\nf';
  test('index to cursor and back', () => {
    for (let i = 0; i <= text.length; i++) {
      expect(indexFromCursor(text, cursorFromIndex(text, i))).toBe(i);
    }
    expect(cursorFromIndex(text, 0)).toEqual({ line: 0, ch: 0 });
    expect(cursorFromIndex(text, 3)).toEqual({ line: 1, ch: 0 });
    expect(cursorFromIndex(text, 7)).toEqual({ line: 2, ch: 0 });
    expect(cursorFromIndex(text, 9)).toEqual({ line: 3, ch: 1 });
  });
  test('clamps out-of-range positions', () => {
    expect(cursorFromIndex(text, -5)).toEqual({ line: 0, ch: 0 });
    expect(cursorFromIndex(text, 99)).toEqual({ line: 3, ch: 1 });
    expect(indexFromCursor(text, { line: 0, ch: 99 })).toBe(2);
    expect(indexFromCursor(text, { line: 99, ch: 0 })).toBe(text.length);
    expect(indexFromCursor(text, { line: -1, ch: -1 })).toBe(0);
    expect(indexFromCursor('', { line: 0, ch: 3 })).toBe(0);
  });
  test('isCursorPosition', () => {
    expect(isCursorPosition({ line: 1, ch: 2 })).toBe(true);
    expect(isCursorPosition({ line: 1 })).toBe(false);
    expect(isCursorPosition(null)).toBe(false);
    expect(isCursorPosition('x')).toBe(false);
  });
});

describe('remote cursors', () => {
  let clients: HedgeDocClient[] = [];
  afterEach(() => {
    stopAll(clients);
    clients = [];
  });

  test('focus, activity and blur reach the other client and its users', async () => {
    const server = new SimServer({ document: 'hello\nworld' });
    const a = await connectClient(server);
    const b = await connectClient(server);
    clients = [a, b];
    const events: Array<[string, unknown]> = [];
    for (const e of ['cursor:focus', 'cursor:activity', 'cursor:blur'] as const) {
      b.on(e, (data: unknown) => events.push([e, data]));
    }
    const aId = a.socket!.id!;

    a.setCursor({ line: 1, ch: 2 });
    a.setCursor({ line: 0, ch: 5 });
    await settle(server, clients);
    expect(events.map(e => e[0])).toEqual(['cursor:focus', 'cursor:activity']);
    expect((events[1][1] as { id: string; cursor: unknown }).id).toBe(aId);
    expect((events[1][1] as { cursor: unknown }).cursor).toEqual({ line: 0, ch: 5 });
    expect(b.getOnlineUsers().find(u => u.id === aId)?.cursor).toEqual({ line: 0, ch: 5 });

    a.setCursor(null);
    a.setCursor(null); // a second blur is not sent
    await settle(server, clients);
    expect(events.map(e => e[0])).toEqual(['cursor:focus', 'cursor:activity', 'cursor:blur']);
    expect(events[2][1]).toEqual({ id: aId });
    expect(b.getOnlineUsers().find(u => u.id === aId)?.cursor ?? null).toBeNull();
  });

  test('invalid cursors from the server become null', async () => {
    const server = new SimServer({ document: 'x' });
    const a = await connectClient(server);
    const b = await connectClient(server);
    clients = [a, b];
    let got: unknown = 'unset';
    b.on('cursor:focus', (u: { cursor: unknown }) => { got = u.cursor; });
    a.socket!.emit('cursor focus', 'garbage');
    await settle(server, clients);
    expect(got).toBeNull();
  });
});
