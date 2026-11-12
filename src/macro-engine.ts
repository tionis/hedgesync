/**
 * MacroEngine - pattern-based auto-replacement for live HedgeDoc notes.
 *
 * Design:
 * - **Dirty ranges.** In watch mode only text touched by a remote edit (from
 *   an allowed user, if filters are set) can trigger a macro. The engine's
 *   own edits never mark text dirty, so macro output cannot re-trigger
 *   macros and a trigger planted by a filtered-out user stays inert.
 * - **Anchors.** Every match is tracked as a range through all subsequent
 *   edits (local and remote). After an async handler returns, the result is
 *   applied only if the original text is still at the anchor; nothing is
 *   ever relocated by searching for it.
 * - **In-flight tracking.** Matches being handled are skipped by later scans,
 *   and streaming macros with state tracking skip triggers already marked
 *   running/done, so a command never runs twice for the same trigger.
 * - Changes that arrive while a scan is running schedule another scan.
 */

import type { ChildProcess } from 'node:child_process';
import { TextOperation } from './text-operation.js';
import { spawnShell, killShell, toShellCommand, type ShellCommand } from './shell.js';

/** The subset of HedgeDocClient the engine needs. */
interface HedgeDocClientLike {
  getDocument(): string;
  replace(index: number, length: number, text: string): void;
  delete(index: number, length: number): void;
  insert(index: number, text: string): void;
  on(event: string, handler: (...args: any[]) => void): unknown;
  off(event: string, handler: (...args: any[]) => void): unknown;
}

/** User info (mirrors HedgeDoc's UserInfo) */
interface UserInfo {
  id: string;
  userid?: string | null;
  name?: string;
}

/** Change event from HedgeDoc client */
interface ChangeEvent {
  type: 'local' | 'remote';
  operation: TextOperation;
  clientId?: string;
  user?: UserInfo;
}

// ===========================================
// Types
// ===========================================

/** Handler result: replacement text, or null/undefined to leave the match alone. */
type MaybeText = string | null | undefined;

/**
 * Regex handler, called like a String.prototype.replace callback:
 * `(match, ...groups, index, document)`.
 */
type RegexHandler = (match: string, ...args: any[]) => MaybeText | Promise<MaybeText>;

/** Streaming command builder, same arguments as RegexHandler. */
type CommandBuilder = (match: string, ...args: any[]) =>
  string | ShellCommand | null | undefined | Promise<string | ShellCommand | null | undefined>;

interface BaseMacro {
  type: string;
  name: string;
  pattern: RegExp;
}

interface TextMacro extends BaseMacro {
  type: 'text';
  trigger: string;
  replacement: (trigger: string) => MaybeText | Promise<MaybeText>;
}

interface RegexMacro extends BaseMacro {
  type: 'regex';
  handler: RegexHandler;
}

interface TemplateMacro extends BaseMacro {
  type: 'template';
  startDelim: string;
  endDelim: string;
  handler: (content: string) => MaybeText | Promise<MaybeText>;
}

interface StreamingCallbacks {
  onStart?: (match: string, position: number) => void;
  onData?: (chunk: string, position: number) => void;
  onEnd?: (exitCode: number, finalPosition: number) => void;
  onError?: (error: Error) => void;
}

interface StateTracking {
  runningMarker: string;
  doneMarker: string;
  failedMarker: string;
}

interface StreamingMacro extends BaseMacro, StreamingCallbacks {
  type: 'streaming';
  commandBuilder: CommandBuilder;
  lineBuffered: boolean;
  stateTracking: StateTracking | null;
  timeoutMs: number;
}

/** Document context passed to block handlers */
interface DocumentContext {
  fullDocument: string;
  beforeMatch: string;
  afterMatch: string;
  matchIndex: number;
  matchText: string;
  groups: string[];
}

interface BlockMacro extends BaseMacro {
  type: 'block';
  blockName: string;
  handler: (content: string, context: DocumentContext) => MaybeText | Promise<MaybeText>;
}

type Macro = TextMacro | RegexMacro | TemplateMacro | StreamingMacro | BlockMacro;

