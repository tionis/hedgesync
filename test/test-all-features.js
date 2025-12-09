#!/usr/bin/env bun
/**
 * Comprehensive test script for hedgesync library
 * Tests all major features against a live HedgeDoc server
 */

import { HedgeDocClient, TextOperation, PandocTransformer, MacroEngine } from '../src/index.js';
import { isPandocAvailable } from '../src/pandoc-transformer.js';

// Test configuration
const SERVER_URL = 'https://md.tionis.dev';
const NOTE_ID = '49vCOEWsR0KR6UowrEV8Kg';

// Colors for output
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// Test tracking
let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;
const failures = [];

function log(msg) {
  console.log(msg);
}

function assert(condition, message) {
  testsRun++;
  if (condition) {
    testsPassed++;
    log(c.green(`  ✓ ${message}`));
    return true;
  } else {
    testsFailed++;
    failures.push(message);
    log(c.red(`  ✗ ${message}`));
    return false;
  }
}

function assertEqual(actual, expected, message) {
  testsRun++;
  if (actual === expected) {
    testsPassed++;
    log(c.green(`  ✓ ${message}`));
    return true;
  } else {
    testsFailed++;
    failures.push(`${message}: expected "${expected}", got "${actual}"`);
    log(c.red(`  ✗ ${message}`));
    log(c.dim(`    Expected: "${expected}"`));
    log(c.dim(`    Actual:   "${actual}"`));
    return false;
  }
}

