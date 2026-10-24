import { buildWeatherBoard } from "../../domain/weather-board.js";

import type { LedgerDeps } from "./deps.js";

/**
 * The weather board of Today (flag `splitFlap`, REQ-026), as the client reads it. It uses the
 * newest cached forecast and makes no Open-Meteo call; null when there is none (no card has been
 * priced yet, the cache is older than 24 h, or the client keeps no cache).
 */
export function weatherBoardView(
  deps: Pick<LedgerDeps, "weather" | "rules" | "now">,
  /**
   * The household's place label (AC-026.3), given only while `onboarding` is on. It is text for
   * the board's header: it comes from the stored profile, never from a forecast or a prompt.
   */
  placeLabel: string | null = null,
) {
  const forecast = deps.weather.latestForecast?.();
  const board =
    forecast === undefined ? null : buildWeatherBoard(forecast.hours, deps.now(), deps.rules);
  if (board === null) {
    return null;
  }
  return {
    temperature_c: board.temperatureC,
    condition: board.condition,
    rain_pct: board.rainPct,
    wind_kmh: board.windKmh,
    hours: board.hours.map((hour) => ({ hour: hour.hour, level: hour.level, lazy: hour.lazy })),
    lazy_window: board.lazyWindow,
    ...(placeLabel === null ? {} : { place_label: placeLabel }),
  };
}

export type WeatherBoardView = NonNullable<ReturnType<typeof weatherBoardView>>;