/** One expanded (or started) match */
interface MacroMatch {
  match: string;
  index: number;
  replacement?: string;
  streaming?: boolean;
}

interface Expansion {
  macro: string;
  matches: MacroMatch[];
}

interface TextMacroOptions {
  /** Only match when not surrounded by word characters (default: false) */
  wordBoundary?: boolean;
}

interface StreamingExecOptions extends StreamingCallbacks {
  /** Insert output line by line (default: true) */
  lineBuffered?: boolean;
  /**
   * Keep the trigger and append a marker: running while the command runs,
   * then done/failed. Marked triggers never run again. Without this, the
   * trigger is deleted when the command starts.
   */
  trackState?: boolean;
  runningMarker?: string;
  doneMarker?: string;
  failedMarker?: string;
  /** Kill the command after this many ms (default: no limit) */
  timeoutMs?: number;
}

/** Options for block macros (reserved for future use). */
type BlockMacroOptions = Record<string, never>;

interface BuiltinMacro {
  trigger: string;
  replacement: () => string;
}

interface MacroInfo {
  name: string;
  type: string;
  trigger?: string;
  pattern: string;
}

// ===========================================
// Section Filter Types
// ===========================================

/** Only process macros under headings matching `pattern`. */
export interface HeadingSectionFilter {
  type: 'heading';
  pattern: RegExp;
  /** Include content until the next heading of same or higher level (default: true) */
  untilNextHeading?: boolean;
  /** Specific heading level to stop at (1-6) */
  stopAtLevel?: number;
}

/** Only process macros within a line range (1-indexed, inclusive). */
export interface LinesSectionFilter {
  type: 'lines';
  start: number;
  end?: number;
}

/** Only process macros between start/end delimiter patterns. */
export interface RegexSectionFilter {
  type: 'regex';
  start: RegExp;
  end: RegExp;
  /** Include multiple sections (default: true) */
  global?: boolean;
  /** Include the delimiters in the section (default: false) */
  includeDelimiters?: boolean;
}

export type SectionFilter = HeadingSectionFilter | LinesSectionFilter | RegexSectionFilter;

export interface SectionRange {
  start: number;
  end: number;
}

interface MacroEngineOptions {
  /**
   * Only remote edits by users whose display name matches trigger macros.
   * Display names are chosen by users, so this is a convenience, not a
   * security boundary; use `allowedUserIds` for that.
   */
  userFilter?: RegExp;
  /** Only remote edits by these HedgeDoc account ids trigger macros. */
  allowedUserIds?: string[];
  /** Limit where macros are applied */
  sectionFilter?: SectionFilter;
  /** Delay before scanning after a change (ms, default 100) */
  debounceMs?: number;
}

// ===========================================
// Range tracking
// ===========================================

type RangeKind = 'match' | 'point' | 'dirty';

/** A document range kept up to date through every edit. */
class TrackedRange {
  constructor(public start: number, public end: number, readonly kind: RangeKind) {}

