
const net = require("net");

const TOKEN = process.env.BITT_IPC_TOKEN;

const TORRENT_ID = 1762577201;

const TORRENT_PATH =
    "C:\\Users\\stvks\\Downloads\\Practice\\New folder\\BitT\\test-data\\tinycore.torrent";

const SAVE_PATH =
    "C:\\Users\\stvks\\Downloads\\Practice\\New folder\\BitT\\test-downloads\\tinycore-pause-test";

function sendRequest(method, params, id) {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        let buffer = Buffer.alloc(0);
        let completed = false;

        const timeout = setTimeout(() => {
            finish(reject, new Error("Request timed out"));
        }, 5000);

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
                id,
                method,
                params,
                token: TOKEN
            };

            const body = Buffer.from(JSON.stringify(request));
            const header = Buffer.alloc(4);
            header.writeUInt32BE(body.length);

            client.write(Buffer.concat([header, body]));
        });

        client.on("data", (data) => {
            buffer = Buffer.concat([buffer, data]);

            if (buffer.length < 4) return;

            const length = buffer.readUInt32BE(0);

            if (buffer.length < 4 + length) return;

            try {
                const response = JSON.parse(
                    buffer.subarray(4, 4 + length).toString()
                );

                finish(resolve, response);
            } catch (err) {
                finish(reject, err);
            }
        });

        client.on("error", (err) => finish(reject, err));
    });
}

async function main() {
    if (!TOKEN) {
        throw new Error("BITT_IPC_TOKEN is not set");
    }

    console.log("Removing previous torrent...");

    const removed = await sendRequest(
        "remove_torrent",
        { torrentId: TORRENT_ID },
        1
    );

    console.log(JSON.stringify(removed, null, 4));

    if (removed.error) {
        throw new Error("Could not remove previous torrent");
    }

    console.log("\nAdding torrent to fresh directory...");

    const added = await sendRequest(
        "add_torrent",
        {
            torrentPath: TORRENT_PATH,
            savePath: SAVE_PATH
        },
        2
    );

    console.log(JSON.stringify(added, null, 4));

    if (added.error || !added.result?.success) {
        throw new Error("Could not add torrent");
    }

    const newId = added.result.torrentId;

    console.log("\nChecking initial status...");

    const status = await sendRequest(
        "get_torrent_status",
        { torrentId: newId },
        3
    );

    console.log(JSON.stringify(status, null, 4));

    console.log("\nNew torrent ID:", newId);
}

main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
});
