/**
 * hedgesync share: merging a file's and a note's changes both ways.
 */
import { describe, expect, test } from 'bun:test';
import { FileNoteSync, noteText } from '../../src/cli/commands/share.js';

function setup(file: string, note: string, base = noteText(file)) {
  const state = { file: file as string | null, note, writes: 0, sets: 0 };
  const sync = new FileNoteSync(
    () => state.file,
    (t) => { state.file = t; state.writes++; },
    { get: () => state.note, set: (t) => { state.note = t; state.sets++; } },
    base,
  );
  return { state, sync };
}

describe('FileNoteSync', () => {
  test('a saved file goes to the note, without the final newline', () => {
    const { state, sync } = setup('a\nb\n', 'a\nb');
    state.file = 'a\nB\n';
    sync.sync();
    expect(state.note).toBe('a\nB');
    expect(state.writes).toBe(0);
  });

  test("others' edits are written into the file, with its final newline", () => {
    const { state, sync } = setup('a\nb\n', 'a\nb');
    state.note = 'a\nb\nc';
    sync.sync();
    expect(state.file).toBe('a\nb\nc\n');
    expect(state.sets).toBe(0);
  });

  test('changes on both sides are merged into both', () => {
    const { state, sync } = setup('one\ntwo\nthree\n', 'one\ntwo\nthree');
    state.file = 'ONE\ntwo\nthree\n';
    state.note = 'one\ntwo\nTHREE';
    sync.sync();
    expect(state.note).toBe('ONE\ntwo\nTHREE');
    expect(state.file).toBe('ONE\ntwo\nTHREE\n');
  });

  test('nothing happens when nothing changed, or the file is mid-save', () => {
    const { state, sync } = setup('x\n', 'x');
    sync.sync();
    state.file = null;
    state.note = 'y';
    sync.sync();
    expect(state).toMatchObject({ writes: 0, sets: 0, note: 'y' });
  });
});
