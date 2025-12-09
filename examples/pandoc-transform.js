/**
 * Example: Pandoc Transformations
 * 
 * Demonstrates using Pandoc for AST-based document transformations.
 * Requires pandoc to be installed on the system.
 */

import { HedgeDocClient, PandocTransformer } from '../src/index.js';

const HEDGEDOC_URL = process.env.HEDGEDOC_URL || 'https://md.tionis.dev';
const NOTE_ID = process.env.NOTE_ID || '49vCOEWsR0KR6UowrEV8Kg';

async function main() {
  const client = new HedgeDocClient(HEDGEDOC_URL);
  const pandoc = new PandocTransformer();

  try {
    console.log('Connecting to note...');
    await client.connect(NOTE_ID);
    console.log('Connected!');
    
    const doc = client.getDocument();
    console.log('\n--- Original Document ---');
    console.log(doc.substring(0, 300) + (doc.length > 300 ? '...' : ''));

    // Example 1: Convert all headers to one level deeper
    console.log('\n--- Example 1: Transform Headers ---');
    const headerTransformed = await pandoc.transform(doc, (ast) => {
      pandoc.walkAST(ast, (el) => {
        if (el.t === 'Header') {
          // Increase header level (max 6)
          el.c[0] = Math.min(el.c[0] + 1, 6);
        }
      });
      return ast;
    });
    console.log('Headers demoted by 1 level');
    console.log(headerTransformed.substring(0, 300) + '...');

    // Example 2: Extract all links
    console.log('\n--- Example 2: Extract Links ---');
    const ast = await pandoc.markdownToAST(doc);
    const links = pandoc.filterByType(ast, 'Link');
    console.log(`Found ${links.length} links:`);
    links.forEach((link, i) => {
      // Link structure: [attrs, inline content, [url, title]]
      const url = link.c[2][0];
      console.log(`  ${i + 1}. ${url}`);
    });

    // Example 3: Replace text in specific element types
    console.log('\n--- Example 3: Transform Code Blocks ---');
    const codeTransformed = await pandoc.transform(doc, (ast) => {
      pandoc.walkAST(ast, (el) => {
        if (el.t === 'CodeBlock') {
          // Add a comment to all code blocks
          const [attrs, code] = el.c;
          el.c[1] = `# Auto-processed\n${code}`;
        }
      });
      return ast;
    });
    console.log('Code blocks annotated');

    // Example 4: Convert to different format (if pandoc supports it)
    console.log('\n--- Example 4: Format Conversion ---');
    try {
      const html = await pandoc.convert(doc, 'markdown', 'html');
      console.log('Converted to HTML:');
      console.log(html.substring(0, 300) + (html.length > 300 ? '...' : ''));
    } catch (e) {
      console.log('HTML conversion failed (pandoc may not be available)');
    }

    // Example 5: Apply transformation to live document
    console.log('\n--- Example 5: Apply to Live Document ---');
    console.log('(Skipped to preserve document - example code below)');
    /*
    await pandoc.applyToClient(client, (ast) => {
      // Your transformation here
      return ast;
    });
    */

    // Example 6: Extract all images
    console.log('\n--- Example 6: Extract Images ---');
    const images = pandoc.filterByType(ast, 'Image');
    console.log(`Found ${images.length} images:`);
    images.forEach((img, i) => {
      // Image structure: [attrs, alt content, [url, title]]
      const url = img.c[2][0];
      console.log(`  ${i + 1}. ${url}`);
    });

    // Example 7: Word count using AST
    console.log('\n--- Example 7: Word Count via AST ---');
    let wordCount = 0;
    pandoc.walkAST(ast, (el) => {
      if (el.t === 'Str') {
        wordCount++;
      } else if (el.t === 'Space' || el.t === 'SoftBreak') {
        // These separate words
      }
    });
    console.log(`Approximate word count: ${wordCount}`);

  } catch (error) {
    console.error('Error:', error.message);
    if (error.message.includes('pandoc')) {
      console.log('\nNote: This example requires pandoc to be installed.');
      console.log('Install with: apt install pandoc (Ubuntu) or brew install pandoc (macOS)');
    }
  } finally {
    client.disconnect();
    console.log('\nDisconnected.');
  }
}

main();
