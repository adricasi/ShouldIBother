// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { todaySchema, type Today, type WeatherBoard as BoardData } from "./api.js";
import { emptyWeek } from "./test-data.js";
import { SplitFlapTile } from "./ui/SplitFlap.js";
import { TodayScreen } from "./TodayScreen.js";
import { WeatherBoard } from "./WeatherBoard.js";

const ATTRIBUTION = "Weather data by Open-Meteo.com (https://open-meteo.com/), licensed CC BY 4.0.";

const board: BoardData = {
  temperature_c: 21,
  condition: "Sunny",
  rain_pct: 10,
  wind_kmh: 18,
  hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((hour) => ({
    hour,
    level: hour === 9 ? 0.2 : 0.9,
    lazy: hour >= 10 && hour < 18,
  })),
  lazy_window: { from: "10:00", to: "18:00" },
};

const today: Today = {
  now: "2026-10-22T07:41:00.000Z",
  flags: {},
  points: { total: 0 },
  gemma: { status: "online", detail: null, checked_at: "2026-10-22T07:41:00.000Z" },
  forecast: null,
  week: emptyWeek,
  attribution: ATTRIBUTION,
  cards: [],
  open_bets: [],
  due_bets: [],
};

function todayHtml(value: Today): string {
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
    />,
  );
}

const withBoard = (flags: Today["flags"], data: BoardData | null | undefined): Today => ({
  ...today,
  flags,
  ...(data === undefined ? {} : { weather_board: data }),
});

describe("AC-026.1: Today shows the weather board with split-flap tiles and hourly bars", () => {
  it("shows the temperature and the condition as tiles, named once for screen readers", () => {
    const html = todayHtml(withBoard({ splitFlap: true }, board));
    expect(html).toContain('id="weather-board-title"');
    // 2, 1 and ° on large tiles; SUNNY on small ones.
    expect(html.match(/<span class="flap large" aria-hidden="true">/g)).toHaveLength(3);
    expect(html).toMatch(/<span class="flap large" aria-hidden="true">2<\/span>/);
    expect(html).toMatch(/<span class="flap large" aria-hidden="true">°<\/span>/);
    expect(html.match(/<span class="flap small" aria-hidden="true">/g)).toHaveLength(5);
    expect(html).toContain('<span class="flap-sr">21 degrees</span>');
    expect(html).toContain('<span class="flap-sr">Sunny</span>');
    expect(html).toContain("Rain 10%");
    expect(html).toContain("Wind");
    expect(html).toContain("18 km/h");
  });

  it("marks the lazy hours and states the lazy window in words", () => {
    const html = todayHtml(withBoard({ splitFlap: true }, board));
    expect(html.match(/class="bar lazy"/g)).toHaveLength(8);
    expect(html.match(/class="bar"/g)).toHaveLength(3);
    expect(html).toContain("Lazy window 10:00 to 18:00");
    expect(html).toContain(
      'aria-label="Hourly drying conditions from 09:00 to 20:00; taller is better. Lazy window 10:00 to 18:00."',
    );
  });

  it("says so when no lazy hour is left, and negative temperatures keep their sign", () => {
    const html = todayHtml(
      withBoard(
        { splitFlap: true },
        {
          ...board,
          temperature_c: -3,
          lazy_window: null,
          hours: board.hours.map((hour) => ({ ...hour, lazy: false })),
        },
      ),
    );
    expect(html).toContain("No lazy window left today");
    expect(html).not.toContain("bar lazy");
    expect(html).toContain('<span class="flap-sr">-3 degrees</span>');
    expect(html).toMatch(/<span class="flap large" aria-hidden="true">-<\/span>/);
  });

  it("shows unknown values in words, not as zero", () => {
    const html = todayHtml(
      withBoard(
        { splitFlap: true },
        { ...board, temperature_c: null, rain_pct: null, wind_kmh: null, hours: [] },
      ),
    );
    expect(html).toContain("Temperature unknown");
    expect(html).toContain("Rain unknown");
    expect(html).toContain("Wind unknown");
    expect(html).not.toContain('class="bars"');
  });

  it("has an empty state until a forecast is cached", () => {
    const html = todayHtml(withBoard({ splitFlap: true }, null));
    expect(html).toContain("No forecast yet");
    expect(html).not.toContain("flap");
    // An older server that sends no field at all reads the same as null.
    expect(todayHtml(withBoard({ splitFlap: true }, undefined))).toContain("No forecast yet");
  });

  it("AC-014.6: the board carries no attribution of its own; the foot of Today has the one", () => {
    const html = todayHtml(withBoard({ splitFlap: true }, board));
    expect(html.split(ATTRIBUTION)).toHaveLength(2);
    expect(html).toContain(`<p class="meta attribution">${ATTRIBUTION}</p>`);
    expect(html.indexOf(ATTRIBUTION)).toBeGreaterThan(html.indexOf("weather-board"));
    expect(
      renderToStaticMarkup(<WeatherBoard board={board} now={today.now} forecast={null} />),
    ).not.toContain("Open-Meteo");
  });

  it("a fresh forecast reads 'Now'; one older than an hour says how old it is", () => {
    const fresh = {
      ...today,
      flags: { splitFlap: true },
      weather_board: board,
      forecast: {
        fetched_at: "2026-10-22T07:00:00.000Z",
        age_label: "Forecast from 41 min ago",
        stale: false,
      },
    };
    expect(todayHtml(fresh)).toContain("Now 09:41");
    const stale = {
      ...fresh,
      forecast: {
        fetched_at: "2026-10-22T04:00:00.000Z",
        age_label: "Forecast from 3 h ago",
        stale: true,
      },
    };
    const html = todayHtml(stale);
    expect(html).not.toContain("Now 09:41");
    expect(html).toMatch(/<p class="eyebrow board-live">Forecast from 3 h ago<\/p>/);
    // The board itself carries the note, so the page has no second forecast line outside it.
    expect(html).toContain("Open-Meteo could not be reached for a newer forecast.");
    expect(html.indexOf("forecast-age")).toBeGreaterThan(html.indexOf("weather-board"));
  });

  it("the board comes after the week strip and before the chip list", () => {
    const html = todayHtml(withBoard({ splitFlap: true }, board));
    expect(html.indexOf("week-title")).toBeLessThan(html.indexOf("weather-board"));
    expect(html.indexOf("weather-board")).toBeLessThan(html.indexOf("chips-title"));
  });

  it("AC-014.3: the board says how old the forecast is, also while it has nothing to draw yet", () => {
    const forecast = {
      fetched_at: "2026-10-22T07:00:00.000Z",
      age_label: "Forecast from 41 min ago",
      stale: false,
    };
    const empty = renderToStaticMarkup(
      <WeatherBoard board={null} now={today.now} forecast={forecast} />,
    );
    expect(empty).toContain("No forecast yet");
    expect(empty).toContain("Forecast from 41 min ago");
    const stale = renderToStaticMarkup(
      <WeatherBoard board={null} now={today.now} forecast={{ ...forecast, stale: true }} />,
    );
    expect(stale).toContain("Open-Meteo could not be reached for a newer forecast.");
  });

  it("the API schema accepts the server's board, null, and no field", () => {
    const base = { ...today };
    expect(todaySchema.parse({ ...base, weather_board: board }).weather_board).toEqual(board);
    expect(todaySchema.parse({ ...base, weather_board: null }).weather_board).toBeNull();
    expect(todaySchema.parse(base).weather_board).toBeUndefined();
  });
});

