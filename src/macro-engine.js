/**
 * MacroEngine - Pattern-based auto-replacement system
 * 
 * Listens for document changes and automatically expands macros when
 * patterns are detected.
 */

class MacroEngine {
  /**
   * Create a MacroEngine
   * @param {HedgeDocClient} client - The HedgeDocClient instance to attach to
   */
  constructor(client) {
    this.client = client;
    this.macros = new Map();
    this.enabled = true;
    this._processing = false;
    this._changeHandler = null;
    this._debounceTimer = null;
    this._activeStreams = new Set(); // Track active streaming processes
  }

  /**
   * Register a simple text replacement macro
   * @param {string} trigger - The trigger text (e.g., "::date")
   * @param {string|Function} replacement - Static text or function returning replacement
   * @param {Object} options - Options
   * @param {boolean} options.wordBoundary - Require word boundaries (default: true)
   * @returns {MacroEngine} this for chaining
   */
  addTextMacro(trigger, replacement, options = {}) {
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
   * @param {string} name - Unique name for this macro
   * @param {RegExp} pattern - The pattern to match
   * @param {Function} handler - Function(match, ...groups) returning replacement text
   * @returns {MacroEngine} this for chaining
   */
  addRegexMacro(name, pattern, handler) {
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
   * @param {string} name - Unique name for this macro type
   * @param {string} startDelim - Start delimiter (e.g., "{{" or "${")
   * @param {string} endDelim - End delimiter (e.g., "}}" or "}")
   * @param {Function} handler - Function(content) returning replacement
   * @returns {MacroEngine} this for chaining
   */
  addTemplateMacro(name, startDelim, endDelim, handler) {
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
   * @param {string} name - The macro name or trigger to remove
   * @returns {boolean} true if removed
   */
  removeMacro(name) {
    return this.macros.delete(name);
  }

  /**
   * Register a streaming exec macro that streams command output into the document
   * @param {string} name - Unique name for this macro
   * @param {RegExp} pattern - The pattern to match
   * @param {Function} commandBuilder - Function(match, ...groups) returning shell command string
   * @param {Object} options - Options
   * @param {boolean} options.lineBuffered - Buffer by line instead of character (default: true)
   * @param {Function} options.onStart - Called when command starts (match, position)
   * @param {Function} options.onData - Called on each chunk (chunk, position)
   * @param {Function} options.onEnd - Called when command ends (exitCode, finalPosition)
   * @param {Function} options.onError - Called on error (error)
   * @returns {MacroEngine} this for chaining
   */
  addStreamingExecMacro(name, pattern, commandBuilder, options = {}) {
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
  start() {
    if (this._changeHandler) {
      return; // Already started
    }

    this._changeHandler = async (event) => {
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

    this.client.on('change', this._changeHandler);
  }

  /**
   * Stop listening for document changes
   */
  stop() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._changeHandler) {
      this.client.off('change', this._changeHandler);
      this._changeHandler = null;
    }
    this._processingExpansion = false;
  }

  /**
   * Enable or disable macro processing
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this.enabled = enabled;
  }

  /**
   * Process the document for all registered macros
   * @returns {Promise<Array>} Array of expansions performed
   */
  async _processDocument() {
    if (this._processing) {
      return [];
    }

    this._processing = true;
    const expansions = [];

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
   * @private
   */
  async _applyMacro(document, macro) {
    const matches = [];
    let changed = false;
    let updatedDocument = document;

    // Reset regex lastIndex
    macro.pattern.lastIndex = 0;

    // Find all matches first
    let match;
    const allMatches = [];
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
      let replacement;
      let replaceIndex;
      let replaceLength;
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
            console.error(`Macro ${macro.name || macro.trigger}: match "${originalMatch}" no longer found, skipping`);
            continue;
          }
          replaceIndex = newIndex;
        }
        
        // Verify the position is valid
        if (replaceIndex < 0 || replaceIndex + replaceLength > currentDocument.length) {
          console.error(`Macro ${macro.name || macro.trigger}: position out of bounds, skipping`);
          continue;
        }
        
        this.client.replace(replaceIndex, replaceLength, replacement);
        
        if (macro.type === 'text') {
          matches.push({ trigger: macro.trigger, replacement, index: replaceIndex });
        } else if (macro.type === 'regex') {
          matches.push({ match: m.match, replacement, index: replaceIndex });
        } else if (macro.type === 'template') {
          matches.push({ template: m.match, content: m.groups[0], replacement, index: replaceIndex });
        }
        changed = true;
        
        // Update our local copy of the document to reflect the change
        updatedDocument = 
          currentDocument.substring(0, replaceIndex) +
          replacement +
          currentDocument.substring(replaceIndex + replaceLength);
          
      } catch (err) {
        console.error(`Macro ${macro.name || macro.trigger} error:`, err);
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
   * @private
   */
  async _processStreamingMacros() {
    const document = this.client.getDocument();
    const streamingMacros = [];
    
    // Find all streaming macros
    for (const [name, macro] of this.macros) {
      if (macro.type === 'streaming') {
        streamingMacros.push({ name, macro });
      }
    }
    
    if (streamingMacros.length === 0) return [];
    
    const started = [];
    
    // Find matches for streaming macros
    for (const { name, macro } of streamingMacros) {
      macro.pattern.lastIndex = 0;
      let match;
      
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
   * @returns {Promise<void>}
   */
  async waitForStreams() {
    if (this._activeStreams.size === 0) {
      return;
    }
    await Promise.all([...this._activeStreams]);
  }

  /**
   * Check if there are active streaming macros
   * @returns {boolean}
   */
  hasActiveStreams() {
    return this._activeStreams.size > 0;
  }

  /**
   * Start a streaming exec macro - removes match and streams command output
   * @private
   */
  async _startStreamingExec(name, macro, matchText, groups, originalIndex) {
    // Import TextOperation for position transformation
    const { TextOperation } = await import('./text-operation.js');
    
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
      
      // Delete the matched text first
      this.client.delete(insertPos, matchText.length);
      
      // Small delay to let the delete operation settle
      await new Promise(r => setTimeout(r, 50));
      
      // Track our cursor position - starts where we deleted the match
      // This position will be updated when remote operations come in
      let cursorPos = insertPos;
      let aborted = false;
      let isInserting = false; // Flag to avoid double-counting our own inserts
      
      // Listen for remote changes to adjust our cursor position
      const remoteChangeHandler = (event) => {
        // Only handle remote operations, and skip if we're currently inserting
        // (our own operations will update cursorPos directly)
        if (event.type === 'remote' && event.operation && !isInserting) {
          // Transform our cursor position through the remote operation
          const oldPos = cursorPos;
          cursorPos = TextOperation.transformPosition(cursorPos, event.operation, true);
        }
      };
      this.client.on('change', remoteChangeHandler);
      
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
      
      // Helper to safely insert text at tracked cursor position
      const safeInsert = async (text) => {
        if (aborted) return false;
        
        // Get current document state
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
          console.error(`Streaming macro ${name}: insert failed:`, err.message);
          return false;
        }
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
        this.client.off('change', remoteChangeHandler);
      }
      
    } catch (err) {
      console.error(`Streaming macro ${name} error:`, err);
      if (macro.onError) {
        macro.onError(err);
      }
    } finally {
      // Always restore rate limiting
      this.client.setRateLimitEnabled(wasRateLimitEnabled);
    }
  }

  /**
   * Manually trigger macro expansion on current document
   * @returns {Promise<Array>} Array of expansions performed
   */
  async expand() {
    return this._processDocument();
  }

  /**
   * List all registered macros
   * @returns {Array} Array of macro info objects
   */
  listMacros() {
    const result = [];
    for (const [name, macro] of this.macros) {
      result.push({
        name: name,
        type: macro.type,
        trigger: macro.trigger,
        pattern: macro.pattern.toString()
      });
    }
    return result;
  }
}

// Built-in macro helpers
MacroEngine.builtins = {
  /**
   * Create a date/time macro
   * @param {string} trigger - Trigger text (e.g., "::date")
   * @param {string} format - Date format ('iso', 'locale', 'date', 'time', or custom function)
   */
  dateMacro(trigger, format = 'iso') {
    const formatters = {
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
   * @param {string} trigger - Trigger text (e.g., "::uuid")
   */
  uuidMacro(trigger) {
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
   * @param {string} trigger - Trigger text (e.g., "::n")
   * @param {number} start - Starting number
   */
  counterMacro(trigger, start = 1) {
    let counter = start;
    return {
      trigger,
      replacement: () => String(counter++)
    };
  },

  /**
   * Create a snippet/template expansion macro
   * @param {string} trigger - Trigger text
   * @param {string} template - Template with $CURSOR placeholder
   */
  snippetMacro(trigger, template) {
    return {
      trigger,
      replacement: () => template.replace('$CURSOR', '')
    };
  }
};

export { MacroEngine };
