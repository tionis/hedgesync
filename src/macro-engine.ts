/**
 * MacroEngine - Pattern-based auto-replacement system
 * 
 * Listens for document changes and automatically expands macros when
 * patterns are detected.
 */

import { TextOperation } from './text-operation.js';

// Forward declaration for HedgeDocClient to avoid circular imports
interface HedgeDocClientLike {
  getDocument(): string;
  replace(index: number, length: number, text: string): void;
  delete(index: number, length: number): void;
  insert(index: number, text: string): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  isRateLimitEnabled(): boolean;
  setRateLimitEnabled(enabled: boolean): void;
}

// ===========================================
// Types
// ===========================================

/** Change event from HedgeDoc client */
interface ChangeEvent {
  type: 'local' | 'remote';
  operation?: TextOperation;
}

/** Base macro definition */
interface BaseMacro {
  type: string;
  pattern: RegExp;
}

/** Text macro definition */
interface TextMacro extends BaseMacro {
  type: 'text';
  trigger: string;
  replacement: (trigger: string) => string | Promise<string>;
  wordBoundary: boolean;
}

/** Regex macro definition */
interface RegexMacro extends BaseMacro {
  type: 'regex';
  name: string;
  handler: (match: string, ...groups: string[]) => string | null | undefined | Promise<string | null | undefined>;
}

/** Template macro definition */
interface TemplateMacro extends BaseMacro {
  type: 'template';
  name: string;
  startDelim: string;
  endDelim: string;
  handler: (content: string) => string | null | undefined | Promise<string | null | undefined>;
}

/** Streaming exec macro callbacks */
interface StreamingCallbacks {
  onStart?: (match: string, position: number) => void;
  onData?: (chunk: string, position: number) => void;
  onEnd?: (exitCode: number, finalPosition: number) => void;
  onError?: (error: Error) => void;
}

/** Streaming exec macro definition */
interface StreamingMacro extends BaseMacro, StreamingCallbacks {
  type: 'streaming';
  name: string;
  commandBuilder: (match: string, ...groups: string[]) => string | Promise<string>;
  lineBuffered: boolean;
}

/** Union of all macro types */
type Macro = TextMacro | RegexMacro | TemplateMacro | StreamingMacro;

/** Match info from pattern matching */
interface MatchInfo {
  match: string;
  groups: string[];
  index: number;
}

/** Text macro match result */
interface TextMacroMatch {
  trigger: string;
  replacement: string;
  index: number;
}

/** Regex macro match result */
interface RegexMacroMatch {
  match: string;
  replacement: string;
  index: number;
}

/** Template macro match result */
interface TemplateMacroMatch {
  template: string;
  content: string;
  replacement: string;
  index: number;
}

/** Streaming macro match result */
interface StreamingMacroMatch {
  match: string;
  index: number;
  streaming: boolean;
}

/** Match result union */
type MacroMatch = TextMacroMatch | RegexMacroMatch | TemplateMacroMatch | StreamingMacroMatch;

/** Result from applying a macro */
interface MacroApplyResult {
  changed: boolean;
  matches: MacroMatch[];
  document: string;
}

/** Expansion record */
interface Expansion {
  macro: string;
  matches: MacroMatch[];
}

/** Streaming started record */
interface StreamingStarted {
  name: string;
  match: string;
  index: number;
}

/** Text macro options */
interface TextMacroOptions {
  wordBoundary?: boolean;
}

/** Streaming exec macro options */
interface StreamingExecOptions extends StreamingCallbacks {
  lineBuffered?: boolean;
}

/** Built-in date macro result */
interface DateMacroResult {
  trigger: string;
  replacement: () => string;
}

/** Built-in UUID macro result */
interface UuidMacroResult {
  trigger: string;
  replacement: () => string;
}

/** Built-in counter macro result */
interface CounterMacroResult {
  trigger: string;
  replacement: () => string;
}

/** Built-in snippet macro result */
interface SnippetMacroResult {
  trigger: string;
  replacement: () => string;
}

