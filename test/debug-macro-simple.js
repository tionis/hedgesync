#!/usr/bin/env bun
/**
 * Simple macro debug - just test the pattern matching logic
 */

import { HedgeDocClient, MacroEngine } from '../src/index.js';

const SERVER_URL = 'https://md.tionis.dev';
const NOTE_ID = '49vCOEWsR0KR6UowrEV8Kg';

async function main() {
  console.log('\n🔍 Simple Macro Pattern Test\n');
  
  const client = new HedgeDocClient({
    serverUrl: SERVER_URL,
    noteId: NOTE_ID
  });
  
  await client.connect();
  console.log('✓ Connected');
  
  const doc = client.getDocument();
  console.log('\n=== Document Content ===');
  console.log(JSON.stringify(doc));
  console.log('\n=== Document Length:', doc.length, '===');
  
  // Count ::date:: occurrences
  const simpleMatches = doc.match(/::date::/g) || [];
  console.log('\nSimple ::date:: matches:', simpleMatches.length);
  
  // Use the word boundary pattern
  const pattern = /(?:^|\s|\n)(::date::)(?:$|\s|\n)/g;
  pattern.lastIndex = 0;
  
  let match;
  let count = 0;
  console.log('\nWord-boundary pattern matches:');
  while ((match = pattern.exec(doc)) !== null) {
    count++;
    console.log(`  ${count}. Match: ${JSON.stringify(match[0])} at index ${match.index}`);
    console.log(`     Capture group: ${JSON.stringify(match[1])}`);
  }
  console.log(`Total: ${count} matches`);
  
  client.disconnect();
}

main().catch(console.error);
