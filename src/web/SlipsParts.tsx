import { useEffect, useState } from "react";

import { usePrefersReducedMotion } from "./motion.js";
import "./slips.css";

export interface SlipsGroup {
  /** The id of the group's heading, which the control scrolls to. */
  readonly id: string;
  readonly label: string;
  /** How many bets the group holds; left out where a number would only grow (Settled). */
  readonly count?: number;
}

/** Where on the screen a heading counts as "the one being read": its top is above this share. */
const READING_LINE = 0.4;

/**
 * The segmented control of Slips (mockup 05): Settle now · n, Waiting · n, Settled. The three
 * groups stay listed one under the other (AC-007.1); the control jumps to a group and follows the
 * scroll, so it also says which group is on screen. Each segment is a toggle button, 44 px tall,
 * with the count in words for screen readers.
 */
export function GroupJump({ groups }: { readonly groups: readonly SlipsGroup[] }) {
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState(groups[0]?.id);
  const ids = groups.map((group) => group.id).join(",");

  useEffect(() => {
    const names = ids.split(",");
    const follow = (): void => {
      const line = window.innerHeight * READING_LINE;
      let current = names[0];
      for (const id of names) {
        const heading = document.getElementById(id);
        if (heading !== null && heading.getBoundingClientRect().top <= line) {
          current = id;
        }
      }
      setActive(current);
    };
    window.addEventListener("scroll", follow, { passive: true });
    return () => {
      window.removeEventListener("scroll", follow);
    };
  }, [ids]);

  return (
    <div className="segments" role="group" aria-label="Show a group of slips">
      {groups.map((group) => (
        <button
          key={group.id}
          type="button"
          className="segment"
          aria-pressed={active === group.id}
          onClick={() => {
            setActive(group.id);
            const heading = document.getElementById(group.id);
            heading?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
            heading?.focus({ preventScroll: true });
          }}
        >
          {group.label}
          {group.count === undefined ? null : (
            <span className="segment-count"> · {group.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
