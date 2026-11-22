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