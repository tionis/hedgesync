/**
 * deny: whatever the chosen users type is undone at once.
 */

import type { Prank, PrankEdit, PrankUser } from './engine.js';

export interface DenyOptions {
  /** Whose edits are reverted (see userMatcher). The engine's `except` still applies. */
  targets: (user?: PrankUser) => boolean;
}

/** Revert every edit by the targets: inserts are deleted, deletions restored. */
export function deny(options: DenyOptions): Prank {
  return {
    name: 'deny',
    targets: options.targets,
    exclusive: true,
    react(pieces) {
      const edits: PrankEdit[] = [];
      for (const p of pieces) {
        if (p.type === 'insert') edits.push({ type: 'delete', index: p.index, length: p.text.length });
        else if (p.text !== undefined) edits.push({ type: 'insert', index: p.index, text: p.text });
      }
      return edits;
    },
  };
}
