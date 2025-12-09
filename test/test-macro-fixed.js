#!/usr/bin/env bun
/**
 * Test the fixed macro engine
 */

import { HedgeDocClient, MacroEngine } from '../src/index.js';

const SERVER_URL = 'https://md.tionis.dev';
const NOTE_ID = '49vCOEWsR0KR6UowrEV8Kg';

async function main() {
  console.log('\n🔍 Testing Fixed Macro Engine\n');
  
  const client = new HedgeDocClient({
    serverUrl: SERVER_URL,
    noteId: NOTE_ID
  });
  
  await client.connect();
  console.log('✓ Connected\n');
  
  // Create macro engine
  const engine = new MacroEngine(client);
  
  // Add macros
  engine.addTextMacro('::date::', () => new Date().toISOString().split('T')[0]);
  engine.addTextMacro('::time::', () => new Date().toLocaleTimeString());
  engine.addTextMacro('::now::', () => new Date().toISOString());
  
  console.log('Registered macros:');
  console.log('  ::date:: → current date (YYYY-MM-DD)');
  console.log('  ::time:: → current time');
  console.log('  ::now::  → full ISO timestamp');
  
  // Log when expansion happens
  client.on('change', (event) => {
    if (event.type === 'remote') {
      console.log('\n📝 Remote change detected');
    }
  });
  
  engine.start();
  
  console.log('\n✓ Macro engine started');
  console.log('\nType ::date::, ::time::, or ::now:: in the document');
  console.log('(Make sure to have whitespace around the trigger)');
  console.log('\nPress Ctrl+C to stop\n');
  
  // Keep running
  await new Promise(() => {});
}

main().catch(console.error);
