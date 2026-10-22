import type { Migration } from "../db.js";

/**
 * Migration 0002 (T-004, REQ-004, REQ-006, REQ-008, REQ-009, REQ-013, NFR-003): the core schema
 * from design.md "Data model". Times are epoch milliseconds. Children of a card or bet are removed
 * with it (AC-015.2 deletes need no extra code), and `gemma_decisions` keeps the card, bet and
 * photo ids so a photo's decisions can be found and deleted.
 *
 * `bets.reason` is not in the design's field list but AC-006.1 locks the reason shown at bet time,
 * so the bet carries its own copy: a later delete of the quote must not change the locked slip.
 */
export const coreSchema: Migration = {
  id: 2,
  name: "core_schema",
  sql: `
CREATE TABLE cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  input_text  TEXT    NOT NULL,
  chore_type  TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('weather', 'not_weather', 'coming_later', 'alert')),
  alert_reason TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE bets (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id            INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  kind               TEXT    NOT NULL CHECK (kind IN ('do_nothing', 'do_it')),
  band               INTEGER NOT NULL CHECK (band BETWEEN 0 AND 4),
  odds               INTEGER NOT NULL CHECK (odds IN (15, 35, 50, 70, 85)),
  odds_source        TEXT    NOT NULL CHECK (odds_source IN ('rule', 'gemma')),
  reason             TEXT    NOT NULL,
  gemma_band         INTEGER CHECK (gemma_band BETWEEN 0 AND 4),
  rule_band          INTEGER NOT NULL CHECK (rule_band BETWEEN 0 AND 4),
  band_without_photo INTEGER CHECK (band_without_photo BETWEEN 0 AND 4),
  model_version      TEXT,
  prompt_version     TEXT,
  savings_snapshot   TEXT,
  placed_at          INTEGER NOT NULL,
  undo_until         INTEGER NOT NULL,
  settle_at          INTEGER NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'due', 'awaiting_weather', 'awaiting_gemma', 'settled', 'undone', 'cashed_out'
  ))
);
CREATE INDEX bets_status_settle_at ON bets (status, settle_at);
CREATE INDEX bets_card_id ON bets (card_id);

CREATE TABLE photos (
  id          TEXT    PRIMARY KEY,
  card_id     INTEGER REFERENCES cards(id) ON DELETE CASCADE,
  bet_id      INTEGER REFERENCES bets(id) ON DELETE CASCADE,
  role        TEXT    NOT NULL CHECK (role IN ('before', 'after', 'appeal')),
  file        TEXT    NOT NULL,
  received_at INTEGER NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL
);

CREATE TABLE gemma_decisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job            TEXT    NOT NULL,
  card_id        INTEGER REFERENCES cards(id) ON DELETE CASCADE,
  bet_id         INTEGER REFERENCES bets(id) ON DELETE CASCADE,
  photo_id       TEXT    REFERENCES photos(id) ON DELETE CASCADE,
  model          TEXT    NOT NULL,
  model_digest   TEXT,
  prompt_version TEXT    NOT NULL,
  tool_mode      TEXT    CHECK (tool_mode IN ('called', 'injected', 'missed')),
  input_summary  TEXT,
  output         TEXT,
  valid          INTEGER NOT NULL CHECK (valid IN (0, 1)),
  retries        INTEGER NOT NULL DEFAULT 0,
  latency_ms     INTEGER NOT NULL,
  error          TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX gemma_decisions_job ON gemma_decisions (job, created_at);

CREATE TABLE quotes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  source      TEXT    NOT NULL CHECK (source IN ('rule', 'gemma')),
  band        INTEGER NOT NULL CHECK (band BETWEEN 0 AND 4),
  odds        INTEGER NOT NULL CHECK (odds IN (15, 35, 50, 70, 85)),
  with_photo  INTEGER NOT NULL DEFAULT 0 CHECK (with_photo IN (0, 1)),
  reason      TEXT    NOT NULL,
  settle_at   INTEGER NOT NULL,
  decision_id INTEGER REFERENCES gemma_decisions(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX quotes_card_id ON quotes (card_id, id);

CREATE TABLE settlements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_id      INTEGER NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  evidence    TEXT    NOT NULL CHECK (evidence IN ('photo', 'tap', 'auto')),
  multiplier  REAL    NOT NULL,
  verdict     TEXT    NOT NULL CHECK (verdict IN (
    'win', 'small_loss', 'normal_loss', 'harmful_loss', 'weather_would_have', 'weather_would_not'
  )),
  lucky_win   INTEGER CHECK (lucky_win IN (0, 1)),
  weather     TEXT,
  decision_id INTEGER REFERENCES gemma_decisions(id) ON DELETE SET NULL,
  points      INTEGER NOT NULL,
  settled_at  INTEGER NOT NULL,
  appeal_of   INTEGER REFERENCES settlements(id) ON DELETE CASCADE,
  final       INTEGER NOT NULL DEFAULT 1 CHECK (final IN (0, 1))
);
CREATE INDEX settlements_bet_id ON settlements (bet_id);

CREATE TABLE weather_cache (
  key        TEXT    PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  body       TEXT    NOT NULL
);
`,
};