/** Macro info for listing */
interface MacroInfo {
  name: string;
  type: string;
  trigger?: string;
  pattern: string;
}

// ===========================================
// MacroEngine Class
// ===========================================

class MacroEngine {
  client: HedgeDocClientLike;
  macros: Map<string, Macro>;
  enabled: boolean;
  private _processing: boolean;
  private _changeHandler: ((event: ChangeEvent) => Promise<void>) | null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null;
  private _activeStreams: Set<Promise<void>>;

  /**
   * Create a MacroEngine
   */
  constructor(client: HedgeDocClientLike) {
    this.client = client;
    this.macros = new Map();
    this.enabled = true;
    this._processing = false;
    this._changeHandler = null;
    this._debounceTimer = null;
    this._activeStreams = new Set();
  }

  /**
   * Register a simple text replacement macro
   */
  addTextMacro(
    trigger: string, 
    replacement: string | ((trigger: string) => string | Promise<string>), 
    options: TextMacroOptions = {}
  ): MacroEngine {
    const { wordBoundary = true } = options;
    const escapedTrigger = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = wordBoundary 
      ? new RegExp(`(?:^|\\s|\\n)(${escapedTrigger})(?:$|\\s|\\n)`, 'g')
      : new RegExp(`(${escapedTrigger})`, 'g');
    
    this.macros.set(trigger, {
      type: 'text',
      trigger,
      pattern,
      replacement: typeof replacement === 'function' ? replacement : () => replacement,
      wordBoundary
    });
    
    return this;
  }

  /**
   * Register a regex-based macro
   */
  addRegexMacro(
    name: string, 
    pattern: RegExp, 
    handler: (match: string, ...groups: string[]) => string | null | undefined | Promise<string | null | undefined>
  ): MacroEngine {
    // Ensure the pattern has the global flag
    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
    const globalPattern = new RegExp(pattern.source, flags);
    
    this.macros.set(name, {
      type: 'regex',
      name,
      pattern: globalPattern,
      handler
    });
    
    return this;
  }

