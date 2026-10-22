import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import flagsSource from "../../config/flags.json?raw";

import type { Today } from "./api.js";
import { ReceiptCard } from "./SettleParts.js";
import { isStampAnimated, stampClassName } from "./stamp.js";
import { emptyWeek, lossReceipt, winReceipt } from "./test-data.js";
import { TodayScreen } from "./TodayScreen.js";

const today: Today = {
  now: "2026-10-22T08:00:00.000Z",
  flags: {},
  points: { total: 0 },
  gemma: { status: "online", detail: null, checked_at: "2026-10-22T08:00:00.000Z" },
  forecast: null,
  week: emptyWeek,
  attribution: "Weather data by Open-Meteo.com",
  cards: [],
  open_bets: [],
  due_bets: [],
};

function todayHtml(flags: Today["flags"]): string {
  return renderToStaticMarkup(
    <TodayScreen
      today={{ ...today, flags }}
      busy={false}
      notice={undefined}
      results={{ [winReceipt.bet_id]: winReceipt }}
      nowMs={Date.parse("2026-10-22T08:01:00.000Z")}
      onQuickCard={() => undefined}
      onCapture={() => Promise.resolve(true)}
      onRetry={() => undefined}
      onAnswer={() => undefined}
      onBet={() => undefined}
      onDoIt={() => undefined}
      onUndo={() => undefined}
      onSettle={() => undefined}
    />,
  );
}

describe("T-017: the stamp animation flag", () => {
  it("the Today screen follows the flag from /api/today", () => {
    expect(todayHtml({ stampAnimation: true })).toContain("stamp stamp-animated");
    expect(todayHtml({ stampAnimation: false })).not.toContain("stamp-animated");
    expect(todayHtml({})).not.toContain("stamp-animated");
  });

  it("the flag is off by default and only an explicit true turns the animation on", () => {
    const flags = JSON.parse(flagsSource) as Record<string, boolean>;
    expect(flags["stampAnimation"]).toBe(false);
    expect(isStampAnimated({})).toBe(false);
    expect(isStampAnimated({ stampAnimation: false })).toBe(false);
    expect(isStampAnimated({ stampAnimation: true })).toBe(true);
  });

  it("with the flag off the stamp renders unchanged from T-009 (static class only)", () => {
    const html = renderToStaticMarkup(<ReceiptCard receipt={winReceipt} />);
    expect(html).toContain('<p class="stamp">PAID OUT</p>');
    expect(html).not.toContain("stamp-animated");
    expect(stampClassName(false)).toBe("stamp");
  });

  it("with the flag on the same stamp element gets the animation class", () => {
    const html = renderToStaticMarkup(<ReceiptCard receipt={winReceipt} animateStamp />);
    expect(html).toContain('<p class="stamp stamp-animated">PAID OUT</p>');
    expect(html.match(/PAID OUT<\/p>/g)).toHaveLength(1);
  });

  it("a loss has no stamp even with the flag on", () => {
    const html = renderToStaticMarkup(<ReceiptCard receipt={lossReceipt} animateStamp />);
    expect(html).not.toContain("stamp");
  });
});
