// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Today } from "./api.js";
import { emptyWeek } from "./test-data.js";
import { TodayScreen } from "./TodayScreen.js";

const today = (gemma: Partial<Today["gemma"]>): Today => ({
  now: "2026-10-22T08:00:00.000Z",
  flags: {},
  points: { total: 0 },
  gemma: { status: "online", detail: null, checked_at: "2026-10-22T08:00:00.000Z", ...gemma },
  forecast: null,
  week: emptyWeek,
  attribution: "Weather data by Open-Meteo.com",
  cards: [],
  open_bets: [],
  due_bets: [],
});

const screen = (value: Today) =>
  renderToStaticMarkup(
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
    />,
  );

describe("REQ-019: the Gemma status warns when the fine-tuned bookmaker cannot answer", () => {
  it("shows the warning next to Gemma is online", () => {
    const html = screen(
      today({
        warning:
          "The fine-tuned bookmaker is not available (not pulled), so its cards use rule odds.",
      }),
    );
    expect(html).toContain("Gemma is online");
    expect(html).toContain("The fine-tuned bookmaker is not available");
  });

  it("shows nothing extra without a warning", () => {
    expect(screen(today({}))).not.toContain("fine-tuned");
  });
});
