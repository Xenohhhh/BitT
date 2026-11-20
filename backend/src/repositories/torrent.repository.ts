import { db } from "../database/connection.js";

export type TorrentDesiredState = "paused" | "active";

export interface TorrentRecord {
  id: string;
  engine_id: number;
  name: string;
  torrent_path: string;
  save_path: string;
  desired_state: TorrentDesiredState;
  created_at: string;
  updated_at: string;
}

export interface NewTorrentRecord {
  id: string;
  engine_id: number;
  name: string;
  torrent_path: string;
  save_path: string;
}

export function create(
  torrent: NewTorrentRecord
): TorrentRecord {
  const now = new Date().toISOString();

  const statement = db.prepare(`
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
    VALUES (?, ?, ?, ?, ?, 'paused', ?, ?)
  `);

  statement.run(
    torrent.id,
    torrent.engine_id,
    torrent.name,
    torrent.torrent_path,
    torrent.save_path,
    now,
    now
  );

  const created = findById(torrent.id);

  if (!created) {
    throw new Error("Failed to retrieve created torrent");
  }

  return created;
}

export function findById(
  id: string
): TorrentRecord | undefined {
  const statement = db.prepare(`
    SELECT *
    FROM torrents
    WHERE id = ?
  `);

  return statement.get(id) as TorrentRecord | undefined;
}

export function findByEngineId(
  engineId: number
): TorrentRecord | undefined {
  const statement = db.prepare(`
    SELECT *
    FROM torrents
    WHERE engine_id = ?
  `);

  return statement.get(engineId) as TorrentRecord | undefined;
}

export function findAll(): TorrentRecord[] {
  const statement = db.prepare(`
    SELECT *
    FROM torrents
    ORDER BY created_at DESC
  `);

  return statement.all() as TorrentRecord[];
}

export function updateDesiredState(
  id: string,
  state: TorrentDesiredState
): boolean {
  const statement = db.prepare(`
    UPDATE torrents
    SET desired_state = ?,
        updated_at = ?
    WHERE id = ?
  `);

  const result = statement.run(
    state,
    new Date().toISOString(),
    id
  );

  return result.changes > 0;
}

export function deleteById(id: string): boolean {
  const statement = db.prepare(`
    DELETE FROM torrents
    WHERE id = ?
  `);

  const result = statement.run(id);

  return result.changes > 0;
}
