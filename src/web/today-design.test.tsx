// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Card, Plan, Today } from "./api.js";
import { formatDateLine, formatTotal, greetingFor } from "./format.js";
import { Nav } from "./Nav.js";
import { PlanDays } from "./PlannerParts.js";
import { emptyWeek } from "./test-data.js";
import { CaptureBar, GemmaStatus, QuickChips, TodayHeader } from "./TodayParts.js";
import { TodayScreen } from "./TodayScreen.js";
import "./zod-config.js";

const today: Today = {
  now: "2026-10-20T07:41:00.000Z",
  flags: {},
  points: { total: 1240 },
  gemma: { status: "online", detail: null, checked_at: "2026-10-20T07:41:00.000Z" },
  forecast: null,
  week: emptyWeek,
  attribution: "Weather data by Open-Meteo.com",
  cards: [],
  open_bets: [],
  due_bets: [],
};

function screen(value: Today, extra: Partial<Parameters<typeof TodayScreen>[0]> = {}): string {
  return renderToStaticMarkup(
    <TodayScreen
      today={value}
      busy={false}
      notice={undefined}
      results={{}}
      nowMs={Date.parse(value.now)}
      onQuickCard={() => undefined}
      onCapture={() => Promise.resolve(true)}
      onRetry={() => undefined}
      onAnswer={() => undefined}
      onBet={() => undefined}
      onDoIt={() => undefined}
      onUndo={() => undefined}
      onSettle={() => undefined}
      {...extra}
    />,
  );
}

