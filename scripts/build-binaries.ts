/**
 * Compile standalone hedgesync binaries for release, into dist/release/.
 *
 *   bun run scripts/build-binaries.ts            # every target
 *   bun run scripts/build-binaries.ts linux-x64  # some targets
 *
 * CI publishes exactly these files (plus checksums.txt) on a version tag.
 */
import { $ } from 'bun';

export const TARGETS = [
  'linux-x64',
  'linux-arm64',
  'linux-x64-musl', // Alpine and other musl distributions
  'darwin-x64',
  'darwin-arm64',
  'windows-x64',
] as const;

const wanted = process.argv.slice(2);
const unknown = wanted.filter(t => !(TARGETS as readonly string[]).includes(t));
if (unknown.length) {
  console.error(`Unknown target(s): ${unknown.join(', ')}. Known: ${TARGETS.join(', ')}`);
  process.exit(1);
}

await $`bun run scripts/gen-nvim-plugin.ts`.quiet();
await $`bun run scripts/gen-skill.ts`.quiet();
for (const target of wanted.length ? wanted : TARGETS) {
  const out = `dist/release/hedgesync-${target}${target.startsWith('windows') ? '.exe' : ''}`;
  await $`bun build bin/hedgesync.ts --compile --target=bun-${target} --outfile ${out}`.quiet();
  console.log(`built ${out}`);
}
