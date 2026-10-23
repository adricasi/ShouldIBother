import type { ReactNode } from "react";

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
  /**
   * The raised centre button of the mockup (voice capture, flag `voice`, only while the microphone
   * is available, AC-027.3). It sits after Today and Slips; without it the bar has plain tabs.
   */
  readonly fab?: ReactNode;
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

/** Tabs before the raised centre button, as in the mockup (Today, Slips, button, Score, Household). */
const TABS_BEFORE_FAB = 2;

/** The tab bar: Today and Slips always, then the entries of the features whose flag is on (AC-029.2). */
export function Nav({ flags, current = "today", entries = FLAGGED_ENTRIES, fab }: NavProps) {
  const tabs = [
    <Tab key="today" href="#/today" label="Today" icon="sun" current={current === "today"} />,
    <Tab key="slips" href="#/slips" label="Slips" icon="ticket" current={current === "slips"} />,
    ...visibleEntries(entries, flags).map((entry) => (
      <Tab
        key={entry.id}
        href={`#/${entry.id}`}
        label={entry.label}
        icon={entry.icon}
        current={current === entry.id}
      />
    )),
  ];
  const items =
    fab === undefined || fab === null
      ? tabs
      : [
          ...tabs.slice(0, TABS_BEFORE_FAB),
          <li key="fab" className="tab-fab">
            {fab}
          </li>,
          ...tabs.slice(TABS_BEFORE_FAB),
        ];
  return (
    <nav className="tabbar" aria-label="Main">
      {/* The brand shows only in the sidebar of a wide screen (desktop.css); a phone has the tab bar. */}
      <p className="brand" aria-hidden="true">
        <span className="brand-mark">zZ</span>
        <span className="brand-name">
          Should I Bother?
          <span className="brand-sub">The Lazy Bookie</span>
        </span>
      </p>
      <ul>{items}</ul>
    </nav>
  );
}
