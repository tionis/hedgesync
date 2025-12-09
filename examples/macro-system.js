/**
 * Example: Macro System
 * 
 * Demonstrates using the MacroEngine for automatic text expansions.
 * Macros trigger when patterns are detected in the document.
 */

import { HedgeDocClient, MacroEngine } from '../src/index.js';

const HEDGEDOC_URL = process.env.HEDGEDOC_URL || 'https://md.tionis.dev';
const NOTE_ID = process.env.NOTE_ID || '49vCOEWsR0KR6UowrEV8Kg';

async function main() {
  const client = new HedgeDocClient(HEDGEDOC_URL);

  try {
    console.log('Connecting to note...');
    await client.connect(NOTE_ID);
    console.log('Connected!');
    
    // Create macro engine attached to client
    const macros = new MacroEngine(client);
    
    // Register text macros (simple triggers)
    console.log('\n--- Registering Macros ---');
    
    // Date/time macros using built-in helpers
    const dateMacro = MacroEngine.builtins.dateMacro('::date', 'isoDate');
    macros.addTextMacro(dateMacro.trigger, dateMacro.replacement);
    console.log('Added ::date macro');
    
    const timeMacro = MacroEngine.builtins.dateMacro('::time', 'time');
    macros.addTextMacro(timeMacro.trigger, timeMacro.replacement);
    console.log('Added ::time macro');
    
    const nowMacro = MacroEngine.builtins.dateMacro('::now', 'locale');
    macros.addTextMacro(nowMacro.trigger, nowMacro.replacement);
    console.log('Added ::now macro');
    
    // UUID macro
    const uuidMacro = MacroEngine.builtins.uuidMacro('::uuid');
    macros.addTextMacro(uuidMacro.trigger, uuidMacro.replacement);
    console.log('Added ::uuid macro');
    
    // Counter macro
    const counterMacro = MacroEngine.builtins.counterMacro('::n', 1);
    macros.addTextMacro(counterMacro.trigger, counterMacro.replacement);
    console.log('Added ::n counter macro');
    
    // Custom text macro
    macros.addTextMacro('::sig', () => {
      return `\n---\n*Signed by Bot at ${new Date().toISOString()}*`;
    });
    console.log('Added ::sig signature macro');
    
    // Regex-based macros
    macros.addRegexMacro('uppercase', /UPPER\(([^)]+)\)/g, (match, text) => {
      return text.toUpperCase();
    });
    console.log('Added UPPER(text) macro');
    
    macros.addRegexMacro('lowercase', /LOWER\(([^)]+)\)/g, (match, text) => {
      return text.toLowerCase();
    });
    console.log('Added LOWER(text) macro');
    
    // Template-style macro
    macros.addTemplateMacro('variables', '${', '}', (content) => {
      const vars = {
        user: 'HedgeSync Bot',
        version: '1.0.0',
        project: 'hedgesync'
      };
      return vars[content] || `[unknown: ${content}]`;
    });
    console.log('Added ${variable} template macro');
    
    // Math expression macro
    macros.addRegexMacro('calc', /CALC\(([^)]+)\)/g, (match, expr) => {
      try {
        // WARNING: eval is dangerous! This is just a demo.
        // In production, use a proper math parser like mathjs
        const result = Function(`"use strict"; return (${expr})`)();
        return String(result);
      } catch (e) {
        return `[error: ${e.message}]`;
      }
    });
    console.log('Added CALC(expression) macro');
    
    // List all registered macros
    console.log('\n--- Registered Macros ---');
    const registeredMacros = macros.listMacros();
    registeredMacros.forEach(m => {
      console.log(`  ${m.name}: ${m.type} - ${m.pattern}`);
    });
    
    // Manual expansion (one-time)
    console.log('\n--- Manual Expansion ---');
    const expansions = await macros.expand();
    if (expansions.length > 0) {
      console.log('Expanded:');
      expansions.forEach(e => {
        console.log(`  ${e.macro}: ${e.matches.length} match(es)`);
      });
    } else {
      console.log('No macros found to expand');
    }
    
    // Start listening for changes (auto-expansion)
    console.log('\n--- Starting Auto-Expansion ---');
    macros.start();
    console.log('Macro engine started - will auto-expand triggers as you type');
    console.log('Try typing: ::date, ::uuid, UPPER(hello), CALC(2+2)');
    
    // Wait for a while to demo (in real use, this would run indefinitely)
    console.log('\nWaiting 30 seconds for demo...');
    console.log('(Type macros in the document to see them expand)');
    
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    // Stop macro engine
    macros.stop();
    console.log('\nMacro engine stopped');
    
    // Show final document
    console.log('\n--- Final Document ---');
    const doc = client.getDocument();
    console.log(doc.substring(0, 500) + (doc.length > 500 ? '...' : ''));

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    client.disconnect();
    console.log('\nDisconnected.');
  }
}

main();
