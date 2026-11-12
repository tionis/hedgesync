#!/usr/bin/env bun
/**
 * hedgesync CLI entry point for Bun (`bun run bin/hedgesync.ts`, `bun build --compile`).
 * The implementation lives in src/cli/; the npm package runs dist/cli/bin.js with Node.
 */
import { run } from '../src/cli/main.js';

run();
