const net = require("net");

const TOKEN = process.env.BITT_IPC_TOKEN;

const TORRENT_PATH =
    "C:\\Users\\stvks\\Downloads\\Practice\\New folder\\BitT\\test-data\\ubuntu.torrent";

const SAVE_PATH =
    "C:\\Users\\stvks\\Downloads\\Practice\\New folder\\BitT\\test-downloads\\ubuntu-pause-test";

const POLL_INTERVAL = 2000;
const PAUSE_THRESHOLD = 0.03; // 3%
const TORRENT_SIZE = 6482409472;

if (!TOKEN) {
    console.error("BITT_IPC_TOKEN is not set");
    process.exit(1);
}

let requestId = 1;
let torrentId;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        let buffer = Buffer.alloc(0);
        let completed = false;

        const timeout = setTimeout(() => {
            finish(reject, new Error(`${method} timed out`));
        }, 10000);

        function finish(callback, value) {
            if (completed) return;

            completed = true;
            clearTimeout(timeout);
            client.destroy();
            callback(value);
        }

        client.connect(5000, "127.0.0.1", () => {
            const request = {
                jsonrpc: "2.0",
                id: requestId++,
                method,
                params,
                token: TOKEN
            };

            const body = Buffer.from(JSON.stringify(request));
            const header = Buffer.alloc(4);
            header.writeUInt32BE(body.length);

            client.write(Buffer.concat([header, body]));
        });

        client.on("data", data => {
            buffer = Buffer.concat([buffer, data]);

            if (buffer.length < 4) return;

            const length = buffer.readUInt32BE(0);

            if (buffer.length < 4 + length) return;

            try {
                const response = JSON.parse(
                    buffer.subarray(4, 4 + length).toString()
                );

                if (response.error) {
                    finish(
                        reject,
                        new Error(response.error.message)
                    );
                    return;
                }

                finish(resolve, response.result);
            } catch (err) {
                finish(reject, err);
            }
        });

        client.on("error", err => finish(reject, err));
    });
}

async function getStatus() {
    return await sendRequest("get_torrent_status", {
        torrentId
    });
}

function printStatus(status) {
    console.log(
        `Progress: ${(status.progress * 100).toFixed(2)}% | ` +
        `Downloaded: ${status.downloaded} bytes | ` +
        `Peers: ${status.connectedPeers} | ` +
        `Paused: ${status.paused} | ` +
        `State: ${status.state}`
    );
}

async function main() {
    console.log("\n=== Ubuntu Download Lifecycle Test ===\n");

    // 1. Add torrent.
    console.log("Adding Ubuntu torrent...");

    const added = await sendRequest("add_torrent", {
        torrentPath: TORRENT_PATH,
        savePath: SAVE_PATH
    });

    torrentId = added.torrentId;

    console.log("Torrent added:", torrentId);

    // 2. Check initial status.
    let status = await getStatus();

    console.log("\nInitial status:");
    printStatus(status);

    if (!status.paused) {
        throw new Error("Torrent should initially be paused");
    }

    if (status.downloaded > 0) {
        throw new Error(
            "Fresh download directory is not empty or data was found"
        );
    }

    // 3. Resume.
    console.log("\nResuming torrent...");

    await sendRequest("resume_torrent", { torrentId });

    // 4. Monitor until at least 3% progress.
    console.log("\nMonitoring active download...");

    const startTime = Date.now();
    const maxWait = 10 * 60 * 1000;

    while (Date.now() - startTime < maxWait) {
        await sleep(POLL_INTERVAL);

        status = await getStatus();
        printStatus(status);

        if (status.progress >= PAUSE_THRESHOLD &&
            status.downloaded > 0) {
            break;
        }
    }

    if (status.progress < PAUSE_THRESHOLD) {
        throw new Error("Download did not reach pause threshold");
    }

    // 5. Pause during active downloading.
    console.log("\nPausing torrent...");

    await sendRequest("pause_torrent", { torrentId });

    // 6. Wait until libtorrent confirms paused state.
    console.log("Waiting for paused state...");

    let paused = false;

    for (let i = 0; i < 15; i++) {
        await sleep(1000);
        status = await getStatus();
        printStatus(status);

        if (status.paused) {
            paused = true;
            break;
        }
    }

    if (!paused) {
        throw new Error("Torrent did not enter paused state");
    }

    // 7. Check that downloaded bytes stabilize.
    console.log("\nChecking that download stops...");

    let previousBytes = status.downloaded;
    let stableCount = 0;

    for (let i = 0; i < 15; i++) {
        await sleep(1000);

        status = await getStatus();
        printStatus(status);

        if (status.paused &&
            status.downloaded === previousBytes) {
            stableCount++;
        } else {
            stableCount = 0;
        }

        previousBytes = status.downloaded;

        if (stableCount >= 2) break;
    }

    if (!status.paused || stableCount < 2) {
        throw new Error("Could not verify stable download while paused");
    }

    const pausedBytes = status.downloaded;

    console.log("\nPAUSE TEST PASSED");
    console.log("Stable downloaded bytes:", pausedBytes);

    // 8. Resume again.
    console.log("\nResuming torrent...");

    await sendRequest("resume_torrent", { torrentId });

    // 9. Verify that new bytes arrive.
    console.log("\nWaiting for download to continue...");

    let resumed = false;

    for (let i = 0; i < 30; i++) {
        await sleep(POLL_INTERVAL);

        status = await getStatus();
        printStatus(status);

        if (!status.paused &&
            status.downloaded > pausedBytes) {
            resumed = true;
            break;
        }
    }

    if (!resumed) {
        throw new Error(
            "No additional downloaded bytes observed after resume"
        );
    }

    console.log("\n==================================");
    console.log("PAUSE AND RESUME TEST PASSED");
    console.log("==================================");

    console.log("Torrent ID:", torrentId);
    console.log("Bytes before pause:", pausedBytes);
    console.log("Bytes after resume:", status.downloaded);
    console.log("Current progress:",
        (status.progress * 100).toFixed(2) + "%"
    );

    console.log("\nTorrent remains active in the C++ engine.");
    console.log("It will continue downloading after this test exits.");
}

main().catch(err => {
    console.error("\nTEST FAILED:", err.message);
    process.exitCode = 1;
});