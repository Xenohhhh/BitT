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