/** Tool groups and server limits; kept apart from the tools so the CLI can parse options without loading them. */

export const TOOL_GROUPS = ['read', 'edit', 'create'] as const;
export type ToolGroup = typeof TOOL_GROUPS[number];

export interface ToolOptions {
  /** Server for list, search and create when none is given. */
  defaultServer?: string;
  /** Only these tool groups (default: all). */
  groups?: ToolGroup[];
  /** Only these notes (normalized URLs) can be read, edited or listed; creating notes is off. */
  notes?: string[];
}
