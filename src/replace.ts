/** String.prototype.replace-style template expansion, usable per match. */

/** Expand `$&`, `$1`, `$<name>`, `` $` ``, `$'` and `$$` like String.prototype.replace. */
export function expandReplacement(
  template: string,
  match: string,
  groups: (string | undefined)[],
  offset: number,
  input: string,
  named: Record<string, string | undefined> | undefined,
): string {
  return template.replace(/\$(\$|&|`|'|\d{1,2}|<([^>]*)>)/g, (token, spec: string, name?: string) => {
    if (spec === '$') return '$';
    if (spec === '&') return match;
    if (spec === '`') return input.slice(0, offset);
    if (spec === "'") return input.slice(offset + match.length);
    if (name !== undefined) {
      return named ? (named[name] ?? '') : token;
    }
    // Prefer two-digit group references when that group exists.
    const n = parseInt(spec, 10);
    if (spec.length === 2 && (n < 1 || n > groups.length)) {
      const single = parseInt(spec[0], 10);
      if (single >= 1 && single <= groups.length) {
        return (groups[single - 1] ?? '') + spec[1];
      }
      return token;
    }
    if (n < 1 || n > groups.length) return token;
    return groups[n - 1] ?? '';
  });
}
