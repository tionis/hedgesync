#!/usr/bin/env bun
/**
 * Test macro pattern matching logic in isolation (no network)
 */

// Simulated document content
let doc = `# Test Document

Some content here.

Test macro: ::date:: end

More content ::date:: here too.

Done!
`;

console.log('🔍 Pattern Matching Test\n');
console.log('=== Initial Document ===');
console.log(JSON.stringify(doc));
console.log('\n');

// The pattern used by addTextMacro with wordBoundary: true
const pattern = /(?:^|\s|\n)(::date::)(?:$|\s|\n)/g;

function findMatches(document) {
  pattern.lastIndex = 0;
  const matches = [];
  let match;
  while ((match = pattern.exec(document)) !== null) {
    const triggerIndex = match[0].indexOf('::date::');
    matches.push({
      fullMatch: match[0],
      trigger: match[1],
      matchIndex: match.index,
      triggerIndex: match.index + triggerIndex
    });
  }
  return matches;
}

// Find initial matches
console.log('=== Initial Matches ===');
const matches1 = findMatches(doc);
console.log(`Found ${matches1.length} matches:`);
for (const m of matches1) {
  console.log(`  Full: ${JSON.stringify(m.fullMatch)} at ${m.matchIndex}`);
  console.log(`  Trigger index: ${m.triggerIndex}`);
}

// Simulate replacement (like the macro engine does)
function simulateReplacement(document) {
  const matches = findMatches(document);
  if (matches.length === 0) return { changed: false, document };
  
  // Process LAST match (reverse order, but we break after first)
  const m = matches[matches.length - 1];
  const replacement = '2025-12-09';
  
  console.log(`\n  Replacing at index ${m.triggerIndex}: "${document.substring(m.triggerIndex, m.triggerIndex + 8)}" -> "${replacement}"`);
  
  const newDoc = 
    document.substring(0, m.triggerIndex) + 
    replacement + 
    document.substring(m.triggerIndex + 8);
  
  return { changed: true, document: newDoc };
}

// Simulate the _processDocument while loop
console.log('\n=== Simulating _processDocument Loop ===');
let currentDoc = doc;
let iterations = 0;
const maxIterations = 10;
let madeChanges = true;

while (madeChanges && iterations < maxIterations) {
  iterations++;
  console.log(`\nIteration ${iterations}:`);
  console.log(`  Doc length: ${currentDoc.length}`);
  
  const matches = findMatches(currentDoc);
  console.log(`  Matches found: ${matches.length}`);
  
  if (matches.length === 0) {
    madeChanges = false;
    break;
  }
  
  const result = simulateReplacement(currentDoc);
  madeChanges = result.changed;
  currentDoc = result.document;
}

console.log(`\n=== Final Document (after ${iterations} iterations) ===`);
console.log(JSON.stringify(currentDoc));

// Check for remaining matches
const remaining = findMatches(currentDoc);
console.log(`\n=== Remaining Matches: ${remaining.length} ===`);