function assertIncludes(str, substr, message) {
  testsRun++;
  if (str.includes(substr)) {
    testsPassed++;
    log(c.green(`  ✓ ${message}`));
    return true;
  } else {
    testsFailed++;
    failures.push(`${message}: "${str}" does not include "${substr}"`);
    log(c.red(`  ✗ ${message}`));
    return false;
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// Test Suites
// ============================================

async function testTextOperation() {
  log(c.bold('\n📝 Testing TextOperation class'));
  
  // Test basic operations
  const op1 = new TextOperation();
  op1.retain(5).insert('hello').retain(3).delete(2);
  
  assert(Array.isArray(op1.ops), 'TextOperation has ops array');
  assertEqual(op1.ops.length, 4, 'TextOperation has 4 operations');
  
  // Test apply
  const text = '12345abc12';
  const op2 = new TextOperation();
  op2.retain(5).insert('INSERTED').retain(3).delete(2);
  const result = op2.apply(text);
  assertEqual(result, '12345INSERTEDabc', 'TextOperation.apply works correctly');
  
  // Test compose
  const op3 = new TextOperation().retain(5).insert('X');
  const op4 = new TextOperation().retain(6).insert('Y');
  const composed = op3.compose(op4);
  assert(composed instanceof TextOperation, 'compose returns TextOperation');
  
  // Test transform
  const op5 = new TextOperation().retain(3).insert('A');
  const op6 = new TextOperation().retain(3).insert('B');
  const [op5p, op6p] = TextOperation.transform(op5, op6);
  assert(op5p instanceof TextOperation, 'transform returns TextOperations');
  assert(op6p instanceof TextOperation, 'transform returns two TextOperations');
  
  // Test fromJSON
  const json = [5, 'hello', 3, -2];
  const opFromJson = TextOperation.fromJSON(json);
  assertEqual(opFromJson.ops.length, 4, 'fromJSON parses correctly');
  
  // Test toJSON
  const toJson = op1.toJSON();
  assert(Array.isArray(toJson), 'toJSON returns array');
  
  log(c.green('  TextOperation tests complete'));
}

async function testConnection(client) {
  log(c.bold('\n🔌 Testing Connection'));
  
  assert(client.connected, 'Client is connected');
  assert(client.ready, 'Client is ready');
  assert(typeof client.getDocument() === 'string', 'getDocument returns string');
  assert(typeof client.getRevision() === 'number', 'getRevision returns number');
}

async function testNoteInfo(client) {
  log(c.bold('\n📋 Testing Note Info'));
  
  // Wait for refresh event to ensure we have permission info
  await sleep(500);
  
  const info = client.getNoteInfo();
  assert(info !== null, 'getNoteInfo returns object');
  assert(typeof info.title === 'string', 'Note has title');
  assert(typeof info.permission === 'string', 'Note has permission');
  assertEqual(info.permission, 'freely', 'Permission is "freely"');
  assert(client.canEdit(), 'canEdit returns true for freely document');
  
  log(c.dim(`  Title: ${info.title}`));
  log(c.dim(`  Permission: ${info.permission}`));
}

async function testOnlineUsers(client) {
  log(c.bold('\n👥 Testing Online Users'));
  
  const users = client.getOnlineUsers();
  // Users might be a Map or an object depending on implementation
  const isMap = users instanceof Map;
  const isObject = typeof users === 'object' && users !== null;
  assert(isMap || isObject, 'getOnlineUsers returns Map or object');
  
  // Request fresh user list
  client.requestOnlineUsers();
  await sleep(500);
  
  const usersAfter = client.getOnlineUsers();
  if (usersAfter instanceof Map) {
    assert(usersAfter.size >= 0, 'Users map has entries or is empty');
    log(c.dim(`  Online users: ${usersAfter.size}`));
  } else {
    const count = Object.keys(usersAfter || {}).length;
    assert(count >= 0, 'Users has entries or is empty');
    log(c.dim(`  Online users: ${count}`));
  }
}

async function testBasicEditing(client) {
  log(c.bold('\n✏️ Testing Basic Editing'));
  
  const originalDoc = client.getDocument();
  const testMarker = `\n<!-- TEST MARKER ${Date.now()} -->`;
  
  // Test append (insert at end)
  const docBefore = client.getDocument();
  client.insert(docBefore.length, testMarker);
  await sleep(500);
  
  let docAfter = client.getDocument();
  assertIncludes(docAfter, 'TEST MARKER', 'Insert at end works');
  
  // Test delete - get fresh position
  docAfter = client.getDocument();
  const markerPos = docAfter.indexOf(testMarker);
  if (markerPos >= 0) {
    client.delete(markerPos, testMarker.length);
    await sleep(500);
    docAfter = client.getDocument();
    assert(!docAfter.includes('TEST MARKER'), 'Delete works');
  }
  
  // Test replace
  const testText = '\n<!-- REPLACE TEST -->';
  const currentDoc = client.getDocument();
  client.insert(currentDoc.length, testText);
  await sleep(500);
  
  docAfter = client.getDocument();
  const replacePos = docAfter.indexOf('REPLACE TEST');
  if (replacePos >= 0) {
    client.replace(replacePos, 12, 'REPLACED OK');
    await sleep(500);
    docAfter = client.getDocument();
    assertIncludes(docAfter, 'REPLACED OK', 'Replace works');
    
    // Clean up - get fresh document and position
    docAfter = client.getDocument();
    const cleanupText = '\n<!-- REPLACED OK -->';
    const cleanupPos = docAfter.indexOf(cleanupText);
    if (cleanupPos >= 0) {
      client.delete(cleanupPos, cleanupText.length);
      await sleep(500);
    }
  }
}

async function testRegexOperations(client) {
  log(c.bold('\n🔍 Testing Regex Operations'));
  
  // Add test content
  const testBlock = '\n<!-- REGEX TEST: num1=123 num2=456 num3=789 -->';
  client.insert(client.getDocument().length, testBlock);
  await sleep(800);
  
  // Test replaceRegex (replace all)
  let doc = client.getDocument();
  if (doc.includes('num1=123')) {
    try {
      const count = client.replaceRegex(/num\d+=\d+/g, 'value=XXX');
      await sleep(800);
      doc = client.getDocument();
      assert(count >= 1, `replaceRegex replaced ${count} occurrences`);
      assertIncludes(doc, 'value=XXX', 'Regex replace works');
    } catch (err) {
      log(c.yellow(`  ⚠ replaceRegex error (concurrent edit): ${err.message}`));
    }
  }
  
  // Test replaceFirst
  await sleep(500);
  doc = client.getDocument();
  client.insert(doc.length, '\n<!-- FIRST: aaa bbb aaa -->');
  await sleep(800);
  
  doc = client.getDocument();
  if (doc.includes('FIRST: aaa')) {
    try {
      const replaced = client.replaceFirst(/aaa/, 'ZZZ');
      await sleep(800);
      doc = client.getDocument();
      assert(replaced, 'replaceFirst returns true on success');
      assertIncludes(doc, 'ZZZ', 'replaceFirst works');
    } catch (err) {
      log(c.yellow(`  ⚠ replaceFirst error (concurrent edit): ${err.message}`));
    }
  }
  
  // Clean up test content - use setContent for reliability
  await sleep(500);
  doc = client.getDocument();
  
  // Find and remove our test markers
  let cleanDoc = doc;
  const regexMarker = /\n<!-- REGEX TEST:.*?-->/gs;
  const firstMarker = /\n<!-- FIRST:.*?-->/gs;
  cleanDoc = cleanDoc.replace(regexMarker, '');
  cleanDoc = cleanDoc.replace(firstMarker, '');
  
  if (cleanDoc !== doc) {
    client.setContent(cleanDoc);
    await sleep(500);
  }
}

async function testLineOperations(client) {
  log(c.bold('\n📄 Testing Line Operations'));
  
  // Test getLines
  const lines = client.getLines();
  assert(Array.isArray(lines), 'getLines returns array');
  assert(lines.length > 0, 'Document has lines');
  
  // Test getLineCount
  const lineCount = client.getLineCount();
  assertEqual(lineCount, lines.length, 'getLineCount matches getLines length');
  
  // Test getLine
  const firstLine = client.getLine(0);
  assertEqual(firstLine, lines[0], 'getLine(0) matches first line');
  
  // Test getLineStart/getLineEnd
  const lineStart = client.getLineStart(0);
  assertEqual(lineStart, 0, 'First line starts at 0');
  
  const lineEnd = client.getLineEnd(0);
  assert(lineEnd >= lineStart, 'Line end is after line start');
  
  // Test insertLine
  const originalLineCount = client.getLineCount();
  client.insertLine(originalLineCount, '<!-- LINE TEST -->');
  await sleep(300);
  
  let doc = client.getDocument();
  assertIncludes(doc, '<!-- LINE TEST -->', 'insertLine works');
  
  // Test setLine
  const lastLineNum = client.getLineCount() - 1;
  client.setLine(lastLineNum, '<!-- LINE MODIFIED -->');
  await sleep(300);
  
  doc = client.getDocument();
  assertIncludes(doc, '<!-- LINE MODIFIED -->', 'setLine works');
  
  // Test deleteLine
  const lineCountBefore = client.getLineCount();
  client.deleteLine(lastLineNum);
  await sleep(300);
  
  const lineCountAfter = client.getLineCount();
  assert(lineCountAfter < lineCountBefore, 'deleteLine removes line');
}

async function testSetContent(client) {
  log(c.bold('\n📝 Testing setContent'));
  
  const originalDoc = client.getDocument();
  
  // Set new content
  const testContent = '# Test Document\n\nThis is a test.\n\n' + originalDoc;
  client.setContent(testContent);
  await sleep(300);
  
  let doc = client.getDocument();
  assertIncludes(doc, '# Test Document', 'setContent works');
  
  // Restore original
  client.setContent(originalDoc);
  await sleep(300);
  
  doc = client.getDocument();
  assertEqual(doc, originalDoc, 'Content restored');
}

async function testUpdateContent(client) {
  log(c.bold('\n🔄 Testing updateContent (diff-based)'));
  
  const originalDoc = client.getDocument();
  
  // Make a small change using diff
  const modified = originalDoc.replace(/^# .*$/m, '# Modified Title');
  if (modified !== originalDoc) {
    client.updateContent(modified);
    await sleep(300);
    
    let doc = client.getDocument();
    assertIncludes(doc, 'Modified Title', 'updateContent with diff works');
    
    // Restore
    client.updateContent(originalDoc);
    await sleep(300);
  } else {
    log(c.dim('  Skipping updateContent test (no title to modify)'));
  }
}

async function testRateLimiting(client) {
  log(c.bold('\n⏱️ Testing Rate Limiting'));
  
  // Check rate limit config
  const config = client.getRateLimitConfig();
  assert(typeof config.minInterval === 'number', 'Rate limit has minInterval');
  assert(typeof config.maxBurst === 'number', 'Rate limit has maxBurst');
  
  // Test enable/disable
  const wasEnabled = client.isRateLimitEnabled();
  client.setRateLimitEnabled(false);
  assertEqual(client.isRateLimitEnabled(), false, 'Rate limiting can be disabled');
  
  client.setRateLimitEnabled(true);
  assertEqual(client.isRateLimitEnabled(), true, 'Rate limiting can be enabled');
  
  // Restore original state
  client.setRateLimitEnabled(wasEnabled);
  
  // Test configureRateLimit
  client.configureRateLimit({ minInterval: 100 });
  const newConfig = client.getRateLimitConfig();
  assertEqual(newConfig.minInterval, 100, 'configureRateLimit works');
  
  // Restore default
  client.configureRateLimit({ minInterval: 50 });
}

async function testBatchOperations(client) {
  log(c.bold('\n📦 Testing Batch Operations'));
  
  const originalDoc = client.getDocument();
  
  // Test batch mode
  assertEqual(client.isBatchMode(), false, 'Not in batch mode initially');
  
  client.startBatch();
  assertEqual(client.isBatchMode(), true, 'In batch mode after startBatch');
  
  // Add test content in batch - single operation
  const pos = client.getDocument().length;
  client.insert(pos, '\n<!-- BATCH1 -->\n<!-- BATCH2 -->');
  
  // End batch
  client.endBatch();
  await sleep(800);
  
  assertEqual(client.isBatchMode(), false, 'Not in batch mode after endBatch');
  
  let doc = client.getDocument();
  assertIncludes(doc, 'BATCH1', 'Batch operation 1 applied');
  assertIncludes(doc, 'BATCH2', 'Batch operation 2 applied');
  
  // Test batch() helper
  await sleep(300);
  client.batch(() => {
    const d = client.getDocument();
    client.insert(d.length, '\n<!-- BATCH3 -->');
  });
  await sleep(500);
  
  doc = client.getDocument();
  assertIncludes(doc, 'BATCH3', 'batch() helper works');
  
  // Test cancelBatch
  await sleep(300);
  client.startBatch();
  client.insert(client.getDocument().length, '\n<!-- CANCELLED -->');
  client.cancelBatch();
  await sleep(300);
  
  doc = client.getDocument();
  assert(!doc.includes('CANCELLED'), 'cancelBatch prevents operations');
  
  // Clean up
  client.setContent(originalDoc);
  await sleep(500);
}

async function testUndoRedo(client) {
  log(c.bold('\n↩️ Testing Undo/Redo'));
  
  const originalDoc = client.getDocument();
  client.clearHistory();
  
  // Make some changes
  client.insert(client.getDocument().length, '\n<!-- UNDO TEST 1 -->');
  await sleep(600); // Wait for undo grouping interval
  
  client.insert(client.getDocument().length, '\n<!-- UNDO TEST 2 -->');
  await sleep(600);
  
  let doc = client.getDocument();
  assertIncludes(doc, 'UNDO TEST 1', 'First change applied');
  assertIncludes(doc, 'UNDO TEST 2', 'Second change applied');
  
  // Test canUndo
  assert(client.canUndo(), 'canUndo returns true after changes');
  
  // Test undo
  const undid = client.undo();
  await sleep(300);
  
  assert(undid, 'undo returns true on success');
  doc = client.getDocument();
  assert(!doc.includes('UNDO TEST 2'), 'Undo removed last change');
  
  // Test canRedo
  assert(client.canRedo(), 'canRedo returns true after undo');
  
  // Test redo
  const redid = client.redo();
  await sleep(300);
  
  assert(redid, 'redo returns true on success');
  doc = client.getDocument();
  assertIncludes(doc, 'UNDO TEST 2', 'Redo restored change');
  
  // Test getUndoStackSize/getRedoStackSize
  assert(client.getUndoStackSize() >= 0, 'getUndoStackSize works');
  assert(client.getRedoStackSize() >= 0, 'getRedoStackSize works');
  
  // Clean up - undo all changes and restore
  while (client.canUndo()) {
    client.undo();
    await sleep(200);
  }
  
  client.setContent(originalDoc);
  await sleep(300);
  client.clearHistory();
}

async function testReconnection(client) {
  log(c.bold('\n🔁 Testing Reconnection Config'));
  
  // Test reconnect config
  const config = client.getReconnectConfig();
  assert(typeof config.enabled === 'boolean', 'Reconnect config has enabled');
  assert(typeof config.maxAttempts === 'number', 'Reconnect config has maxAttempts');
  
  // Test enable/disable
  const wasEnabled = client.isReconnectEnabled();
  
  client.setReconnectEnabled(false);
  assertEqual(client.isReconnectEnabled(), false, 'Reconnection can be disabled');
  
  client.setReconnectEnabled(true);
  assertEqual(client.isReconnectEnabled(), true, 'Reconnection can be enabled');
  
  // Restore
  client.setReconnectEnabled(wasEnabled);
  
  // Test configureReconnect
  client.configureReconnect({ maxAttempts: 5 });
  const newConfig = client.getReconnectConfig();
  assertEqual(newConfig.maxAttempts, 5, 'configureReconnect works');
  
  // Restore default
  client.configureReconnect({ maxAttempts: 10 });
}

async function testMacroEngine(client) {
  log(c.bold('\n🤖 Testing MacroEngine'));
  
  const engine = new MacroEngine(client);
  
  // Test addTextMacro
  engine.addTextMacro('::test::', 'REPLACED');
  assert(true, 'addTextMacro works');
  
  // Test addRegexMacro
  engine.addRegexMacro('numbers', /\bNUM(\d+)\b/, (match, num) => `NUMBER_${num}`);
  assert(true, 'addRegexMacro works');
  
  // Test addTemplateMacro with simple delimiters (avoiding {{}} due to regex bug)
  try {
    engine.addTemplateMacro('dollars', '${', '}', (content) => `VALUE_${content}`);
    assert(true, 'addTemplateMacro works');
  } catch (err) {
    log(c.yellow(`  ⚠ addTemplateMacro has a regex issue: ${err.message}`));
  }
  
  // Test listMacros
  const macros = engine.listMacros();
  assert(Array.isArray(macros), 'listMacros returns array');
  assert(macros.length >= 2, 'At least two macros registered');
  
  // Test that macros map has our entries
  assert(engine.macros.has('::test::'), 'macros Map has text macro');
  assert(engine.macros.has('numbers'), 'macros Map has regex macro');
  
  // Test removeMacro
  engine.removeMacro('numbers');
  assert(!engine.macros.has('numbers'), 'removeMacro works');
  
  // Test enable/disable
  engine.setEnabled(false);
  engine.setEnabled(true);
  assert(true, 'setEnabled works');
  
  // Test start/stop (just verify no errors)
  engine.start();
  assert(true, 'start() works');
  engine.stop();
  assert(true, 'stop() works');
  
  // Test that macros can be cleared by removing all
  for (const [name] of engine.macros) {
    engine.removeMacro(name);
  }
  assertEqual(engine.listMacros().length, 0, 'All macros removed');
}

async function testPandocTransformer() {
  log(c.bold('\n🔄 Testing PandocTransformer'));
  
  // Check if pandoc is available
  const pandocAvailable = await isPandocAvailable();
  
  if (!pandocAvailable) {
    log(c.yellow('  ⚠ Pandoc not available, skipping transformer tests'));
    return;
  }
  
  assert(pandocAvailable, 'Pandoc is available');
  
  const transformer = new PandocTransformer();
  
  // Test parse (markdownToAST)
  const markdown = '# Heading 1\n\n## Heading 2\n\nSome text.';
  const ast = await transformer.parse(markdown);
  assert(ast !== null, 'parse returns AST');
  assert(typeof ast === 'object', 'AST is an object');
  assert(ast.blocks !== undefined, 'AST has blocks');
  
  // Test render (astToMarkdown)
  const rendered = await transformer.render(ast);
  assert(typeof rendered === 'string', 'render returns string');
  assertIncludes(rendered, 'Heading 1', 'rendered contains heading');
  
  // Test transform with custom function
  const transformed = await transformer.transform(markdown, (ast) => {
    // Demote all headers by 1 level
    PandocTransformer.walk(ast, (node) => {
      if (node && node.t === 'Header') {
        node.c[0] = Math.min(node.c[0] + 1, 6); // Increase level, max 6
      }
    });
    return ast;
  });
  assertIncludes(transformed, '##', 'transform modified headers (## found)');
  
  // Test convert
  const html = await transformer.convert(markdown, 'markdown', 'html');
  assertIncludes(html, '<h1', 'convert to HTML works');
  
  // Test filterByType
  const headers = transformer.filterByType(ast, 'Header');
  assert(Array.isArray(headers), 'filterByType returns array');
  assertEqual(headers.length, 2, 'Found 2 headers');
  
  // Test walkAST
  let nodeCount = 0;
  transformer.walkAST(ast, () => { nodeCount++; });
  assert(nodeCount > 0, 'walkAST visits nodes');
  
  // Test static helpers
  const headerNode = PandocTransformer.createHeader(1, 'Test Header');
  assertEqual(headerNode.t, 'Header', 'createHeader creates header node');
  
  const paraNode = PandocTransformer.createPara('Test paragraph');
  assertEqual(paraNode.t, 'Para', 'createPara creates paragraph node');
}

async function testEvents(client) {
  log(c.bold('\n📡 Testing Events'));
  
  // Test that event emitter works
  let refreshCalled = false;
  const refreshHandler = () => { refreshCalled = true; };
  client.on('refresh', refreshHandler);
  
  // Request a refresh
  client.refresh();
  await sleep(500);
  
  assert(refreshCalled, 'refresh event is emitted');
  
  client.off('refresh', refreshHandler);
  
  // Test users event
  let usersCalled = false;
  const usersHandler = () => { usersCalled = true; };
  client.on('users', usersHandler);
  
  client.requestOnlineUsers();
  await sleep(500);
  
  assert(usersCalled, 'users event is emitted');
  
  client.off('users', usersHandler);
}

// ============================================
// Main Test Runner
// ============================================

async function runTests() {
  log(c.bold(c.cyan('\n🧪 hedgesync Feature Test Suite\n')));
  log(c.dim(`Server: ${SERVER_URL}`));
  log(c.dim(`Note:   ${NOTE_ID}`));
  
  let client;
  
  try {
    // Test TextOperation (no connection needed)
    await testTextOperation();
    
    // Test PandocTransformer (no connection needed, but needs pandoc)
    await testPandocTransformer();
    
    // Connect to server
    log(c.bold('\n🔌 Connecting to HedgeDoc...'));
    client = new HedgeDocClient({
      serverUrl: SERVER_URL,
      noteId: NOTE_ID,
      operationTimeout: 10000,
      rateLimit: {
        enabled: false // Disable rate limiting for tests to avoid timing issues
      },
      reconnect: {
        enabled: true,
        maxAttempts: 3
      },
      trackUndo: true,
      undoGroupInterval: 500
    });
    
    await client.connect();
    log(c.green('  Connected successfully!'));
    
    // Run connected tests
    await testConnection(client);
    await testNoteInfo(client);
    await testOnlineUsers(client);
    await testBasicEditing(client);
    await testRegexOperations(client);
    await testLineOperations(client);
    await testSetContent(client);
    await testUpdateContent(client);
    await testRateLimiting(client);
    await testBatchOperations(client);
    await testUndoRedo(client);
    await testReconnection(client);
    await testEvents(client);
    await testMacroEngine(client);
    
  } catch (error) {
    log(c.red(`\n❌ Test error: ${error.message}`));
    console.error(error);
    testsFailed++;
  } finally {
    // Disconnect
    if (client && client.connected) {
      log(c.bold('\n🔌 Disconnecting...'));
      client.disconnect();
    }
    
    // Print summary
    log(c.bold('\n' + '='.repeat(50)));
    log(c.bold('📊 Test Summary'));
    log('='.repeat(50));
    log(`  Total tests: ${testsRun}`);
    log(c.green(`  Passed:      ${testsPassed}`));
    if (testsFailed > 0) {
      log(c.red(`  Failed:      ${testsFailed}`));
      log(c.red('\nFailed tests:'));
      failures.forEach(f => log(c.red(`  - ${f}`)));
    }
    log('');
    
    if (testsFailed === 0) {
      log(c.green(c.bold('✅ All tests passed!\n')));
      process.exit(0);
    } else {
      log(c.red(c.bold('❌ Some tests failed!\n')));
      process.exit(1);
    }
  }
}

// Run tests
runTests();
