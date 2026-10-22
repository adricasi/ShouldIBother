import { createHash } from "node:crypto";

import Database from "better-sqlite3";

export type Db = Database.Database;

/** One forward-only schema change. `id` is the migration number (0001 = 1). */
export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Opens the SQLite database. `path` is a file, or `:memory:` for tests. WAL lets the CLI
 * (`sib pair`, `sib forget-devices`) write while the server runs; `secure_delete` overwrites
 * deleted rows (design.md, Data protection).
 */
export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("secure_delete = ON");
  return db;
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * Applies the pending migrations in order, each in its own transaction, and records them in
 * `schema_migrations` with a checksum. Forward-only: there is no down step. It refuses to run
 * when an applied migration was edited afterwards, or when the database holds a migration
 * this code does not know (a newer build wrote it). Returns the ids it applied.
 */
export function migrate(db: Db, migrations: readonly Migration[]): number[] {
  const ids = migrations.map((migration) => migration.id);
  if (
    ids.some((id, index) => !Number.isInteger(id) || id < 1 || (index > 0 && id <= ids[index - 1]!))
  ) {
    throw new Error(
      `Migration ids must be positive and strictly increasing; got ${ids.join(", ")}`,
    );
  }
  const byId = new Map(migrations.map((migration) => [migration.id, migration]));

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Map(
    db
      .prepare<[], { id: number; checksum: string }>("SELECT id, checksum FROM schema_migrations")
      .all()
      .map((row) => [row.id, row.checksum]),
  );
  for (const [id, recorded] of applied) {
    const known = byId.get(id);
    if (known === undefined) {
      throw new Error(`Database has migration ${id} that this version does not know`);
    }
    if (recorded !== checksum(known.sql)) {
      throw new Error(`Migration ${id} (${known.name}) was edited after it was applied`);
    }
  }

  const record = db.prepare(
    "INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  const newlyApplied: number[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, migration.name, checksum(migration.sql), Date.now());
    })();
    newlyApplied.push(migration.id);
  }
  return newlyApplied;
}