  transform(op: TextOperation): void {
    const tp = TextOperation.transformPosition;
    if (this.kind === 'point') {
      // Text inserted at the point lands before it (keeps streamed output in order).
      this.start = this.end = tp(this.start, op, true);
    } else if (this.kind === 'match') {
      // Inserts at the edges fall outside the match.
      this.start = tp(this.start, op, true);
      this.end = Math.max(this.start, tp(this.end, op, false));
    } else {
      // Dirty ranges grow to include adjacent inserts.
      this.start = tp(this.start, op, false);
      this.end = Math.max(this.start, tp(this.end, op, true));
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withFlags(pattern: RegExp, add: string, remove = ''): RegExp {
  let flags = pattern.flags;
  for (const f of remove) flags = flags.replace(f, '');
  for (const f of add) if (!flags.includes(f)) flags += f;
  return new RegExp(pattern.source, flags);
}

/** Ranges changed by `op`, in post-operation coordinates. Deletions yield empty ranges. */
function changedRanges(op: TextOperation): SectionRange[] {
  const ranges: SectionRange[] = [];
  let index = 0;
  for (const component of op.ops) {
    if (TextOperation.isRetain(component)) {
      index += component;
    } else if (TextOperation.isInsert(component)) {
      ranges.push({ start: index, end: index + component.length });
      index += component.length;
    } else {
      ranges.push({ start: index, end: index });
    }
  }
  return ranges;
}

interface Candidate {
  name: string;
  macro: Macro;
  match: string;
  groups: string[];
  index: number;
}

// ===========================================
// MacroEngine Class
// ===========================================

class MacroEngine {
  client: HedgeDocClientLike;
  macros: Map<string, Macro>;
  enabled: boolean;
  userFilter: RegExp | null;
  allowedUserIds: Set<string> | null;
  sectionFilter: SectionFilter | null;

  private _debounceMs: number;
  private _watching = false;
  private _processing = false;
  private _rescanRequested = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _ranges = new Set<TrackedRange>();
  private _dirty = new Set<TrackedRange>();
  private _inFlight = new Set<TrackedRange>();
  private _activeStreams = new Set<Promise<void>>();
  private _processes = new Set<ChildProcess>();
  private _changeHandler: (event: ChangeEvent) => void;
  private _attached = false;

  constructor(client: HedgeDocClientLike, options: MacroEngineOptions = {}) {
    this.client = client;
    this.macros = new Map();
    this.enabled = true;
    this.userFilter = options.userFilter ? withFlags(options.userFilter, '', 'gy') : null;
    this.allowedUserIds = options.allowedUserIds ? new Set(options.allowedUserIds) : null;
    this.sectionFilter = options.sectionFilter || null;
    this._debounceMs = options.debounceMs ?? 100;
    this._changeHandler = (event) => this._onChange(event);
  }

  // ---- registration ------------------------------------------------------

  setSectionFilter(filter: SectionFilter | null): MacroEngine {
    this.sectionFilter = filter;
    return this;
  }

  /** Replace a literal trigger string. */
  addTextMacro(
    trigger: string,
    replacement: string | ((trigger: string) => MaybeText | Promise<MaybeText>),
    options: TextMacroOptions = {}
  ): MacroEngine {
    const escaped = escapeRegExp(trigger);
    const pattern = options.wordBoundary
      ? new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'g')
      : new RegExp(escaped, 'g');
    this.macros.set(trigger, {
      type: 'text',
      name: trigger,
      trigger,
      pattern,
      replacement: typeof replacement === 'function' ? replacement : () => replacement,
    });
    return this;
  }

  /** Replace regex matches with the handler's result. */
  addRegexMacro(name: string, pattern: RegExp, handler: RegexHandler): MacroEngine {
    this.macros.set(name, { type: 'regex', name, pattern: withFlags(pattern, 'g', 'y'), handler });
    return this;
  }

  /** Replace `start…end` delimited templates, e.g. `{{name}}`. */
  addTemplateMacro(
    name: string,
    startDelim: string,
    endDelim: string,
    handler: (content: string) => MaybeText | Promise<MaybeText>
  ): MacroEngine {
    const pattern = new RegExp(`${escapeRegExp(startDelim)}([\\s\\S]+?)${escapeRegExp(endDelim)}`, 'g');
    this.macros.set(name, { type: 'template', name, pattern, startDelim, endDelim, handler });
    return this;
  }

  /** Run a command for each match and stream its stdout into the document. */
  addStreamingExecMacro(
    name: string,
    pattern: RegExp,
    commandBuilder: CommandBuilder,
    options: StreamingExecOptions = {}
  ): MacroEngine {
    this.macros.set(name, {
      type: 'streaming',
      name,
      pattern: withFlags(pattern, 'g', 'y'),
      commandBuilder,
      lineBuffered: options.lineBuffered ?? true,
      stateTracking: options.trackState
        ? {
            runningMarker: options.runningMarker ?? '→',
            doneMarker: options.doneMarker ?? '✓',
            failedMarker: options.failedMarker ?? '✗',
          }
        : null,
      timeoutMs: options.timeoutMs ?? 0,
      onStart: options.onStart,
      onData: options.onData,
      onEnd: options.onEnd,
      onError: options.onError,
    });
    return this;
  }

  /** Transform content between `::BEGIN:name::` and `::END:name::` lines. */
  addBlockMacro(
    blockName: string,
    handler: (content: string, context: DocumentContext) => MaybeText | Promise<MaybeText>,
    _options: BlockMacroOptions = {}
  ): MacroEngine {
    const escaped = escapeRegExp(blockName);
    const pattern = new RegExp(`::BEGIN:${escaped}::\\n([\\s\\S]*?)\\n::END:${escaped}::`, 'g');
    const name = `block:${blockName}`;
    this.macros.set(name, { type: 'block', name, blockName, pattern, handler });
    return this;
  }

  removeMacro(name: string): boolean {
    return this.macros.delete(name);
  }

  listMacros(): MacroInfo[] {
    return [...this.macros.entries()].map(([name, macro]) => ({
      name,
      type: macro.type,
      trigger: macro.type === 'text' ? macro.trigger : undefined,
      pattern: macro.pattern.toString(),
    }));
  }

  // ---- lifecycle -----------------------------------------------------------

  private _attach(): void {
    if (!this._attached) {
      this.client.on('change', this._changeHandler);
      this._attached = true;
    }
  }

  /** Watch for remote edits and expand macros in the text they touch. */
  start(): void {
    this._attach();
    this._watching = true;
  }

  /** Stop watching, kill running commands and release all tracking. */
  stop(): void {
    this._watching = false;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    for (const proc of this._processes) killShell(proc);
    if (this._attached) {
      this.client.off('change', this._changeHandler);
      this._attached = false;
    }
    this._dirty.clear();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Expand every macro match in the current document once. */
  async expand(): Promise<Expansion[]> {
    this._attach();
    return this._process(true);
  }

  async waitForStreams(): Promise<void> {
    while (this._activeStreams.size > 0) {
      await Promise.all([...this._activeStreams]);
    }
  }

  hasActiveStreams(): boolean {
    return this._activeStreams.size > 0;
  }

  // ---- change tracking ------------------------------------------------------

  private _track(start: number, end: number, kind: RangeKind): TrackedRange {
    const range = new TrackedRange(start, end, kind);
    this._ranges.add(range);
    return range;
  }

  private _untrack(range: TrackedRange | null | undefined): void {
    if (range) this._ranges.delete(range);
  }

  private _isAllowedAuthor(event: ChangeEvent): boolean {
    if (this.allowedUserIds) {
      const id = event.user?.userid;
      if (!id || !this.allowedUserIds.has(id)) return false;
    }
    if (this.userFilter && !this.userFilter.test(event.user?.name ?? '')) {
      return false;
    }
    return true;
  }

  private _onChange(event: ChangeEvent): void {
    if (!event.operation) return;
    for (const range of this._ranges) range.transform(event.operation);

    if (!this._watching || !this.enabled || event.type !== 'remote' || !this._isAllowedAuthor(event)) {
      return;
    }
    for (const r of changedRanges(event.operation)) {
      const range = this._track(r.start, r.end, 'dirty');
      this._dirty.add(range);
    }
    this._schedule();
  }

  private _schedule(): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._process(false).catch((err) => console.error('Macro processing failed:', err));
    }, this._debounceMs);
  }

