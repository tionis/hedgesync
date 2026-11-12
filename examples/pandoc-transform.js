/**
 * Pandoc AST transformations (requires pandoc on PATH).
 *
 * Usage:
 *   bun examples/pandoc-transform.js <note-url> [--write]
 *
 * Without --write the note is only read; with it, headings are demoted in place.
 */

import { HedgeDocClient, PandocTransformer, isPandocAvailable, parseNoteUrl } from '../src/index.js';

const url = process.argv[2];
if (!url) {
  console.error('Usage: bun examples/pandoc-transform.js <note-url> [--write]');
  process.exit(1);
}
if (!(await isPandocAvailable())) {
  console.error('pandoc is not installed (see https://pandoc.org/installing.html)');
  process.exit(1);
}

const client = new HedgeDocClient({ ...parseNoteUrl(url), cookie: process.env.HEDGEDOC_COOKIE });
const pandoc = new PandocTransformer();

try {
  await client.connect();
  const doc = client.getDocument();
  const ast = await pandoc.markdownToAST(doc);

  // Links and images: [attrs, inlines, [url, title]]
  const links = pandoc.filterByType(ast, 'Link').map(l => l.c[2][0]);
  const images = pandoc.filterByType(ast, 'Image').map(i => i.c[2][0]);
  console.log(`${links.length} links, ${images.length} images`);

  let words = 0;
  pandoc.walkAST(ast, (el) => { if (el.t === 'Str') words++; });
  console.log(`About ${words} words`);

  const html = await pandoc.convert(doc, 'markdown', 'html');
  console.log(`HTML: ${html.length} characters`);

  if (process.argv.includes('--write')) {
    // Applies the result as a minimal diff, retrying if the note changes meanwhile.
    await pandoc.applyToClient(client, (tree) => {
      pandoc.walkAST(tree, (el) => {
        if (el.t === 'Header') el.c[0] = Math.min(el.c[0] + 1, 6);
      });
      return tree;
    });
    await client.flush();
    console.log('Headings demoted');
  }
} catch (error) {
  console.error('Error:', error.message);
  process.exitCode = 1;
} finally {
  client.disconnect();
}
