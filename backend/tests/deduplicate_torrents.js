
const Database = require("better-sqlite3");

const db = new Database("data/bitt.db");

const canonicalId = "46f4bba1-f88f-42e1-b87e-9a9cab3150ae";

const ubuntuInfoHash = "5b1e0d988fc7a0c9e99bd852071681a59974b39f";

const transaction = db.transaction(() => {
    // Verify the expected records before making changes.
    const records = db.prepare(`
        SELECT *
        FROM torrents
        ORDER BY created_at ASC
    `).all();

    if (records.length !== 6) {
        throw new Error(
            `Expected 6 torrent records, found ${records.length}. Aborting.`
        );
    }

    const canonical = records.find(
        (record) => record.id === canonicalId
    );

    if (!canonical) {
        throw new Error("Canonical torrent record not found.");
    }

    // Verify that all six records refer to the same torrent.
    const allSameTorrent = records.every(
        (record) =>
            record.name === canonical.name &&
            record.torrent_path === canonical.torrent_path &&
            record.save_path === canonical.save_path
    );

    if (!allSameTorrent) {
        throw new Error(
            "Records do not all refer to the same torrent. Aborting."
        );
    }

    // Populate the canonical record and clear its stale engine ID.
    db.prepare(`
        UPDATE torrents
        SET
            engine_id = NULL,
            info_hash_v1 = ?,
            info_hash_v2 = NULL,
            updated_at = ?
        WHERE id = ?
    `).run(
        ubuntuInfoHash,
        new Date().toISOString(),
        canonicalId
    );

    // Remove the other five duplicate records.
    const deletion = db.prepare(`
        DELETE FROM torrents
        WHERE id != ?
    `).run(canonicalId);

    if (deletion.changes !== 5) {
        throw new Error(
            `Expected to delete 5 duplicates, deleted ${deletion.changes}.`
        );
    }

    // Prevent duplicate v1 and v2 info hashes.
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_torrents_info_hash_v1
        ON torrents(info_hash_v1)
        WHERE info_hash_v1 IS NOT NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_torrents_info_hash_v2
        ON torrents(info_hash_v2)
        WHERE info_hash_v2 IS NOT NULL;
    `);
});

try {
    transaction();

    console.log("Torrent deduplication completed successfully.");
    console.log("Deleted duplicate records: 5");
    console.log("Canonical record retained:", canonicalId);
    console.log("v1 unique index created.");
    console.log("v2 unique index created.");

    const remaining = db.prepare(`
        SELECT *
        FROM torrents
    `).all();

    console.table(remaining);

    console.log("\nDatabase indexes:");

    console.table(
        db.prepare("PRAGMA index_list(torrents)").all()
    );
} catch (error) {
    console.error("Deduplication failed:", error.message);
    console.error("Transaction rolled back. Database unchanged.");
    process.exitCode = 1;
} finally {
    db.close();
}
