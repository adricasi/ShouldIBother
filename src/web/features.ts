import { z } from "zod";

import type { IconName } from "./ui/icon-name.js";

/**
 * A UI entry point (a tab, a button, a link) that belongs to a flagged feature (REQ-029,
 * AC-029.2): it is rendered only while the server reports the flag as on. `id` is the route of
 * the screen in the SPA.
 */
export interface FlaggedEntry {
  readonly flag: string;
  readonly id: string;
  readonly label: string;
  /** The tab's icon; a tab without one shows its label only. */
  readonly icon?: IconName;
}

/**
 * The entry points of features that sit behind a flag. Each flagged task adds its entry here
 * together with its screen; none of the features of the walking skeleton is flagged.
 */
export const FLAGGED_ENTRIES: readonly FlaggedEntry[] = [
  { flag: "score", id: "score", label: "Score", icon: "trophy" },
  { flag: "onboarding", id: "onboarding", label: "Household", icon: "plant" },
];

/** The flags as `/api/today` reports them: every flag name with its boolean. */
export const flagsSchema = z.record(z.string(), z.boolean());
export type Flags = z.infer<typeof flagsSchema>;

/** The entries to show: a flag that is off, missing or unknown never yields an entry. */
export function visibleEntries(
  entries: readonly FlaggedEntry[],
  flags: Flags,
): readonly FlaggedEntry[] {
  return entries.filter((entry) => flags[entry.flag] === true);
}
