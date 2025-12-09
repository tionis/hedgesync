#!/usr/bin/env bun
/**
 * Debug script to see authorship data from HedgeDoc
 */

import { HedgeDocClient } from '../src/index.js';

const SERVER_URL = 'https://md.tionis.dev';
const NOTE_ID = '49vCOEWsR0KR6UowrEV8Kg';

async function main() {
  console.log('🔍 Authorship Debug\n');
  
  const client = new HedgeDocClient({
    serverUrl: SERVER_URL,
    noteId: NOTE_ID
  });
  
  // Log refresh event to see authorship data
  client.on('refresh', (data) => {
    console.log('=== Refresh Event Data ===');
    console.log('Authors:', JSON.stringify(data.authors, null, 2));
    console.log('\nAuthorship (first 5 entries):');
    const authorship = data.authorship || [];
    for (let i = 0; i < Math.min(5, authorship.length); i++) {
      const [userId, start, end, created, updated] = authorship[i];
      console.log(`  [${i}] User: ${userId || 'guest'}, Range: ${start}-${end}, Created: ${new Date(created).toISOString()}`);
    }
    if (authorship.length > 5) {
      console.log(`  ... and ${authorship.length - 5} more entries`);
    }
  });
  
  await client.connect();
  console.log('✓ Connected');
  
  // Wait a moment for refresh data
  await new Promise(r => setTimeout(r, 1000));
  
  // Get info
  const info = client.getNoteInfo();
  console.log('\n=== Note Info ===');
  console.log('Title:', info.title);
  console.log('Permission:', info.permission);
  console.log('Owner:', info.owner);
  console.log('Last change user:', info.lastchangeuser);
  console.log('Authors count:', Object.keys(info.authors || {}).length);
  console.log('Authorship entries:', (info.authorship || []).length);
  
  // Get document
  const doc = client.getDocument();
  console.log('\n=== Document ===');
  console.log('Length:', doc.length, 'chars');
  
  // Try to map authorship to text
  const authorship = info.authorship || [];
  if (authorship.length > 0) {
    console.log('\n=== Authorship to Text Mapping (first 5) ===');
    for (let i = 0; i < Math.min(5, authorship.length); i++) {
      const [userId, start, end] = authorship[i];
      const text = doc.substring(start, Math.min(end, start + 50));
      const user = info.authors?.[userId] || { name: userId || 'guest' };
      console.log(`  ${user.name || userId || 'guest'}: "${text}${end - start > 50 ? '...' : ''}"`);
    }
  }
  
  // Users
  const users = client.getUsers();
  console.log('\n=== Online Users ===');
  for (const user of users) {
    console.log(`  ${user.name} (${user.login ? 'logged in' : 'guest'}) - ${user.id}`);
  }
  
  client.disconnect();
}

main().catch(console.error);
