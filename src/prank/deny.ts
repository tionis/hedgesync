/**
 * deny: whatever the chosen users type is undone at once.
 */

import type { Prank, PrankEdit, PrankUser } from './engine.js';

export interface DenyOptions {
  /** Whose edits are reverted. */
  targets: (user?: PrankUser) => boolean;
}

/**
 * A matcher for --deny style specs: a HedgeDoc account id (exact) or a
 * display-name regex (case-insensitive).
 */
export function userMatcher(specs: string[]): (user?: PrankUser) => boolean {
  const patterns = specs.map(spec => {
    try {
      return new RegExp(spec, 'i');
    } catch {
      return null;
    }
  });
  return (user) => specs.some((spec, i) =>
    (!!user?.userid && user.userid === spec) || (!!patterns[i] && patterns[i]!.test(user?.name ?? '')));
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