describe("Today header (mockup 02)", () => {
  it("greets by Madrid time of day", () => {
    // 07:41 UTC on 20 Oct is 09:41 in Madrid (CEST, UTC+2).
    expect(greetingFor("2026-10-20T07:41:00.000Z")).toBe("Good morning");
    expect(greetingFor("2026-10-20T10:00:00.000Z")).toBe("Good afternoon");
    expect(greetingFor("2026-10-20T16:59:00.000Z")).toBe("Good afternoon");
    expect(greetingFor("2026-10-20T17:00:00.000Z")).toBe("Good evening");
    expect(greetingFor("2026-10-20T02:00:00.000Z")).toBe("Good evening");
  });

  it("prints the date line in Madrid time", () => {
    expect(formatDateLine("2026-10-20T07:41:00.000Z")).toBe("Tuesday · 20 October");
    // 23:30 UTC is already the next day in Madrid.
    expect(formatDateLine("2026-10-20T23:30:00.000Z")).toBe("Wednesday · 21 October");
  });

  it("formats a points total with separators and a real minus sign", () => {
    expect(formatTotal(1240)).toBe("1,240");
    expect(formatTotal(-35)).toBe("−35");
    expect(formatTotal(0)).toBe("0");
  });

  it("keeps an h1 for screen readers and shows the greeting, the points and the rank", () => {
    const html = renderToStaticMarkup(<TodayHeader today={today} rankName="Koala" />);
    expect(html).toContain('<h1 class="sr-only" tabindex="-1">The Lazy Bookie</h1>');
    expect(html).toContain("Good morning");
    expect(html).toContain("1,240");
    expect(html).toContain("Koala");
    expect(html).toContain("points, ");
    expect(renderToStaticMarkup(<TodayHeader today={today} />)).toContain("1,240 pts");
  });

  it("AC-013.5: Gemma's status stays, as one quiet line, with a dot that is not the only cue", () => {
    const html = renderToStaticMarkup(
      <GemmaStatus gemma={{ status: "offline", detail: null, checked_at: today.now }} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Gemma is offline, rule odds only");
    expect(html).toContain('class="status-dot" aria-hidden="true"');
  });
});

describe("Week strip keeps every assumption one tap away (AC-011.5)", () => {
  it("puts the dates, both parts of net time and the assumptions under How we count", () => {
    const html = screen({
      ...today,
      week: {
        ...emptyWeek,
        totals: {
          ...emptyWeek.totals,
          bets: 2,
          wins: 1,
          time_saved_s: 600,
          app_time_s: 60,
          net_time_s: 540,
          assumptions: [
            { chore_type: "plants", assumption: "~5 L per watering", basis: "estimate", wins: 1 },
          ],
        },
      },
    });
    const details = html.slice(html.indexOf('<details class="week-notes"'));
    expect(details).toContain("<summary>How we count</summary>");
    expect(details).toContain("Monday 2026-10-19 to Sunday 2026-10-25");
    expect(details).toContain("10 min saved, minus 1 min spent on 2 bets.");
    expect(details).toContain("~5 L per watering (estimate), 1 won");
    expect(html).toContain("This week the sky did");
  });
});

describe("Capture bar (AC-002.1, AC-027.3)", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function typeInto(input: HTMLInputElement, value: string): void {
    act(() => {
      // React ignores a plain `.value =`; the prototype setter makes it see the change.
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value") as {
        set: (this: HTMLInputElement, value: string) => void;
      };
      descriptor.set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function submit(): Promise<void> {
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
  }

  it("submits the typed sentence (Enter or the button) and clears it once the cards were made", async () => {
    const onCapture = vi.fn(() => Promise.resolve(true));
    act(() => {
      root.render(<CaptureBar busy={false} onCapture={onCapture} />);
    });
    const input = container.querySelector("input") as HTMLInputElement;
    const send = container.querySelector("button[type=submit]") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    typeInto(input, "  water the basil and hang the washing ");
    expect(send.disabled).toBe(false);
    await submit();
    expect(onCapture).toHaveBeenCalledWith("water the basil and hang the washing");
    expect(input.value).toBe("");
  });

  it("keeps the sentence when the cards could not be made, so it can be rephrased", async () => {
    const onCapture = vi.fn(() => Promise.resolve(false));
    act(() => {
      root.render(<CaptureBar busy={false} onCapture={onCapture} />);
    });
    const input = container.querySelector("input") as HTMLInputElement;
    typeInto(input, "something odd");
    await submit();
    expect(input.value).toBe("something odd");
  });

  it("AC-027.3: shows a mic only through its slot, so no slot means no mic", () => {
    const without = renderToStaticMarkup(
      <CaptureBar busy={false} onCapture={() => Promise.resolve(true)} />,
    );
    expect(without).not.toContain("capture-tool");
    const withMic = renderToStaticMarkup(
      <CaptureBar
        busy={false}
        onCapture={() => Promise.resolve(true)}
        micSlot={
          <button type="button" className="capture-tool" aria-label="Say your chores">
            mic
          </button>
        }
      />,
    );
    // The slot sits between the text box and the submit button.
    expect(withMic.indexOf("<input")).toBeLessThan(withMic.indexOf("capture-tool"));
    expect(withMic.indexOf("capture-tool")).toBeLessThan(withMic.indexOf('type="submit"'));
  });

  it("scrolls the quick chips in one labelled row", () => {
    const html = renderToStaticMarkup(
      <QuickChips
        chips={[{ choreType: "plants", label: "Water plants" }]}
        busy={false}
        onPick={() => undefined}
      />,
    );
    expect(html).toContain('class="chip-row" role="group" aria-label="Quick chores"');
    expect(html).toContain("Water plants");
  });

  it("the screen passes the voice slots on to the capture bar and the tab bar", () => {
    const html = screen(today, {
      voiceControl: (
        <button type="button" className="capture-tool">
          mic-in-bar
        </button>
      ),
      voiceFab: (
        <button type="button" className="fab-button">
          mic-fab
        </button>
      ),
    });
    expect(html).toContain("mic-in-bar");
    expect(html).toContain("mic-fab");
    expect(screen(today)).not.toContain("tab-fab");
  });
});

describe("Tab bar with the raised centre button (mockup 02)", () => {
  const flags = { score: true, onboarding: true };

  it("is Today, Slips, button, Score, Household when the voice button exists", () => {
    const html = renderToStaticMarkup(
      <Nav flags={flags} fab={<button type="button">mic</button>} />,
    );
    const order = ["Today", "Slips", "tab-fab", "Score", "Household"].map((word) =>
      html.indexOf(word),
    );
    expect(order.every((position) => position > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("is plain four tabs without it", () => {
    const html = renderToStaticMarkup(<Nav flags={flags} />);
    expect(html).not.toContain("tab-fab");
    expect(html.match(/<li>/g)).toHaveLength(4);
  });
});

describe("A card without a bet (mockup 02)", () => {
  it("is a dashed muted card with a No bet pill, a reason and no percentage", () => {
    const card: Card = {
      id: 3,
      chore_type: "car",
      title: "Car",
      created_at: today.now,
      kind: "coming_later",
      alert_reason: null,
      notice: "Coming later",
      quote: null,
      gemma: null,
    };
    const html = screen({ ...today, cards: [card] });
    expect(html).toContain('class="slip no-bet"');
    expect(html).toContain('<span class="pill muted">No bet</span>');
    expect(html).toContain("Coming later");
    expect(html).not.toContain("Bet: do nothing");
  });
});

describe("Laundry planner tiles (mockup 02, REQ-021)", () => {
  const plan = {
    best_day: { date: "2026-10-20", weekday: "Tuesday" },
    days: [
      { date: "2026-10-20", weekday: "Tuesday", band: 4, band_name: "very likely", odds: 85 },
      { date: "2026-10-21", weekday: "Wednesday", band: 3, band_name: "likely", odds: 70 },
      { date: "2026-10-22", weekday: "Thursday", band: 1, band_name: "unlikely", odds: 35 },
    ],
  } as unknown as Plan;

  it("shows each day as a tile with plain words for screen readers and marks the best day", () => {
    const html = renderToStaticMarkup(<PlanDays plan={plan} />);
    expect(html).toContain("Very likely · 85%");
    expect(html).toContain("Likely · 70%");
    expect(html).toContain('<li class="best">');
    expect(html).toContain("best day");
    expect(html.match(/ lucide-sun /g)).toHaveLength(2);
    expect(html).toContain("lucide-cloud-rain");
  });
});

describe("Content-Security-Policy: no eval probe", () => {
  it("zod runs without compiling parsers, so the page needs no 'unsafe-eval'", () => {
    expect(z.core.globalConfig.jitless).toBe(true);
  });
});
