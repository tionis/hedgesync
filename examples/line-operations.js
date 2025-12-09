/**
 * Example: Line-based Operations
 * 
 * Demonstrates reading and modifying specific lines in a document.
 */

import { HedgeDocClient } from '../src/index.js';

const HEDGEDOC_URL = process.env.HEDGEDOC_URL || 'https://md.tionis.dev';
const NOTE_ID = process.env.NOTE_ID || '49vCOEWsR0KR6UowrEV8Kg';

async function main() {
  const client = new HedgeDocClient(HEDGEDOC_URL);

  try {
    console.log('Connecting to note...');
    await client.connect(NOTE_ID);
    console.log('Connected!');
    
    // Get all lines
    const lines = client.getLines();
    console.log(`\nDocument has ${lines.length} lines`);
    
    // Print first 5 lines with line numbers
    console.log('\n--- First 5 Lines ---');
    for (let i = 0; i < Math.min(5, lines.length); i++) {
      console.log(`${i + 1}: ${lines[i]}`);
    }
    
    // Get a specific line (1-indexed)
    console.log('\n--- Get Specific Line ---');
    const line1 = client.getLine(1);
    console.log(`Line 1: "${line1}"`);
    
    // Replace a specific line
    console.log('\n--- Replace Line ---');
    if (lines.length >= 2) {
      const originalLine2 = client.getLine(2);
      await client.replaceLine(2, `${originalLine2} (modified at ${new Date().toISOString()})`);
      console.log(`Modified line 2`);
    }
    
    // Set multiple lines at once
    console.log('\n--- Set Multiple Lines ---');
    const newLines = [
      '# Document Title',
      '',
      'This document was programmatically modified.',
      '',
      `Last updated: ${new Date().toISOString()}`
    ];
    // This replaces the entire document
    // await client.setLines(newLines);
    console.log('(Skipped to preserve document - uncomment to test)');
    
    // Get line range
    console.log('\n--- Get Line Range ---');
    const subset = lines.slice(0, 3); // First 3 lines (0-indexed in array)
    console.log('First 3 lines:', subset);
    
    // Find line containing text
    console.log('\n--- Find Line by Content ---');
    const searchText = '#';
    const foundIndex = lines.findIndex(line => line.includes(searchText));
    if (foundIndex !== -1) {
      console.log(`Found "${searchText}" on line ${foundIndex + 1}: "${lines[foundIndex]}"`);
    } else {
      console.log(`No line containing "${searchText}" found`);
    }
    
    // Show updated document
    console.log('\n--- Current Document ---');
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
