import type { Migration } from "../db.js";

/**
 * Migration 0016 (T-035, REQ-028, AC-028.4): what the `get_forecast` tool returned to Gemma, kept
 * with the decision so the "How Gemma decided" disclosure can show the numbers Gemma read.
 * A compact JSON list of hours (time, rain, chance of rain, temperature, wind, sunshine), at most
 * 24 rows, taken from the tool result the model was given; null on every older decision and on
 * jobs without the tool. It is public weather data, and the row's cascades (AC-015.2) take it
 * away with the decision. No household text goes in it.
 */
export const decisionToolResult: Migration = {
  id: 16,
  name: "decision_tool_result",
  sql: `
ALTER TABLE gemma_decisions ADD COLUMN tool_result TEXT;
`,
};
