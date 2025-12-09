/**
 * PandocTransformer - Transform documents using Pandoc's AST
 * 
 * Allows complex document transformations by converting to Pandoc's JSON AST,
 * manipulating the AST, and converting back to markdown.
 */

import { spawn } from 'child_process';

// Forward declaration for HedgeDocClient to avoid circular imports
interface HedgeDocClientLike {
  getDocument(): string;
  setContent(content: string): void | Promise<void>;
}

// ===========================================
// Pandoc AST Types
// ===========================================

/** Pandoc AST attribute tuple: [id, classes, key-value pairs] */
export type Attr = [string, string[], [string, string][]];

/** Base AST node structure */
export interface ASTNode {
  t: string;
  c?: unknown;
}

/** Text string node */
export interface StrNode extends ASTNode {
  t: 'Str';
  c: string;
}

/** Space node */
export interface SpaceNode extends ASTNode {
  t: 'Space';
}

/** Soft break node */
export interface SoftBreakNode extends ASTNode {
  t: 'SoftBreak';
}

/** Line break node */
export interface LineBreakNode extends ASTNode {
  t: 'LineBreak';
}

/** Inline element types */
export type Inline = StrNode | SpaceNode | SoftBreakNode | LineBreakNode | ASTNode;

/** Paragraph node */
export interface ParaNode extends ASTNode {
  t: 'Para';
  c: Inline[];
}

/** Header node: [level, attr, inlines] */
export interface HeaderNode extends ASTNode {
  t: 'Header';
  c: [number, Attr, Inline[]];
}

/** Code block node: [attr, code] */
export interface CodeBlockNode extends ASTNode {
  t: 'CodeBlock';
  c: [Attr, string];
}

/** Block element types */
export type Block = ParaNode | HeaderNode | CodeBlockNode | ASTNode;

/** Meta value types */
export interface MetaValue {
  t: string;
  c?: unknown;
}

/** Pandoc document AST */
export interface PandocAST {
  'pandoc-api-version': number[];
  meta: Record<string, MetaValue>;
  blocks: Block[];
}

// ===========================================
// Options Types
// ===========================================

export interface PandocOptions {
  extensions?: string;
  wrap?: 'none' | 'auto' | 'preserve';
  columns?: number;
  standalone?: boolean;
}

export interface TransformerOptions extends PandocOptions {
  markdownExtensions?: string;
}

/** Visitor callback type */
export type ASTVisitor = (node: unknown, parent: unknown | null, key: string | number | null) => void;

/** AST transformation function */
export type ASTTransformFn = (ast: PandocAST) => PandocAST | Promise<PandocAST>;

// ===========================================
// Private Helper Functions
// ===========================================

/**
 * Execute a command and return stdout
 */
function exec(cmd: string, args: string[], stdin: string = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code: number | null) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });
    
    proc.on('error', (err: Error) => {
      reject(new Error(`Failed to spawn command: ${err.message}`));
    });
    
    if (stdin) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });
}

// ===========================================
// Exported Functions
// ===========================================

/**
 * Check if pandoc is available
 */
