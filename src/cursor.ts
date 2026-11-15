/**
 * Cursor positions as HedgeDoc 1 exchanges them (CodeMirror 5 style:
 * zero-based line and column), and conversion to and from text offsets.
 */

/** A cursor position: zero-based line and column (in UTF-16 code units). */
export interface CursorPosition {
  line: number;
  ch: number;
}

/** The line/column of a text offset (clamped to the text). */
export function cursorFromIndex(text: string, index: number): CursorPosition {
  const clamped = Math.max(0, Math.min(index, text.length));
  let line = 0;
  let lineStart = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < clamped; i = text.indexOf('\n', i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, ch: clamped - lineStart };
}

/** The text offset of a line/column (clamped to existing lines and line ends). */
export function indexFromCursor(text: string, cursor: CursorPosition): number {
  let lineStart = 0;
  for (let line = 0; line < Math.max(0, Math.floor(cursor.line)); line++) {
    const next = text.indexOf('\n', lineStart);
    if (next === -1) return text.length;
    lineStart = next + 1;
  }
  const lineEnd = text.indexOf('\n', lineStart);
  const end = lineEnd === -1 ? text.length : lineEnd;
  return Math.min(lineStart + Math.max(0, Math.floor(cursor.ch)), end);
}

/** Whether a value looks like a cursor position. */
export function isCursorPosition(value: unknown): value is CursorPosition {
  const v = value as CursorPosition | null;
  return typeof v === 'object' && v !== null && Number.isFinite(v.line) && Number.isFinite(v.ch);
}
