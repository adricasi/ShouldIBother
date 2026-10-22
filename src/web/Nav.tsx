import { FLAGGED_ENTRIES, visibleEntries, type FlaggedEntry, type Flags } from "./features.js";

export type Route = "today" | "slips";

export interface NavProps {
  /** The flags from `/api/today`; before the first answer none is on. */
  readonly flags: Flags;
  /** The screen shown now. */
  readonly current?: Route;
  /** Overridable so a test can prove that an entry of a flag that is off is not rendered. */
  readonly entries?: readonly FlaggedEntry[];
}

/** The tab bar: Today and Slips always, then the entries of the features whose flag is on (AC-029.2). */
export function Nav({ flags, current = "today", entries = FLAGGED_ENTRIES }: NavProps) {
  return (
    <nav className="tabbar" aria-label="Main">
      <ul>
        <li>
          <a href="#/today" {...(current === "today" ? { "aria-current": "page" as const } : {})}>
            Today
          </a>
        </li>
        <li>
          <a href="#/slips" {...(current === "slips" ? { "aria-current": "page" as const } : {})}>
            Slips
          </a>
        </li>
        {visibleEntries(entries, flags).map((entry) => (
          <li key={entry.id}>
            <a href={`#/${entry.id}`}>{entry.label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
