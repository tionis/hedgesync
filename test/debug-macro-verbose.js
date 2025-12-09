#!/usr/bin/env bun
/**
 * Verbose debug for macro engine
 */

import { HedgeDocClient, MacroEngine } from '../src/index.js';

const SERVER_URL = 'https://md.tionis.dev';
const NOTE_ID = '49vCOEWsR0KR6UowrEV8Kg';

async function main() {
  console.log('\n🔍 Verbose Macro Debug\n');
  
  const client = new HedgeDocClient({
    serverUrl: SERVER_URL,
    noteId: NOTE_ID
  });
  
  await client.connect();
  console.log('✓ Connected');
  console.log('Current doc length:', client.getDocument().length);
  
  // Log ALL client events
  const events = ['change', 'document', 'users', 'refresh', 'cursor'];
  for (const eventName of events) {
    client.on(eventName, (...args) => {
      console.log(`\n[EVENT: ${eventName}]`, JSON.stringify(args).slice(0, 200));
    });
  }
  
  // Create macro engine with verbose logging
  const engine = new MacroEngine(client);
  
  // Patch _processDocument to add logging
  const origProcess = engine._processDocument.bind(engine);
  engine._processDocument = async function() {
    console.log('\n[MacroEngine._processDocument called]');
    const doc = client.getDocument();
    console.log('  Doc length:', doc.length);
    console.log('  Contains ::date::?', doc.includes('::date::'));
    
    if (doc.includes('::date::')) {
      const pattern = engine.macros.get('::date::')?.pattern;
      if (pattern) {
        pattern.lastIndex = 0;
        const match = pattern.exec(doc);
        console.log('  Pattern match:', match ? 'YES' : 'NO');
        if (match) {
          console.log('  Match details:', match[0], 'at index', match.index);
        }
      }
    }
    
    return origProcess();
  };
  
  // Also patch _applyMacro
  const origApply = engine._applyMacro.bind(engine);
  engine._applyMacro = async function(document, macro) {
    console.log(`\n[_applyMacro called for ${macro.trigger || macro.name}]`);
    const result = await origApply(document, macro);
    console.log('  Result changed:', result.changed);
    return result;
  };
  
  engine.addTextMacro('::date::', () => {
    console.log('\n[MACRO REPLACEMENT FUNCTION CALLED]');
    return new Date().toISOString().split('T')[0];
  });
  
  console.log('\nMacro pattern:', engine.macros.get('::date::')?.pattern.toString());
  
  engine.start();
  console.log('\n✓ Macro engine started. Listening for changes...');
  console.log('Go type ::date:: in the document (with spaces/newlines around it)\n');
  
  // Keep running
  await new Promise(() => {});
}

main().catch(console.error);
