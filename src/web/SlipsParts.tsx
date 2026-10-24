import { useEffect, useRef, useState } from "react";

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
/** How long the page must be still before a tapped group stops being held as the current one. */
const CHOICE_HOLD_MS = 150;
/** The longest a tapped group is held when no scroll follows (the page was already there). */
const CHOICE_RELEASE_MS = 1000;

/**
 * The segmented control of Slips (mockup 05): Settle now · n, Waiting · n, Settled. The three
 * groups stay listed one under the other (AC-007.1); the control jumps to a group and follows the
 * scroll, so it also says which group is on screen (`aria-current`). Each segment is a button,
 * 44 px tall, with the count in its text. At the bottom of the page the last group is the one in
 * view even when its heading never reaches the reading line; a group that was just chosen stays
 * the current one while the page scrolls to it.
 */
export function GroupJump({ groups }: { readonly groups: readonly SlipsGroup[] }) {
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState(groups[0]?.id);
  // The group chosen by a tap, kept until the scroll it caused has ended (the page stops moving).
  const chosen = useRef<string | undefined>(undefined);
  const ids = groups.map((group) => group.id).join(",");

  useEffect(() => {
    const names = ids.split(",");
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const follow = (): void => {
      if (chosen.current !== undefined) {
        return;
      }
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 1;
      if (atBottom && window.scrollY > 0) {
        setActive(names[names.length - 1]);
        return;
      }
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
    // While a chosen group scrolls into view, scroll events only restart this timer; when they
    // stop, the choice is released and the page decides again.
    const onScroll = (): void => {
      if (chosen.current !== undefined) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          chosen.current = undefined;
        }, CHOICE_HOLD_MS);
        return;
      }
      follow();
    };
    follow();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(settleTimer);
      window.removeEventListener("scroll", onScroll);
    };
  }, [ids]);

  return (
    <div className="segments" role="group" aria-label="Jump to a group">
      {groups.map((group) => (
        <button
          key={group.id}
          type="button"
          className="segment"
          {...(active === group.id ? { "aria-current": "true" as const } : {})}
          onClick={() => {
            setActive(group.id);
            chosen.current = group.id;
            const heading = document.getElementById(group.id);
            heading?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
            heading?.focus({ preventScroll: true });
            // If the page cannot move (already there, or no scroll events), release the choice.
            window.setTimeout(() => {
              if (chosen.current === group.id) {
                chosen.current = undefined;
              }
            }, CHOICE_RELEASE_MS);
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