export async function isPandocAvailable(): Promise<boolean> {
  try {
    await exec('pandoc', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get pandoc version
 */
export async function getPandocVersion(): Promise<string> {
  const output = await exec('pandoc', ['--version']);
  const match = output.match(/pandoc\s+([\d.]+)/);
  return match ? match[1] : 'unknown';
}

/**
 * Convert markdown to Pandoc JSON AST
 */
export async function markdownToAST(markdown: string, options: PandocOptions = {}): Promise<PandocAST> {
  const args = ['-f', 'markdown', '-t', 'json'];
  
  if (options.extensions) {
    args[1] = 'markdown' + options.extensions;
  }
  
  const output = await exec('pandoc', args, markdown);
  return JSON.parse(output) as PandocAST;
}

/**
 * Convert Pandoc JSON AST to markdown
 */
export async function astToMarkdown(ast: PandocAST, options: PandocOptions = {}): Promise<string> {
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
 */
export async function convert(
  content: string, 
  fromFormat: string, 
  toFormat: string, 
  options: PandocOptions = {}
): Promise<string> {
  const args = ['-f', fromFormat, '-t', toFormat];
  
  if (options.wrap) {
    args.push('--wrap=' + options.wrap);
  }
  if (options.standalone) {
    args.push('--standalone');
  }
  
  return await exec('pandoc', args, content);
}

// ===========================================
// PandocTransformer Class
// ===========================================

/**
 * PandocTransformer - High-level class for document transformations
 */
export class PandocTransformer {
  options: PandocOptions;

  /**
   * Create a new transformer
   */
  constructor(options: TransformerOptions = {}) {
    this.options = {
      extensions: options.markdownExtensions || '',
      wrap: options.wrap || 'none',
      ...options
    };
  }

  /**
   * Parse markdown into AST
   */
  async parse(markdown: string): Promise<PandocAST> {
    return markdownToAST(markdown, this.options);
  }

  /**
   * Render AST back to markdown
   */
  async render(ast: PandocAST): Promise<string> {
    return astToMarkdown(ast, this.options);
  }

  /**
   * Transform a document using an AST transformation function
   */
  async transform(markdown: string, transformFn: ASTTransformFn): Promise<string> {
    const ast = await this.parse(markdown);
    const transformedAST = await transformFn(ast);
    return await this.render(transformedAST);
  }

  /**
   * Apply a transformation to a HedgeDoc client's document
   */
  async applyToClient(client: HedgeDocClientLike, transformFn: ASTTransformFn): Promise<void> {
    const original = client.getDocument();
    const transformed = await this.transform(original, transformFn);
    
    if (transformed !== original) {
      await client.setContent(transformed);
    }
  }

  /**
   * Convert markdown to AST (instance method)
   */
  async markdownToAST(markdown: string): Promise<PandocAST> {
    return markdownToAST(markdown, this.options);
  }

  /**
   * Convert AST to markdown (instance method)
   */
  async astToMarkdown(ast: PandocAST): Promise<string> {
    return astToMarkdown(ast, this.options);
  }

  /**
   * Convert between formats (instance method)
   */
  async convert(content: string, fromFormat: string, toFormat: string): Promise<string> {
    return convert(content, fromFormat, toFormat, this.options);
  }

  /**
   * Walk the AST and call a callback on each node (instance method)
   */
  walkAST(ast: PandocAST, callback: ASTVisitor): void {
    PandocTransformer.walk(ast, callback);
  }

  /**
   * Find all nodes of a specific type (instance method)
   */
  filterByType(ast: PandocAST, type: string): ASTNode[] {
    return PandocTransformer.findByType(ast, type);
  }

  /**
   * Replace text in all Str nodes
   */
  replaceText(ast: PandocAST, search: string | RegExp, replace: string): void {
    this.walkAST(ast, (node) => {
      const n = node as ASTNode;
      if (n && n.t === 'Str' && typeof n.c === 'string') {
        if (search instanceof RegExp) {
          n.c = n.c.replace(search, replace);
        } else {
          n.c = n.c.split(search).join(replace);
        }
      }
    });
  }

  // ============================================
  // AST Helper Methods (Static)
  // ============================================

  /**
   * Walk the AST and call a visitor function on each node
   */
  static walk(ast: unknown, visitor: ASTVisitor): void {
    function walkNode(node: unknown, parent: unknown | null = null, key: string | number | null = null): void {
      if (!node || typeof node !== 'object') return;
      
      visitor(node, parent, key);
      
      if (Array.isArray(node)) {
        node.forEach((item, i) => walkNode(item, node, i));
      } else {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          walkNode(v, node, k);
        }
      }
    }
    
    walkNode(ast);
  }

  /**
   * Find all nodes of a specific type
   */
  static findByType(ast: unknown, type: string): ASTNode[] {
    const results: ASTNode[] = [];
    this.walk(ast, (node) => {
      const n = node as ASTNode;
      if (n && n.t === type) {
        results.push(n);
      }
    });
    return results;
  }

  /**
   * Extract plain text from an AST node
   */
  static extractText(node: unknown): string {
    if (!node) return '';
    
    if (typeof node === 'string') return node;
    
    if (Array.isArray(node)) {
      return node.map(n => this.extractText(n)).join('');
    }
    
    const n = node as ASTNode;
    
    if (n.t === 'Str') {
      return n.c as string;
    }
    if (n.t === 'Space') {
      return ' ';
    }
    if (n.t === 'SoftBreak' || n.t === 'LineBreak') {
      return '\n';
    }
    
    if (n.c) {
      return this.extractText(n.c);
    }
    
    return '';
  }

  /**
   * Create a simple text inline element
   */
  static createText(text: string): Inline[] {
    const parts = text.split(/(\s+)/);
    const inlines: Inline[] = [];
    
    for (const part of parts) {
      if (part === ' ') {
        inlines.push({ t: 'Space' } as SpaceNode);
      } else if (part === '\n') {
        inlines.push({ t: 'SoftBreak' } as SoftBreakNode);
      } else if (part.match(/^\s+$/)) {
        // Multiple spaces - just add one space
        inlines.push({ t: 'Space' } as SpaceNode);
      } else if (part) {
        inlines.push({ t: 'Str', c: part } as StrNode);
      }
    }
    
    return inlines;
  }

  /**
   * Create a paragraph node
   */
  static createPara(content: string | Inline[]): ParaNode {
    const inlines = typeof content === 'string' 
      ? this.createText(content) 
      : content;
    return { t: 'Para', c: inlines };
  }

  /**
   * Create a header node
   */
  static createHeader(level: number, content: string | Inline[], id: string = ''): HeaderNode {
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
   */
  static createCodeBlock(code: string, language: string = ''): CodeBlockNode {
    return {
      t: 'CodeBlock',
      c: [['', language ? [language] : [], []], code]
    };
  }
}

export default PandocTransformer;
