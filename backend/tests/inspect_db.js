
const Database = require("better-sqlite3");

const db = new Database("data/bitt.db");

try {
    console.log("\n=== Torrents Table Schema ===");

    console.table(
        db.prepare("PRAGMA table_info(torrents)").all()
    );

    console.log("\n=== Torrents Indexes ===");

    console.table(
        db.prepare("PRAGMA index_list(torrents)").all()
    );

    console.log("\n=== Index Definitions ===");

    console.table(
        db.prepare(`
            SELECT name, sql
            FROM sqlite_master
            WHERE type = 'index'
              AND tbl_name = 'torrents'
        `).all()
    );

} catch (error) {
    console.error("Inspection failed:", error);
} finally {
    db.close();
}
