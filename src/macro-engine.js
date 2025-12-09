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

      try {
        if (macro.type === 'text') {
          // For text macros with word boundary, we matched including the boundary
          // We need to find the actual trigger position
          const triggerIndex = m.match.indexOf(macro.trigger);
          if (triggerIndex === -1) continue;
          
          replaceIndex = m.index + triggerIndex;
          replaceLength = macro.trigger.length;
          replacement = macro.replacement(macro.trigger);
          
          this.client.replace(replaceIndex, replaceLength, replacement);
          matches.push({ trigger: macro.trigger, replacement, index: replaceIndex });
          changed = true;
        } else if (macro.type === 'regex') {
          replacement = macro.handler(m.match, ...m.groups);
          if (replacement !== m.match && replacement !== null && replacement !== undefined) {
            replaceIndex = m.index;
            replaceLength = m.match.length;
            this.client.replace(replaceIndex, replaceLength, replacement);
            matches.push({ match: m.match, replacement, index: replaceIndex });
            changed = true;
          }
        } else if (macro.type === 'template') {
          const content = m.groups[0];
          replacement = macro.handler(content);
          if (replacement !== null && replacement !== undefined) {
            replaceIndex = m.index;
            replaceLength = m.match.length;
            this.client.replace(replaceIndex, replaceLength, replacement);
            matches.push({ template: m.match, content, replacement, index: replaceIndex });
            changed = true;
          }
        }
        
        // Update our local copy of the document to reflect the change
        // This is necessary because rate limiting may queue the actual operation
        if (changed && replacement !== undefined) {
          updatedDocument = 
            updatedDocument.substring(0, replaceIndex) +
            replacement +
            updatedDocument.substring(replaceIndex + replaceLength);
        }
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
