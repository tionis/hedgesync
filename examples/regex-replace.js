/**
 * Example: Regex Replace Operations
 * 
 * Demonstrates using regex-based search and replace functionality.
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
    
    // Get current document
    const doc = client.getDocument();
    console.log('\n--- Current Document ---');
    console.log(doc.substring(0, 500) + (doc.length > 500 ? '...' : ''));
    
    // Example 1: Replace first match of a pattern
    console.log('\n--- Replace First Match ---');
    const replaced = await client.replaceRegex(
      /TODO/i,  // Pattern to find
      'DONE'    // Replacement
    );
    console.log(`Replaced: ${replaced}`);
    
    // Example 2: Replace all matches
    console.log('\n--- Replace All Matches ---');
    const count = await client.replaceAllRegex(
      /\bfoo\b/gi,  // Word "foo" case-insensitive
      'bar'          // Replace with "bar"
    );
    console.log(`Replaced ${count} occurrences`);
    
    // Example 3: Replace with capture groups
    console.log('\n--- Replace with Capture Groups ---');
    // Convert [text](url) to <a href="url">text</a>
    const linkCount = await client.replaceAllRegex(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2">$1</a>'
    );
    console.log(`Converted ${linkCount} markdown links to HTML`);
    
    // Example 4: Replace using function
    console.log('\n--- Replace with Function ---');
    // Add current timestamp to date markers
    const dateDoc = client.getDocument();
    const dateMatches = dateDoc.match(/\{\{DATE\}\}/g);
    if (dateMatches) {
      await client.replaceAllRegex(
        /\{\{DATE\}\}/g,
        new Date().toISOString().split('T')[0]
      );
      console.log('Replaced date placeholders');
    }
    
    // Show result
    console.log('\n--- Updated Document ---');
    const updatedDoc = client.getDocument();
    console.log(updatedDoc.substring(0, 500) + (updatedDoc.length > 500 ? '...' : ''));

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    client.disconnect();
    console.log('\nDisconnected.');
  }
}

main();