describe("REQ-029: with the splitFlap flag off Today is unchanged", () => {
  it("renders the same markup as without a board, whatever the server sent", () => {
    const plain = todayHtml(withBoard({}, undefined));
    expect(todayHtml(withBoard({ splitFlap: false }, board))).toBe(plain);
    expect(todayHtml(withBoard({}, board))).toBe(plain);
    expect(plain).not.toContain("weather-board");
    expect(plain).not.toContain("flap");
  });
});

describe("AC-026.2: tiles flip on change, and not while the device prefers reduced motion", () => {
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
    vi.unstubAllGlobals();
  });

  const tile = (): HTMLElement => container.querySelector<HTMLElement>(".flap")!;
  const show = (char: string): void => {
    act(() => {
      root.render(<SplitFlapTile char={char} />);
    });
  };
  const preferReducedMotion = (reduced: boolean): void => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: reduced && query.includes("prefers-reduced-motion: reduce"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  };

  it("does not flip when it first appears", () => {
    preferReducedMotion(false);
    show("2");
    expect(tile().textContent).toBe("2");
    expect(tile().className).toBe("flap large");
  });

  it("flips when the character changes", () => {
    preferReducedMotion(false);
    show("2");
    show("3");
    expect(tile().textContent).toBe("3");
    expect(tile().classList.contains("flap-flip")).toBe(true);
  });

  it("changes the character with no flip class while reduced motion is preferred", () => {
    preferReducedMotion(true);
    show("2");
    show("3");
    show("4");
    expect(tile().textContent).toBe("4");
    expect(tile().classList.contains("flap-flip")).toBe(false);
  });

  it("without matchMedia (no preference known) the tile still works and flips", () => {
    show("2");
    show("3");
    expect(tile().textContent).toBe("3");
    expect(tile().classList.contains("flap-flip")).toBe(true);
  });
});
