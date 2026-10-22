import { describe, expect, it } from "vitest";

import { migrate, openDatabase, type Migration } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

const createA: Migration = { id: 1, name: "a", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);" };
const createB: Migration = { id: 2, name: "b", sql: "CREATE TABLE b (id INTEGER PRIMARY KEY);" };

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

describe("migration runner", () => {
  it("applies migrations in order and records them", () => {
    const db = openDatabase(":memory:");
    expect(migrate(db, [createA, createB])).toEqual([1, 2]);
    expect(tableNames(db)).toEqual(expect.arrayContaining(["a", "b", "schema_migrations"]));
    expect(db.prepare("SELECT id, name FROM schema_migrations ORDER BY id").all()).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
  });

  it("applies only the pending migrations and keeps existing rows", () => {
    const db = openDatabase(":memory:");
    migrate(db, [createA]);
    db.prepare("INSERT INTO a (id) VALUES (7)").run();
    expect(migrate(db, [createA, createB])).toEqual([2]);
    expect(migrate(db, [createA, createB])).toEqual([]);
    expect(db.prepare("SELECT id FROM a").all()).toEqual([{ id: 7 }]);
  });

  it("rolls back a failing migration completely and leaves earlier ones applied", () => {
    const db = openDatabase(":memory:");
    const broken: Migration = {
      id: 2,
      name: "broken",
      sql: "CREATE TABLE half (id INTEGER); CREATE TABLE a (id INTEGER);",
    };
    expect(() => migrate(db, [createA, broken])).toThrow();
    expect(tableNames(db)).not.toContain("half");
    expect(db.prepare("SELECT id FROM schema_migrations").all()).toEqual([{ id: 1 }]);
  });

  it("refuses a migration that was edited after it was applied", () => {
    const db = openDatabase(":memory:");
    migrate(db, [createA]);
    expect(() =>
      migrate(db, [{ ...createA, sql: "CREATE TABLE a (id INTEGER, extra TEXT);" }]),
    ).toThrow("edited after it was applied");
  });

  it("refuses a database written by a newer build", () => {
    const db = openDatabase(":memory:");
    migrate(db, [createA, createB]);
    expect(() => migrate(db, [createA])).toThrow("does not know");
  });

  it.each([
    ["a duplicate id", [createA, createA]],
    ["a descending order", [createB, createA]],
    ["id 0", [{ ...createA, id: 0 }]],
  ])("rejects %s", (_label, migrations) => {
    expect(() => migrate(openDatabase(":memory:"), migrations)).toThrow("strictly increasing");
  });
});

describe("migration 0001", () => {
  it("creates pairing and sessions with the designed columns", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    const columns = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (column) => column.name,
      );
    expect(columns("pairing")).toEqual(
      expect.arrayContaining([
        "token_hash",
        "created_at",
        "expires_at",
        "revoked_at",
        "sessions_created",
      ]),
    );
    expect(columns("sessions")).toEqual(
      expect.arrayContaining(["id_hash", "created_at", "expires_at", "last_seen_at", "revoked_at"]),
    );
  });

  it("caps sessions_created at 3 in the schema as well", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    expect(() =>
      db
        .prepare(
          "INSERT INTO pairing (token_hash, created_at, expires_at, sessions_created) VALUES ('h', 1, 2, 4)",
        )
        .run(),
    ).toThrow();
  });

  it("numbers the migrations from 1 in order", () => {
    expect(MIGRATIONS.map((migration) => migration.id)).toEqual(
      MIGRATIONS.map((_m, index) => index + 1),
    );
  });
});
