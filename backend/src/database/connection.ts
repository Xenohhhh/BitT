
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const databaseDirectory = path.resolve(process.cwd(), "data");

if (!fs.existsSync(databaseDirectory)) {
  fs.mkdirSync(databaseDirectory, { recursive: true });
}

const databasePath = path.join(databaseDirectory, "bitt.db");

export const db = new Database(databasePath);

// Enforce foreign-key constraints.
db.pragma("foreign_keys = ON");

// Improve reliability when multiple connections access the database.
db.pragma("journal_mode = WAL");

// Create the torrents table for fresh databases.
db.exec(`
  CREATE TABLE IF NOT EXISTS torrents (
    id TEXT PRIMARY KEY,
    engine_id INTEGER UNIQUE,
    name TEXT NOT NULL,
    torrent_path TEXT NOT NULL,
    save_path TEXT NOT NULL,

    info_hash_v1 TEXT,
    info_hash_v2 TEXT,

    desired_state TEXT NOT NULL DEFAULT 'paused'
      CHECK (desired_state IN ('paused', 'active')),

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// Migrate existing databases: engine_id must be nullable
// because engine IDs are recreated when the engine restarts.
const torrentColumns = db.pragma("table_info(torrents)") as {
  name: string;
  notnull: number;
}[];

const engineIdColumn = torrentColumns.find(
  (column) => column.name === "engine_id"
);

if (engineIdColumn?.notnull === 1) {
  const migrateEngineId = db.transaction(() => {
    db.exec(`
      ALTER TABLE torrents RENAME TO torrents_old;

      CREATE TABLE torrents (
        id TEXT PRIMARY KEY,
        engine_id INTEGER UNIQUE,
        name TEXT NOT NULL,
        torrent_path TEXT NOT NULL,
        save_path TEXT NOT NULL,

        info_hash_v1 TEXT,
        info_hash_v2 TEXT,

        desired_state TEXT NOT NULL DEFAULT 'paused'
          CHECK (desired_state IN ('paused', 'active')),

        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO torrents (
        id,
        engine_id,
        name,
        torrent_path,
        save_path,
        desired_state,
        created_at,
        updated_at
      )
      SELECT
        id,
        engine_id,
        name,
        torrent_path,
        save_path,
        desired_state,
        created_at,
        updated_at
      FROM torrents_old;

      DROP TABLE torrents_old;
    `);
  });

  migrateEngineId();
}

// Add info-hash columns to databases that already have the torrents table.
const updatedTorrentColumns = db.pragma("table_info(torrents)") as {
  name: string;
}[];

const updatedColumnNames = updatedTorrentColumns.map(
  (column) => column.name
);

if (!updatedColumnNames.includes("info_hash_v1")) {
  db.exec(`
    ALTER TABLE torrents
    ADD COLUMN info_hash_v1 TEXT;
  `);
}

if (!updatedColumnNames.includes("info_hash_v2")) {
  db.exec(`
    ALTER TABLE torrents
    ADD COLUMN info_hash_v2 TEXT;
  `);
}

export function closeDatabase(): void {
  db.close();
}
