#!/usr/bin/env bun
/**
 * Test macro engine with a mock client to verify the loop fix
 */

import { MacroEngine } from '../src/macro-engine.js';
import { EventEmitter } from 'events';

// Mock client that tracks document state
class MockClient extends EventEmitter {
  constructor(initialDoc = '') {
    super();
    this.document = initialDoc;
    this.operationCount = 0;
  }
  
  getDocument() {
    return this.document;
  }
  
  replace(position, length, text) {
    this.operationCount++;
    console.log(`  [MockClient.replace #${this.operationCount}] pos=${position}, len=${length}, text="${text}"`);
    
    // Apply the replacement
    this.document = 
      this.document.substring(0, position) +
      text +
      this.document.substring(position + length);
    
    console.log(`    New doc: "${this.document}"`);
    
    // Emit local change event (like the real client does)
    this.emit('change', { type: 'local' });
  }
  
  // Simulate a remote change
  simulateRemoteChange(content) {
    this.document = content;
    this.emit('change', { type: 'remote' });
  }
}

async function test() {
  console.log('🧪 Mock Macro Engine Test\n');
  
  // Create mock client with initial document
  const client = new MockClient('Hello world!\n\nToday is ::date:: and the weather is nice.\n');
  console.log('Initial document:', JSON.stringify(client.document));
  
  // Create macro engine
  const engine = new MacroEngine(client);
  
  let replacementCalls = 0;
  engine.addTextMacro('::date::', () => {
    replacementCalls++;
    console.log(`  [Replacement function called #${replacementCalls}]`);
    return '2025-12-09';
  });
  
  console.log('\n--- Testing expand() (manual trigger) ---');
  const results = await engine.expand();
  
  console.log('\nResults:', JSON.stringify(results, null, 2));
  console.log(`\nReplacement function called ${replacementCalls} times`);
  console.log(`MockClient.replace called ${client.operationCount} times`);
  console.log('Final document:', JSON.stringify(client.document));
  
  // Verify no ::date:: remains
  const remaining = client.document.includes('::date::');
  console.log('Contains ::date::?', remaining);
  
  console.log('\n--- Testing start() with remote changes ---');
  
  // Reset for next test
  client.document = 'Another test ::date:: here\n';
  client.operationCount = 0;
  replacementCalls = 0;
  
  // Start listening
  engine.start();
  
  // Simulate a remote change that adds ::date::
  console.log('\nSimulating remote change (adding ::date::)...');
  client.document = 'Remote edit added ::date:: too!\n';
  client.emit('change', { type: 'remote' });
  
  // Wait for debounce
  await new Promise(r => setTimeout(r, 200));
  
  console.log('\nAfter remote change processing:');
  console.log(`Replacement function called ${replacementCalls} times`);
  console.log(`MockClient.replace called ${client.operationCount} times`);
  console.log('Final document:', JSON.stringify(client.document));
  console.log('Contains ::date::?', client.document.includes('::date::'));
  
  engine.stop();
  
  // Summary
  console.log('\n=== Summary ===');
  if (replacementCalls === 2 && client.operationCount === 2) {
    console.log('✅ PASS: Replacement called exactly twice (once per ::date::)');
  } else {
    console.log(`❌ FAIL: Expected 2 replacements, got ${replacementCalls} calls, ${client.operationCount} operations`);
  }
}

test().catch(console.error);
