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


db.exec(`
  CREATE TABLE IF NOT EXISTS torrents (
    id TEXT PRIMARY KEY,
    engine_id INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    torrent_path TEXT NOT NULL,
    save_path TEXT NOT NULL,

    desired_state TEXT NOT NULL DEFAULT 'paused'
      CHECK (desired_state IN ('paused', 'active')),

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);


export function closeDatabase(): void {
  db.close();
}
