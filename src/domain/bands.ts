/** Ordinal odds band, 0 (very unlikely) to 4 (very likely); see `config/rules.json`. */
export type Band = 0 | 1 | 2 | 3 | 4;

export const BANDS: readonly Band[] = [0, 1, 2, 3, 4];

export function isBand(value: unknown): value is Band {
  return typeof value === "number" && BANDS.some((band) => band === value);
}

/** The odds (percent chance that doing nothing works) each band stands for. */
export interface BandTable {
  readonly names: readonly [string, string, string, string, string];
  readonly odds: readonly [number, number, number, number, number];
}

export function oddsOfBand(table: BandTable, band: Band): number {
  return table.odds[band];
}

export function nameOfBand(table: BandTable, band: Band): string {
  return table.names[band];
}
