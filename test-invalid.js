
const net = require("net");

const TOKEN = process.env.BITT_IPC_TOKEN;

if (!TOKEN) {
    console.error("BITT_IPC_TOKEN is not set");
    process.exit(1);
}

const testCases = [
    { label: "Negative ID", torrentId: -1 },
    { label: "Floating-point ID", torrentId: 12.5 },
    { label: "String ID", torrentId: "123" },
    { label: "Out-of-range ID", torrentId: 4294967296 },
    { label: "Nonexistent valid ID", torrentId: 123456789 }
];

function sendRequest(testCase) {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        let buffer = Buffer.alloc(0);
        let completed = false;

        const timeout = setTimeout(() => {
            client.destroy();
            reject(new Error("Request timed out"));
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
                id: 1,
                method: "get_torrent_status",
                params: {
                    torrentId: testCase.torrentId
                },
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

            const messageLength = buffer.readUInt32BE(0);

            if (buffer.length < 4 + messageLength) return;

            try {
                const response = JSON.parse(
                    buffer.subarray(4, 4 + messageLength).toString()
                );

                finish(resolve, {
                    label: testCase.label,
                    input: testCase.torrentId,
                    response
                });
            } catch (err) {
                finish(reject, err);
            }
        });

        client.on("error", (err) => {
            finish(reject, err);
        });
    });
}

async function runTests() {
    console.log("Starting invalid torrent ID tests...\n");

    for (const testCase of testCases) {
        try {
            const result = await sendRequest(testCase);

            console.log("--------------------------------");
            console.log("Test:", result.label);
            console.log("Input:", result.input);
            console.log("Response:");
            console.log(JSON.stringify(result.response, null, 4));
        } catch (err) {
            console.log("--------------------------------");
            console.log("Test:", testCase.label);
            console.log("Failed:", err.message);
        }
    }

    console.log("\nAll test cases executed.");
}

runTests();
