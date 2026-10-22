import { FLAGGED_ENTRIES, visibleEntries, type FlaggedEntry, type Flags } from "./features.js";

import type { Route } from "./route.js";
import { Icon, type IconName } from "./ui/Icon.js";

export interface NavProps {
  /** The flags from `/api/today`; before the first answer none is on. */
  readonly flags: Flags;
  /** The screen shown now. */
  readonly current?: Route;
  /** Overridable so a test can prove that an entry of a flag that is off is not rendered. */
  readonly entries?: readonly FlaggedEntry[];
}

function Tab({
  href,
  label,
  icon,
  current,
}: {
  href: string;
  label: string;
  icon: IconName | undefined;
  current: boolean;
}) {
  return (
    <li>
      <a href={href} {...(current ? { "aria-current": "page" as const } : {})}>
        {icon === undefined ? null : <Icon name={icon} />}
        {label}
      </a>
    </li>
  );
}

/** The tab bar: Today and Slips always, then the entries of the features whose flag is on (AC-029.2). */
export function Nav({ flags, current = "today", entries = FLAGGED_ENTRIES }: NavProps) {
  return (
    <nav className="tabbar" aria-label="Main">
      <ul>
        <Tab href="#/today" label="Today" icon="sun" current={current === "today"} />
        <Tab href="#/slips" label="Slips" icon="ticket" current={current === "slips"} />
        {visibleEntries(entries, flags).map((entry) => (
          <Tab
            key={entry.id}
            href={`#/${entry.id}`}
            label={entry.label}
            icon={entry.icon}
            current={current === entry.id}
          />
        ))}
      </ul>
    </nav>
  );
}