  // ---- sections --------------------------------------------------------------

  private _getAllowedSections(document: string): SectionRange[] {
    switch (this.sectionFilter?.type) {
      case 'heading':
        return this._getHeadingSections(document, this.sectionFilter);
      case 'lines':
        return this._getLineSections(document, this.sectionFilter);
      case 'regex':
        return this._getRegexSections(document, this.sectionFilter);
      default:
        return [{ start: 0, end: document.length }];
    }
  }

  private _getHeadingSections(document: string, filter: HeadingSectionFilter): SectionRange[] {
    const sections: SectionRange[] = [];
    const lines = document.split('\n');
    const pattern = withFlags(filter.pattern, '', 'gy');
    const { untilNextHeading = true, stopAtLevel } = filter;

    const headings: { line: number; level: number; offset: number }[] = [];
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s/);
      if (m) headings.push({ line: i, level: m[1].length, offset });
      offset += lines[i].length + 1;
    }

    for (const heading of headings) {
      const line = lines[heading.line];
      if (!pattern.test(line)) continue;
      const sectionStart = Math.min(document.length, heading.offset + line.length + 1);
      let sectionEnd = document.length;
      if (untilNextHeading) {
        const stopLevel = stopAtLevel ?? heading.level;
        const next = headings.find(h => h.line > heading.line && h.level <= stopLevel);
        if (next) sectionEnd = next.offset;
      }
      if (sectionStart < sectionEnd) sections.push({ start: sectionStart, end: sectionEnd });
    }
    return sections;
  }

  private _getLineSections(document: string, filter: LinesSectionFilter): SectionRange[] {
    const lines = document.split('\n');
    const startIdx = Math.max(0, filter.start - 1);
    const endIdx = filter.end !== undefined ? Math.min(lines.length - 1, filter.end - 1) : lines.length - 1;
    if (startIdx > endIdx || startIdx >= lines.length) return [];

    let startOffset = 0;
    for (let i = 0; i < startIdx; i++) startOffset += lines[i].length + 1;
    let endOffset = startOffset;
    for (let i = startIdx; i <= endIdx; i++) {
      endOffset += lines[i].length + (i < lines.length - 1 ? 1 : 0);
    }
    return [{ start: startOffset, end: endOffset }];
  }

  private _getRegexSections(document: string, filter: RegexSectionFilter): SectionRange[] {
    const sections: SectionRange[] = [];
    const { global = true, includeDelimiters = false } = filter;
    const startRegex = withFlags(filter.start, 'g', 'y');
    const endRegex = withFlags(filter.end, 'g', 'y');

    let startMatch: RegExpExecArray | null;
    while ((startMatch = startRegex.exec(document)) !== null) {
      const afterStart = startMatch.index + startMatch[0].length;
      const sectionStart = includeDelimiters ? startMatch.index : afterStart;
      endRegex.lastIndex = afterStart;
      const endMatch = endRegex.exec(document);
      if (!endMatch) {
        sections.push({ start: sectionStart, end: document.length });
        break;
      }
      const sectionEnd = includeDelimiters ? endMatch.index + endMatch[0].length : endMatch.index;
      if (sectionStart < sectionEnd) sections.push({ start: sectionStart, end: sectionEnd });
      startRegex.lastIndex = Math.max(endMatch.index + endMatch[0].length, startRegex.lastIndex + (startMatch[0].length === 0 ? 1 : 0));
      if (!global) break;
    }
    return sections;
  }

  // ---- processing ------------------------------------------------------------

  private _takeDirty(): SectionRange[] {
    const ranges = [...this._dirty].map(r => ({ start: r.start, end: r.end }));
    for (const r of this._dirty) this._untrack(r);
    this._dirty.clear();
    return ranges;
  }

  private _findCandidates(document: string, dirty: SectionRange[] | null): Candidate[] {
    const sections = this._getAllowedSections(document);
    const inFlight = [...this._inFlight];
    const candidates: Candidate[] = [];

    for (const [name, macro] of this.macros) {
      const regex = new RegExp(macro.pattern.source, macro.pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = regex.exec(document)) !== null) {
        if (m[0].length === 0) {
          regex.lastIndex++;
          continue; // zero-length matches have nothing to replace
        }
        const start = m.index;
        const end = start + m[0].length;
        if (!sections.some(s => start >= s.start && end <= s.end)) continue;
        if (dirty && !dirty.some(d => d.start <= end && d.end >= start)) continue;
        if (inFlight.some(r => r.start < end && r.end > start)) continue;
        if (macro.type === 'streaming' && macro.stateTracking) {
          const st = macro.stateTracking;
          const rest = document.slice(end);
          if (rest.startsWith(st.runningMarker) || rest.startsWith(st.doneMarker) || rest.startsWith(st.failedMarker)) {
            continue; // already handled
          }
        }
        candidates.push({ name, macro, match: m[0], groups: m.slice(1), index: start });
      }
    }

    // Document order; when macros overlap, the earliest (then first registered) wins.
    candidates.sort((a, b) => a.index - b.index);
    const accepted: Candidate[] = [];
    let lastEnd = -1;
    for (const c of candidates) {
      if (c.index >= lastEnd) {
        accepted.push(c);
        lastEnd = c.index + c.match.length;
      }
    }
    return accepted;
  }

  private async _process(all: boolean): Promise<Expansion[]> {
    if (this._processing) {
      this._rescanRequested = true;
      return [];
    }
    this._processing = true;
    const expansions = new Map<string, MacroMatch[]>();
    const record = (name: string, m: MacroMatch) => {
      const list = expansions.get(name) ?? [];
      list.push(m);
      expansions.set(name, list);
    };

    try {
      if (!this.enabled) return [];
      const dirty = all ? null : this._takeDirty();
      if (dirty && dirty.length === 0) return [];

      const document = this.client.getDocument();
      const candidates = this._findCandidates(document, dirty);

      // Reserve every candidate up front so concurrent scans skip them.
      const anchors = candidates.map(c => {
        const anchor = this._track(c.index, c.index + c.match.length, 'match');
        this._inFlight.add(anchor);
        return anchor;
      });

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const anchor = anchors[i];
        if (c.macro.type === 'streaming') {
          const stream = this._runStream(c.macro, c, document, anchor);
          this._activeStreams.add(stream);
          stream.finally(() => this._activeStreams.delete(stream));
          record(c.name, { match: c.match, index: c.index, streaming: true });
          continue;
        }
        try {
          const replacement = await this._evaluate(c, document);
          if (replacement === null || replacement === undefined || replacement === c.match) continue;
          const current = this.client.getDocument();
          if (current.slice(anchor.start, anchor.end) !== c.match) {
            continue; // trigger was edited or removed meanwhile
          }
          const index = anchor.start;
          this.client.replace(index, c.match.length, replacement);
          record(c.name, { match: c.match, index, replacement });
        } catch (err) {
          console.error(`Macro ${c.name} failed:`, err instanceof Error ? err.message : err);
        } finally {
          this._inFlight.delete(anchor);
          this._untrack(anchor);
        }
      }
    } finally {
      this._processing = false;
      if (this._rescanRequested) {
        this._rescanRequested = false;
        if (this._watching) this._schedule();
      }
    }

    return [...expansions.entries()].map(([macro, matches]) => ({ macro, matches }));
  }

  private async _evaluate(c: Candidate, document: string): Promise<MaybeText> {
    const macro = c.macro;
    switch (macro.type) {
      case 'text':
        return macro.replacement(macro.trigger);
      case 'regex':
        return macro.handler(c.match, ...c.groups, c.index, document);
      case 'template':
        return macro.handler(c.groups[0] ?? '');
      case 'block':
        return macro.handler(c.groups[0] ?? '', {
          fullDocument: document,
          beforeMatch: document.slice(0, c.index),
          afterMatch: document.slice(c.index + c.match.length),
          matchIndex: c.index,
          matchText: c.match,
          groups: c.groups,
        });
      default:
        return null;
    }
  }

  // ---- streaming -------------------------------------------------------------

  private async _runStream(macro: StreamingMacro, c: Candidate, document: string, anchor: TrackedRange): Promise<void> {
    let cursor: TrackedRange | null = null;
    let marker: TrackedRange | null = null;
    let proc: (ChildProcess & { exitCode$: Promise<number> }) | null = null;
    try {
      const built = await macro.commandBuilder(c.match, ...c.groups, c.index, document);
      if (!built) return;
      const cmd = toShellCommand(built);

      const current = this.client.getDocument();
      if (current.slice(anchor.start, anchor.end) !== c.match) return;

      // Claim the trigger: mark it as running, or remove it.
      const st = macro.stateTracking;
      if (st) {
        const at = anchor.end;
        this.client.insert(at, st.runningMarker + '\n');
        marker = this._track(at, at + st.runningMarker.length, 'match');
        cursor = this._track(at + st.runningMarker.length + 1, at + st.runningMarker.length + 1, 'point');
      } else {
        const at = anchor.start;
        this.client.delete(at, c.match.length);
        cursor = this._track(at, at, 'point');
      }
      this._inFlight.delete(anchor);
      this._untrack(anchor);

      macro.onStart?.(c.match, cursor.start);

      proc = spawnShell(cmd, { timeoutMs: macro.timeoutMs });
      this._processes.add(proc);
      let stderr = '';
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (d: string) => {
        stderr = (stderr + d).slice(-4096);
      });

      let unsent = '';
      const emit = (text: string) => {
        if (!text) return;
        unsent += text;
        try {
          const at = cursor!.start;
          this.client.insert(at, unsent);
          macro.onData?.(unsent, at);
          unsent = '';
        } catch {
          // Not connected right now: keep the text and retry with the next chunk.
        }
      };

      const decoder = new TextDecoder();
      let lineBuffer = '';
      const handleText = (text: string) => {
        if (!macro.lineBuffered) {
          emit(text);
          return;
        }
        lineBuffer += text;
        const lastNewline = lineBuffer.lastIndexOf('\n');
        if (lastNewline !== -1) {
          emit(lineBuffer.slice(0, lastNewline + 1));
          lineBuffer = lineBuffer.slice(lastNewline + 1);
        }
      };

      for await (const chunk of proc.stdout!) {
        handleText(decoder.decode(chunk as Uint8Array, { stream: true }));
      }
      handleText(decoder.decode());
      emit(lineBuffer);
      const exitCode = await proc.exitCode$;

      if (unsent) {
        console.error(`Streaming macro ${macro.name}: ${unsent.length} characters of output could not be inserted (disconnected)`);
      }
      if (exitCode !== 0 && stderr.trim()) {
        console.error(`Streaming macro ${macro.name} exited with ${exitCode}: ${stderr.trim()}`);
      }

      if (st && marker) {
        const doc = this.client.getDocument();
        if (doc.slice(marker.start, marker.end) === st.runningMarker) {
          this.client.replace(marker.start, st.runningMarker.length, exitCode === 0 ? st.doneMarker : st.failedMarker);
        }
      }

      macro.onEnd?.(exitCode, cursor.start);
    } catch (err) {
      console.error(`Streaming macro ${macro.name} error:`, err instanceof Error ? err.message : err);
      macro.onError?.(err as Error);
    } finally {
      if (proc) this._processes.delete(proc);
      this._inFlight.delete(anchor);
      this._untrack(anchor);
      this._untrack(cursor);
      this._untrack(marker);
    }
  }

  // ===========================================
  // Built-in macro helpers (static)
  // ===========================================

  static builtins = {
    dateMacro(trigger: string, format: 'iso' | 'locale' | 'date' | 'time' | 'isoDate' | (() => string) = 'iso'): BuiltinMacro {
      const formatters: Record<string, () => string> = {
        iso: () => new Date().toISOString(),
        locale: () => new Date().toLocaleString(),
        date: () => new Date().toLocaleDateString(),
        time: () => new Date().toLocaleTimeString(),
        isoDate: () => new Date().toISOString().split('T')[0]
      };
      return {
        trigger,
        replacement: typeof format === 'function' ? format : (formatters[format] || formatters.iso)
      };
    },

    uuidMacro(trigger: string): BuiltinMacro {
      return { trigger, replacement: () => globalThis.crypto.randomUUID() };
    },

    counterMacro(trigger: string, start: number = 1): BuiltinMacro {
      let counter = start;
      return { trigger, replacement: () => String(counter++) };
    },

    snippetMacro(trigger: string, template: string): BuiltinMacro {
      return { trigger, replacement: () => template.replace('$CURSOR', '') };
    }
  };
}

export { MacroEngine };
export type {
  Macro,
  TextMacro,
  RegexMacro,
  TemplateMacro,
  StreamingMacro,
  BlockMacro,
  MacroMatch,
  Expansion,
  MacroInfo,
  TextMacroOptions,
  StreamingExecOptions,
  StreamingCallbacks,
  BlockMacroOptions,
  StateTracking,
  DocumentContext,
  MacroEngineOptions,
  RegexHandler,
  CommandBuilder,
};
