#!/usr/bin/env bun
/**
 * Debug script for macro engine
 */

import { HedgeDocClient, MacroEngine } from '../src/index.js';

const SERVER_URL = 'https://md.tionis.dev';
const NOTE_ID = '49vCOEWsR0KR6UowrEV8Kg';

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log(c.cyan('\n🔍 Macro Engine Debug Test\n'));
  
  const client = new HedgeDocClient({
    serverUrl: SERVER_URL,
    noteId: NOTE_ID
  });
  
  await client.connect();
  console.log(c.green('✓ Connected\n'));
  
  // Log ALL events to understand what's happening
  client.on('change', (event) => {
    console.log(c.yellow(`[change event] type=${event.type}`));
    if (event.operation) {
      console.log(c.dim(`  operation: ${JSON.stringify(event.operation.ops?.slice(0, 3))}...`));
    }
  });
  
  client.on('document', (doc) => {
    console.log(c.dim(`[document event] length=${doc.length}`));
  });
  
  // Create macro engine
  const engine = new MacroEngine(client);
  
  // Add test macro
  engine.addTextMacro('::date::', () => {
    const date = new Date().toISOString().split('T')[0];
    console.log(c.green(`  → Macro triggered! Returning: ${date}`));
    return date;
  });
  
  console.log('Registered macros:', engine.listMacros());
  console.log('\nMacro pattern:', engine.macros.get('::date::')?.pattern);
  
  // Manually check if pattern matches
  const testDoc = 'Hello ::date:: world';
  const pattern = engine.macros.get('::date::')?.pattern;
  if (pattern) {
    pattern.lastIndex = 0;
    const match = pattern.exec(testDoc);
    console.log(`\nTest pattern on "${testDoc}":`, match);
  }
  
  // Start engine with debug logging
  console.log(c.yellow('\n--- Starting macro engine ---'));
  
  // Patch the engine to add logging
  const originalProcess = engine._processDocument.bind(engine);
  engine._processDocument = async function() {
    console.log(c.cyan('[_processDocument called]'));
    const doc = client.getDocument();
    console.log(c.dim(`  Current doc preview: "${doc.slice(0, 100)}..."`));
    
    // Check for macro trigger in document
    if (doc.includes('::date::')) {
      console.log(c.green('  Found ::date:: in document!'));
    }
    
    return originalProcess();
  };
  
  engine.start();
  
  console.log(c.yellow('\nWaiting for changes... Type ::date:: in the document'));
  console.log(c.dim('(Press Ctrl+C to stop)\n'));
  
  // Also poll the document periodically to check for macros
  const pollInterval = setInterval(async () => {
    const doc = client.getDocument();
    if (doc.includes('::date::')) {
      console.log(c.green('\n[Poll] Found ::date:: - manually triggering expansion'));
      
      // Manually expand
      const pattern = engine.macros.get('::date::')?.pattern;
      if (pattern) {
        pattern.lastIndex = 0;
        const match = pattern.exec(doc);
        if (match) {
          console.log('  Match:', match);
          const replacement = new Date().toISOString().split('T')[0];
          const newDoc = doc.replace(/::date::/g, replacement);
          console.log('  Replacing...');
          client.setContent(newDoc);
        }
      }
    }
  }, 2000);
  
  // Keep running
  await new Promise(() => {});
}

main().catch(console.error);
