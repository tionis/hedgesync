#!/usr/bin/env bun
/**
 * Test macro expansion in isolation
 */

import { HedgeDocClient, MacroEngine } from '../src/index.js';

const SERVER_URL = 'https://md.tionis.dev';
const NOTE_ID = '49vCOEWsR0KR6UowrEV8Kg';

async function main() {
  console.log('\n🔍 Isolated Macro Test\n');
  
  const client = new HedgeDocClient({
    serverUrl: SERVER_URL,
    noteId: NOTE_ID
  });
  
  await client.connect();
  console.log('✓ Connected');
  
  // First, clean up and add our test content
  console.log('\n1. Adding test content with ::date::');
  client.insert(client.getDocument().length, '\n\nTest macro: ::date:: end\n');
  
  // Give it a moment to sync
  await new Promise(r => setTimeout(r, 500));
  
  console.log('\n2. Current document:');
  const doc1 = client.getDocument();
  console.log(JSON.stringify(doc1));
  
  // Count matches
  const simpleMatches = doc1.match(/::date::/g) || [];
  console.log('\n3. Simple ::date:: matches:', simpleMatches.length);
  
  // Test pattern
  const pattern = /(?:^|\s|\n)(::date::)(?:$|\s|\n)/g;
  pattern.lastIndex = 0;
  let match;
  let count = 0;
  console.log('\n4. Word-boundary pattern matches:');
  while ((match = pattern.exec(doc1)) !== null) {
    count++;
    console.log(`   ${count}. Full match: ${JSON.stringify(match[0])} at index ${match.index}`);
    console.log(`      Trigger (group 1): ${JSON.stringify(match[1])}`);
    console.log(`      triggerIndex in match: ${match[0].indexOf('::date::')}`);
    console.log(`      actualIndex: ${match.index + match[0].indexOf('::date::')}`);
  }
  
  // Now create the macro engine
  console.log('\n5. Creating macro engine');
  const engine = new MacroEngine(client);
  
  let expansionCount = 0;
  engine.addTextMacro('::date::', () => {
    expansionCount++;
    console.log(`   [Replacement called #${expansionCount}]`);
    return new Date().toISOString().split('T')[0];
  });
  
  // Manually trigger expansion (don't use start())
  console.log('\n6. Manually calling expand()');
  const results = await engine.expand();
  console.log('   Results:', JSON.stringify(results, null, 2));
  console.log('   Replacement function called', expansionCount, 'times');
  
  // Check document after
  console.log('\n7. Document after expansion:');
  const doc2 = client.getDocument();
  console.log(JSON.stringify(doc2));
  
  // Check for remaining ::date::
  const remaining = doc2.match(/::date::/g) || [];
  console.log('\n8. Remaining ::date:: matches:', remaining.length);
  
  // Wait for sync
  await new Promise(r => setTimeout(r, 1000));
  
  console.log('\n✓ Done');
  client.disconnect();
}

main().catch(console.error);
