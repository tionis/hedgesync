/**
 * PandocTransformer - Transform documents using Pandoc's AST
 * 
 * Allows complex document transformations by converting to Pandoc's JSON AST,
 * manipulating the AST, and converting back to markdown.
 */

import { spawn } from 'child_process';

/**
 * Execute a command and return stdout
 * @param {string} cmd - Command to run
 * @param {string[]} args - Command arguments
 * @param {string} stdin - Input to send to stdin
 * @returns {Promise<string>} stdout output
 */
function exec(cmd, args, stdin = '') {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn command: ${err.message}`));
    });
    
    if (stdin) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });
}

/**
 * Check if pandoc is available
 * @returns {Promise<boolean>}
 */
export async function isPandocAvailable() {
  try {
    await exec('pandoc', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get pandoc version
 * @returns {Promise<string>}
 */
export async function getPandocVersion() {
  const output = await exec('pandoc', ['--version']);
  const match = output.match(/pandoc\s+([\d.]+)/);
  return match ? match[1] : 'unknown';
}

/**
 * Convert markdown to Pandoc JSON AST
 * @param {string} markdown - Markdown content
 * @param {Object} options - Pandoc options
 * @returns {Promise<Object>} Pandoc AST as JSON object
 */
export async function markdownToAST(markdown, options = {}) {
  const args = ['-f', 'markdown', '-t', 'json'];
  
  if (options.extensions) {
    args[1] = 'markdown' + options.extensions;
  }
  
  const output = await exec('pandoc', args, markdown);
  return JSON.parse(output);
}

/**
 * Convert Pandoc JSON AST to markdown
 * @param {Object} ast - Pandoc AST object
 * @param {Object} options - Pandoc options
 * @returns {Promise<string>} Markdown content
 */
export async function astToMarkdown(ast, options = {}) {
  const args = ['-f', 'json', '-t', 'markdown'];
  
  if (options.extensions) {
    args[3] = 'markdown' + options.extensions;
  }
  if (options.wrap) {
    args.push('--wrap=' + options.wrap);
  } else {
    args.push('--wrap=none');
  }
  if (options.columns) {
    args.push('--columns=' + options.columns);
  }
  
  const output = await exec('pandoc', args, JSON.stringify(ast));
  return output;
}

/**
 * Convert between formats using pandoc
 * @param {string} content - Input content
 * @param {string} fromFormat - Source format
 * @param {string} toFormat - Target format
 * @param {Object} options - Additional pandoc options
 * @returns {Promise<string>} Converted content
 */
export async function convert(content, fromFormat, toFormat, options = {}) {
  const args = ['-f', fromFormat, '-t', toFormat];
  
  if (options.wrap) {
    args.push('--wrap=' + options.wrap);
  }
  if (options.standalone) {
    args.push('--standalone');
  }
  
  return await exec('pandoc', args, content);
}

/**
 * PandocTransformer - High-level class for document transformations
 */
export class PandocTransformer {
  /**
   * Create a new transformer
   * @param {Object} options - Transformer options
   * @param {string} options.markdownExtensions - Pandoc markdown extensions
   * @param {string} options.wrap - Text wrapping mode (none, auto, preserve)
   */
  constructor(options = {}) {
    this.options = {
      extensions: options.markdownExtensions || '',
      wrap: options.wrap || 'none',
      ...options
    };
  }

  /**
   * Parse markdown into AST
   * @param {string} markdown - Markdown content
   * @returns {Promise<Object>} Pandoc AST
   */
  async parse(markdown) {
    return markdownToAST(markdown, this.options);
  }

  /**
   * Render AST back to markdown
   * @param {Object} ast - Pandoc AST
   * @returns {Promise<string>} Markdown content
   */
  async render(ast) {
    return astToMarkdown(ast, this.options);
  }

  /**
   * Transform a document using an AST transformation function
   * @param {string} markdown - Input markdown
   * @param {Function} transformFn - Function that receives and returns AST
   * @returns {Promise<string>} Transformed markdown
   */
  async transform(markdown, transformFn) {
    const ast = await this.parse(markdown);
    const transformedAST = await transformFn(ast);
    return await this.render(transformedAST);
  }

  /**
   * Apply a transformation to a HedgeDoc client's document
   * @param {HedgeDocClient} client - The HedgeDoc client
   * @param {Function} transformFn - AST transformation function
   * @returns {Promise<void>}
   */
  async applyToClient(client, transformFn) {
    const original = client.getDocument();
    const transformed = await this.transform(original, transformFn);
    
    if (transformed !== original) {
      await client.setContent(transformed);
    }
  }

  /**
   * Convert markdown to AST (instance method)
   * @param {string} markdown - Markdown content
   * @returns {Promise<Object>} Pandoc AST
   */
  async markdownToAST(markdown) {
    return markdownToAST(markdown, this.options);
  }

  /**
   * Convert AST to markdown (instance method)
   * @param {Object} ast - Pandoc AST
   * @returns {Promise<string>} Markdown content
   */
  async astToMarkdown(ast) {
    return astToMarkdown(ast, this.options);
  }

  /**
   * Convert between formats (instance method)
   * @param {string} content - Input content
   * @param {string} fromFormat - Source format
   * @param {string} toFormat - Target format
   * @returns {Promise<string>} Converted content
   */
  async convert(content, fromFormat, toFormat) {
    return convert(content, fromFormat, toFormat, this.options);
  }

  /**
   * Walk the AST and call a callback on each node (instance method)
   * @param {Object} ast - Pandoc AST
   * @param {Function} callback - Function(node, parent, key)
   */
  walkAST(ast, callback) {
    PandocTransformer.walk(ast, callback);
  }

  /**
   * Find all nodes of a specific type (instance method)
   * @param {Object} ast - Pandoc AST
   * @param {string} type - Node type (e.g., 'Header', 'Link', 'Image')
   * @returns {Array} Array of matching nodes
   */
  filterByType(ast, type) {
    return PandocTransformer.findByType(ast, type);
  }

  /**
   * Replace text in all Str nodes
   * @param {Object} ast - Pandoc AST
   * @param {string|RegExp} search - Text to find
   * @param {string} replace - Replacement text
   */
  replaceText(ast, search, replace) {
    this.walkAST(ast, (node) => {
      if (node && node.t === 'Str' && typeof node.c === 'string') {
        if (search instanceof RegExp) {
          node.c = node.c.replace(search, replace);
        } else {
          node.c = node.c.split(search).join(replace);
        }
      }
    });
  }

  // ============================================
  // AST Helper Methods
  // ============================================

  /**
   * Walk the AST and call a visitor function on each node
   * @param {Object} ast - Pandoc AST
   * @param {Function} visitor - Function(node, parent, key) called for each node
   */
  static walk(ast, visitor) {
    function walkNode(node, parent = null, key = null) {
      if (!node || typeof node !== 'object') return;
      
      visitor(node, parent, key);
      
      if (Array.isArray(node)) {
        node.forEach((item, i) => walkNode(item, node, i));
      } else {
        for (const [k, v] of Object.entries(node)) {
          walkNode(v, node, k);
        }
      }
    }
    
    walkNode(ast);
  }

  /**
   * Find all nodes of a specific type
   * @param {Object} ast - Pandoc AST
   * @param {string} type - Node type (e.g., 'Header', 'Para', 'CodeBlock')
   * @returns {Array} Array of matching nodes
   */
  static findByType(ast, type) {
    const results = [];
    this.walk(ast, (node) => {
      if (node && node.t === type) {
        results.push(node);
      }
    });
    return results;
  }

  /**
   * Extract plain text from an AST node
   * @param {Object} node - AST node or inline content array
   * @returns {string} Plain text content
   */
  static extractText(node) {
    if (!node) return '';
    
    if (typeof node === 'string') return node;
    
    if (Array.isArray(node)) {
      return node.map(n => this.extractText(n)).join('');
    }
    
    if (node.t === 'Str') {
      return node.c;
    }
    if (node.t === 'Space') {
      return ' ';
    }
    if (node.t === 'SoftBreak' || node.t === 'LineBreak') {
      return '\n';
    }
    
    if (node.c) {
      return this.extractText(node.c);
    }
    
    return '';
  }

  /**
   * Create a simple text inline element
   * @param {string} text - Text content
   * @returns {Array} Array of inline elements
   */
  static createText(text) {
    const parts = text.split(/(\s+)/);
    const inlines = [];
    
    for (const part of parts) {
      if (part === ' ') {
        inlines.push({ t: 'Space' });
      } else if (part === '\n') {
        inlines.push({ t: 'SoftBreak' });
      } else if (part.match(/^\s+$/)) {
        // Multiple spaces - just add one space
        inlines.push({ t: 'Space' });
      } else if (part) {
        inlines.push({ t: 'Str', c: part });
      }
    }
    
    return inlines;
  }

  /**
   * Create a paragraph node
   * @param {string|Array} content - Text or inline elements
   * @returns {Object} Para AST node
   */
  static createPara(content) {
    const inlines = typeof content === 'string' 
      ? this.createText(content) 
      : content;
    return { t: 'Para', c: inlines };
  }

  /**
   * Create a header node
   * @param {number} level - Header level (1-6)
   * @param {string|Array} content - Header text or inline elements
   * @param {string} id - Optional header ID
   * @returns {Object} Header AST node
   */
  static createHeader(level, content, id = '') {
    const inlines = typeof content === 'string' 
      ? this.createText(content) 
      : content;
    return {
      t: 'Header',
      c: [level, [id, [], []], inlines]
    };
  }

  /**
   * Create a code block node
   * @param {string} code - Code content
   * @param {string} language - Optional language identifier
   * @returns {Object} CodeBlock AST node
   */
  static createCodeBlock(code, language = '') {
    return {
      t: 'CodeBlock',
      c: [['', language ? [language] : [], []], code]
    };
  }
}

export default PandocTransformer;