  /**
   * Register a template macro (e.g., {{templateName}} or ${expression})
   */
  addTemplateMacro(
    name: string, 
    startDelim: string, 
    endDelim: string, 
    handler: (content: string) => string | null | undefined | Promise<string | null | undefined>
  ): MacroEngine {
    const escapedStart = startDelim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedEnd = endDelim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escapedStart}([^${escapedEnd[0]}]+)${escapedEnd}`, 'g');
    
    this.macros.set(name, {
      type: 'template',
      name,
      pattern,
      startDelim,
      endDelim,
      handler
    });
    
    return this;
  }

  /**
   * Remove a macro by name/trigger
   */
  removeMacro(name: string): boolean {
    return this.macros.delete(name);
  }

  /**
   * Register a streaming exec macro that streams command output into the document
   */
  addStreamingExecMacro(
    name: string, 
    pattern: RegExp, 
    commandBuilder: (match: string, ...groups: string[]) => string | Promise<string>, 
    options: StreamingExecOptions = {}
  ): MacroEngine {
    const { lineBuffered = true, onStart, onData, onEnd, onError } = options;
    
    // Ensure the pattern has the global flag
    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
    const globalPattern = new RegExp(pattern.source, flags);
    
    this.macros.set(name, {
      type: 'streaming',
      name,
      pattern: globalPattern,
      commandBuilder,
      lineBuffered,
      onStart,
      onData,
      onEnd,
      onError
    });
    
    return this;
  }

  /**
   * Start listening for document changes
   */
  start(): void {
    if (this._changeHandler) {
      return; // Already started
    }

    this._changeHandler = async (event: ChangeEvent) => {
      if (!this.enabled || this._processing) {
        return;
      }
      
      // Only process on REMOTE changes to avoid infinite loops
      // (our own replacements are local changes)
      if (event.type === 'remote') {
        // Debounce to avoid rapid processing
        if (this._debounceTimer) {
          clearTimeout(this._debounceTimer);
        }
        this._debounceTimer = setTimeout(async () => {
          this._debounceTimer = null;
          await this._processDocument();
        }, 100);
      }
    };

    this.client.on('change', this._changeHandler as (...args: unknown[]) => void);
  }

  /**
   * Stop listening for document changes
   */
  stop(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._changeHandler) {
      this.client.off('change', this._changeHandler as (...args: unknown[]) => void);
      this._changeHandler = null;
    }
  }

  /**
   * Enable or disable macro processing
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Process the document for all registered macros
   */
  private async _processDocument(): Promise<Expansion[]> {
    if (this._processing) {
      return [];
    }

    this._processing = true;
    const expansions: Expansion[] = [];

    try {
      let document = this.client.getDocument();
      let madeChanges = true;
      let iterations = 0;
      const maxIterations = 10; // Prevent infinite loops

      while (madeChanges && iterations < maxIterations) {
        madeChanges = false;
        iterations++;

        for (const [name, macro] of this.macros) {
          // Skip streaming macros in the sync loop - they're handled separately
          if (macro.type === 'streaming') {
            continue;
          }
          
          const result = await this._applyMacro(document, macro);
          if (result.changed) {
            document = result.document;
            expansions.push({
              macro: name,
              matches: result.matches
            });
            madeChanges = true;
            break; // Start over after each change to get fresh document
          }
        }
      }
      
      // Process streaming macros asynchronously (fire and forget)
      const streamingStarted = await this._processStreamingMacros();
      for (const s of streamingStarted) {
        expansions.push({
          macro: s.name,
          matches: [{ match: s.match, index: s.index, streaming: true }]
        });
      }
    } finally {
      this._processing = false;
    }

    return expansions;
  }

  /**
   * Apply a single macro to the document
   */
  private async _applyMacro(document: string, macro: TextMacro | RegexMacro | TemplateMacro): Promise<MacroApplyResult> {
    const matches: MacroMatch[] = [];
    let changed = false;
    let updatedDocument = document;

    // Reset regex lastIndex
    macro.pattern.lastIndex = 0;

    // Find all matches first
    let match: RegExpExecArray | null;
    const allMatches: MatchInfo[] = [];
    while ((match = macro.pattern.exec(document)) !== null) {
      allMatches.push({
        match: match[0],
        groups: match.slice(1),
        index: match.index
      });
      // Prevent infinite loop on zero-length matches
      if (match.index === macro.pattern.lastIndex) {
        macro.pattern.lastIndex++;
      }
    }

    // Process matches in reverse order to maintain indices
    for (let i = allMatches.length - 1; i >= 0; i--) {
      const m = allMatches[i];
      let replacement: string | null | undefined;
      let replaceIndex: number;
      let replaceLength: number;
      let originalMatch = m.match;

      try {
        if (macro.type === 'text') {
          // For text macros with word boundary, we matched including the boundary
          // We need to find the actual trigger position
          const triggerIndex = m.match.indexOf(macro.trigger);
          if (triggerIndex === -1) continue;
          
          replaceIndex = m.index + triggerIndex;
          replaceLength = macro.trigger.length;
          replacement = await Promise.resolve(macro.replacement(macro.trigger));
          originalMatch = macro.trigger;
          
        } else if (macro.type === 'regex') {
          replacement = await Promise.resolve(macro.handler(m.match, ...m.groups));
          if (replacement === m.match || replacement === null || replacement === undefined) {
            continue; // No change needed
          }
          replaceIndex = m.index;
          replaceLength = m.match.length;
          
        } else if (macro.type === 'template') {
          const content = m.groups[0];
          replacement = await Promise.resolve(macro.handler(content));
          if (replacement === null || replacement === undefined) {
            continue; // No change needed
          }
          replaceIndex = m.index;
          replaceLength = m.match.length;
        } else {
          continue;
        }

        // Re-fetch current document state after async operation
        // The document may have changed during the async handler
        const currentDocument = this.client.getDocument();
        
        // Re-locate the match in the current document
        // The position may have shifted due to other edits
        const currentTextAtPos = currentDocument.substring(replaceIndex, replaceIndex + replaceLength);
        
        if (currentTextAtPos !== originalMatch) {
          // Match has moved or been modified, try to find it again
          const newIndex = currentDocument.indexOf(originalMatch);
          if (newIndex === -1) {
            // Match no longer exists, skip it
            console.error(`Macro ${(macro as TextMacro).trigger || (macro as RegexMacro | TemplateMacro).name}: match "${originalMatch}" no longer found, skipping`);
            continue;
          }
          replaceIndex = newIndex;
        }
        
        // Verify the position is valid
        if (replaceIndex < 0 || replaceIndex + replaceLength > currentDocument.length) {
          console.error(`Macro ${(macro as TextMacro).trigger || (macro as RegexMacro | TemplateMacro).name}: position out of bounds, skipping`);
          continue;
        }
        
        this.client.replace(replaceIndex, replaceLength, replacement!);
        
        if (macro.type === 'text') {
          matches.push({ trigger: macro.trigger, replacement: replacement!, index: replaceIndex } as TextMacroMatch);
        } else if (macro.type === 'regex') {
          matches.push({ match: m.match, replacement: replacement!, index: replaceIndex } as RegexMacroMatch);
        } else if (macro.type === 'template') {
          matches.push({ template: m.match, content: m.groups[0], replacement: replacement!, index: replaceIndex } as TemplateMacroMatch);
        }
        changed = true;
        
        // Update our local copy of the document to reflect the change
        updatedDocument = 
          currentDocument.substring(0, replaceIndex) +
          replacement +
          currentDocument.substring(replaceIndex + replaceLength);
          
      } catch (err) {
        console.error(`Macro ${(macro as TextMacro).trigger || (macro as RegexMacro | TemplateMacro).name} error:`, err);
      }

      // Only process one match at a time to keep indices valid
      if (changed) break;
    }

    return {
      changed,
      matches,
      document: updatedDocument
    };
  }

  /**
   * Process streaming macros - these run asynchronously and stream output into the document
   */
  private async _processStreamingMacros(): Promise<StreamingStarted[]> {
    const document = this.client.getDocument();
    const streamingMacros: Array<{ name: string; macro: StreamingMacro }> = [];
    
    // Find all streaming macros
    for (const [name, macro] of this.macros) {
      if (macro.type === 'streaming') {
        streamingMacros.push({ name, macro });
      }
    }
    
    if (streamingMacros.length === 0) return [];
    
    const started: StreamingStarted[] = [];
    
    // Find matches for streaming macros
    for (const { name, macro } of streamingMacros) {
      macro.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      
      while ((match = macro.pattern.exec(document)) !== null) {
        const matchText = match[0];
        const groups = match.slice(1);
        const index = match.index;
        
        // Start streaming this match asynchronously
        // Track the promise so we can wait for completion
        const streamPromise = this._startStreamingExec(name, macro, matchText, groups, index);
        this._activeStreams.add(streamPromise);
        streamPromise.finally(() => this._activeStreams.delete(streamPromise));
        
        started.push({ name, match: matchText, index });
        
        // Prevent infinite loop on zero-length matches
        if (match.index === macro.pattern.lastIndex) {
          macro.pattern.lastIndex++;
        }
      }
    }
    
    return started;
  }

  /**
   * Wait for all active streaming macros to complete
   */
  async waitForStreams(): Promise<void> {
    if (this._activeStreams.size === 0) {
      return;
    }
    await Promise.all([...this._activeStreams]);
  }

  /**
   * Check if there are active streaming macros
   */
  hasActiveStreams(): boolean {
    return this._activeStreams.size > 0;
  }

  /**
   * Start a streaming exec macro - removes match and streams command output
   */
  private async _startStreamingExec(
    name: string, 
    macro: StreamingMacro, 
    matchText: string, 
    groups: string[], 
    originalIndex: number
  ): Promise<void> {
    // Track rate limiting state to restore later
    const wasRateLimitEnabled = this.client.isRateLimitEnabled();
    
    try {
      // Build the command
      const cmd = await Promise.resolve(macro.commandBuilder(matchText, ...groups));
      
      if (!cmd) {
        return; // Command builder returned nothing
      }
      
      // Re-fetch document and find current position of the match
      let currentDoc = this.client.getDocument();
      let insertPos = originalIndex;
      
      // Verify match still exists at expected position
      const textAtPos = currentDoc.substring(insertPos, insertPos + matchText.length);
      if (textAtPos !== matchText) {
        // Try to find it elsewhere
        const newIndex = currentDoc.indexOf(matchText);
        if (newIndex === -1) {
          console.error(`Streaming macro ${name}: match "${matchText}" no longer found`);
          return;
        }
        insertPos = newIndex;
      }
      
      // Disable rate limiting during streaming to avoid queue issues
      // We control the pace ourselves with delays between inserts
      this.client.setRateLimitEnabled(false);
      
      // Delete the matched text first with retry
      let deleteSuccess = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Re-verify position before delete in case document changed
          currentDoc = this.client.getDocument();
          const verifyText = currentDoc.substring(insertPos, insertPos + matchText.length);
          if (verifyText !== matchText) {
            const newIndex = currentDoc.indexOf(matchText);
            if (newIndex === -1) {
              console.error(`Streaming macro ${name}: match "${matchText}" no longer found`);
              return;
            }
            insertPos = newIndex;
          }
          
          this.client.delete(insertPos, matchText.length);
          deleteSuccess = true;
          break;
        } catch (err) {
          if (attempt < 2) {
            console.error(`Streaming macro ${name}: delete failed (attempt ${attempt + 1}/3):`, (err as Error).message);
            await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
          } else {
            console.error(`Streaming macro ${name}: delete failed after 3 attempts:`, (err as Error).message);
            return;
          }
        }
      }
      
      if (!deleteSuccess) return;
      
      // Small delay to let the delete operation settle
      await new Promise(r => setTimeout(r, 50));
      
      // Track our cursor position - starts where we deleted the match
      // This position will be updated when remote operations come in
      let cursorPos = insertPos;
      let aborted = false;
      let isInserting = false; // Flag to avoid double-counting our own inserts
      
      // Listen for remote changes to adjust our cursor position
      const remoteChangeHandler = (event: ChangeEvent) => {
        // Only handle remote operations, and skip if we're currently inserting
        // (our own operations will update cursorPos directly)
        if (event.type === 'remote' && event.operation && !isInserting) {
          // Transform our cursor position through the remote operation
          cursorPos = TextOperation.transformPosition(cursorPos, event.operation, true);
        }
      };
      this.client.on('change', remoteChangeHandler as (...args: unknown[]) => void);
      
      // Callback: onStart
      if (macro.onStart) {
        macro.onStart(matchText, insertPos);
      }
      
      // Start the process
      const proc = Bun.spawn(['sh', '-c', cmd], {
        stdout: 'pipe',
        stderr: 'pipe'
      });
      
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let lineBuffer = '';
      
      // Helper to safely insert text at tracked cursor position with retry
      const safeInsert = async (text: string, maxRetries = 3): Promise<boolean> => {
        if (aborted) return false;
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          // Get current document state fresh for each attempt
          const doc = this.client.getDocument();
          
          // Bounds check - clamp to valid range
          const insertAt = Math.max(0, Math.min(cursorPos, doc.length));
          
          if (insertAt !== cursorPos) {
            // Position was out of bounds, adjust it
            cursorPos = insertAt;
          }
          
          try {
            isInserting = true;
            this.client.insert(insertAt, text);
            // Move our cursor forward by the inserted length
            cursorPos += text.length;
            isInserting = false;
            
            // Small delay to let OT process the operation
            await new Promise(r => setTimeout(r, 30));
            return true;
          } catch (err) {
            isInserting = false;
            
            if (attempt < maxRetries - 1) {
              // Wait a bit and let OT settle before retrying
              console.error(`Streaming macro ${name}: insert failed (attempt ${attempt + 1}/${maxRetries}):`, (err as Error).message);
              await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
              // Re-sync cursor position from document length in case of desync
              cursorPos = Math.min(cursorPos, this.client.getDocument().length);
            } else {
              console.error(`Streaming macro ${name}: insert failed after ${maxRetries} attempts:`, (err as Error).message);
              return false;
            }
          }
        }
        return false;
      };
      
      try {
        // Stream output into document
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value, { stream: true });
          
          if (macro.lineBuffered) {
            // Buffer by line
            lineBuffer += chunk;
            const lines = lineBuffer.split('\n');
            
            // Process all complete lines
            for (let i = 0; i < lines.length - 1; i++) {
              const line = lines[i] + '\n';
              
              const insertedAt = cursorPos;
              if (!await safeInsert(line)) {
                // Insert failed, abort streaming
                aborted = true;
                proc.kill();
                break;
              }
              
              if (macro.onData) {
                macro.onData(line, insertedAt);
              }
            }
            
            if (aborted) break;
            
            // Keep incomplete line in buffer
            lineBuffer = lines[lines.length - 1];
          } else {
            // Character-by-character (or chunk-by-chunk)
            const insertedAt = cursorPos;
            if (!await safeInsert(chunk)) {
              aborted = true;
              proc.kill();
              break;
            }
            
            if (macro.onData) {
              macro.onData(chunk, insertedAt);
            }
          }
        }
        
        // Flush remaining buffer (line without trailing newline)
        if (!aborted && macro.lineBuffered && lineBuffer) {
          const insertedAt = cursorPos;
          await safeInsert(lineBuffer);
          if (macro.onData) {
            macro.onData(lineBuffer, insertedAt);
          }
        }
        
        const exitCode = await proc.exited;
        
        // Callback: onEnd
        if (macro.onEnd) {
          macro.onEnd(exitCode, cursorPos);
        }
      } finally {
        // Always remove the change handler
        this.client.off('change', remoteChangeHandler as (...args: unknown[]) => void);
      }
      
    } catch (err) {
      console.error(`Streaming macro ${name} error:`, err);
      if (macro.onError) {
        macro.onError(err as Error);
      }
    } finally {
      // Always restore rate limiting
      this.client.setRateLimitEnabled(wasRateLimitEnabled);
    }
  }

  /**
   * Manually trigger macro expansion on current document
   */
  async expand(): Promise<Expansion[]> {
    return this._processDocument();
  }

  /**
   * List all registered macros
   */
  listMacros(): MacroInfo[] {
    const result: MacroInfo[] = [];
    for (const [name, macro] of this.macros) {
      result.push({
        name: name,
        type: macro.type,
        trigger: (macro as TextMacro).trigger,
        pattern: macro.pattern.toString()
      });
    }
    return result;
  }

  // ===========================================
  // Built-in macro helpers (static)
  // ===========================================
  
  static builtins = {
    /**
     * Create a date/time macro
     */
    dateMacro(trigger: string, format: 'iso' | 'locale' | 'date' | 'time' | 'isoDate' | (() => string) = 'iso'): DateMacroResult {
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

    /**
     * Create a UUID macro
     */
    uuidMacro(trigger: string): UuidMacroResult {
      return {
        trigger,
        replacement: () => {
          // Simple UUID v4 generator
          return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
          });
        }
      };
    },

    /**
     * Create a counter macro
     */
    counterMacro(trigger: string, start: number = 1): CounterMacroResult {
      let counter = start;
      return {
        trigger,
        replacement: () => String(counter++)
      };
    },

    /**
     * Create a snippet/template expansion macro
     */
    snippetMacro(trigger: string, template: string): SnippetMacroResult {
      return {
        trigger,
        replacement: () => template.replace('$CURSOR', '')
      };
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
  MacroMatch,
  Expansion,
  MacroInfo,
  TextMacroOptions,
  StreamingExecOptions,
  StreamingCallbacks
};
