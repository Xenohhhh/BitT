
import { db } from "../database/connection.js";

export type TorrentDesiredState = "paused" | "active";

export interface TorrentRecord {
  id: string;
  engine_id: number | null;
  name: string;
  torrent_path: string;
  save_path: string;
  info_hash_v1: string | null;
  info_hash_v2: string | null;
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
  info_hash_v1: string | null;
  info_hash_v2: string | null;
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
      info_hash_v1,
      info_hash_v2,
      desired_state,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'paused', ?, ?)
  `);

  statement.run(
    torrent.id,
    torrent.engine_id,
    torrent.name,
    torrent.torrent_path,
    torrent.save_path,
    torrent.info_hash_v1,
    torrent.info_hash_v2,
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

export function findByInfoHashV1(
  infoHashV1: string
): TorrentRecord | undefined {
  const statement = db.prepare(`
    SELECT *
    FROM torrents
    WHERE info_hash_v1 = ?
  `);

  return statement.get(infoHashV1) as TorrentRecord | undefined;
}

export function findByInfoHashV2(
  infoHashV2: string
): TorrentRecord | undefined {
  const statement = db.prepare(`
    SELECT *
    FROM torrents
    WHERE info_hash_v2 = ?
  `);

  return statement.get(infoHashV2) as TorrentRecord | undefined;
}

export function findByInfoHashes(
  infoHashV1: string | null,
  infoHashV2: string | null
): TorrentRecord | undefined {
  if (!infoHashV1 && !infoHashV2) {
    throw new Error("At least one info hash must be provided");
  }

  if (infoHashV1 && infoHashV2) {
    const statement = db.prepare(`
      SELECT *
      FROM torrents
      WHERE info_hash_v1 = ?
         OR info_hash_v2 = ?
      LIMIT 1
    `);

    return statement.get(
      infoHashV1,
      infoHashV2
    ) as TorrentRecord | undefined;
  }

  if (infoHashV1) {
    return findByInfoHashV1(infoHashV1);
  }

  return findByInfoHashV2(infoHashV2!);
}

export function updateInfoHashes(
  id: string,
  infoHashV1: string | null,
  infoHashV2: string | null
): boolean {
  const statement = db.prepare(`
    UPDATE torrents
    SET info_hash_v1 = ?,
        info_hash_v2 = ?
    WHERE id = ?
  `);

  const result = statement.run(
    infoHashV1,
    infoHashV2,
    id
  );

  return result.changes > 0;
}

export function findAll(): TorrentRecord[] {
  const statement = db.prepare(`
    SELECT *
    FROM torrents
    ORDER BY created_at DESC
  `);

  return statement.all() as TorrentRecord[];
}

export function updateEngineId(
  id: string,
  engineId: number
): boolean {
  const statement = db.prepare(`
    UPDATE torrents
    SET engine_id = ?,
        updated_at = ?
    WHERE id = ?
  `);

  const result = statement.run(
    engineId,
    new Date().toISOString(),
    id
  );

  return result.changes > 0;
}

export function clearEngineIds(): void {
  const statement = db.prepare(`
    UPDATE torrents
    SET engine_id = NULL
  `);

  statement.run();
}

export function clearEngineId(id: string): boolean {
  const statement = db.prepare(`
    UPDATE torrents
    SET engine_id = NULL
    WHERE id = ?
  `);

  const result = statement.run(id);

  return result.changes > 0;
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
