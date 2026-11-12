
const net = require("net");

const TOKEN = process.env.BITT_IPC_TOKEN;
const TORRENT_ID = 1762603375;

if (!TOKEN) {
    console.error("BITT_IPC_TOKEN is not set");
    process.exit(1);
}

const request = {
    jsonrpc: "2.0",
    id: 3,
    method: "pause_torrent",
    params: {
        torrentId: TORRENT_ID
    },
    token: TOKEN
};

const client = new net.Socket();
let buffer = Buffer.alloc(0);

client.connect(5000, "127.0.0.1", () => {
    console.log("Connected to C++ engine");

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

    const response = JSON.parse(
        buffer.subarray(4, 4 + length).toString()
    );

    console.log("\nPause response:");
    console.log(JSON.stringify(response, null, 4));

    client.end();
});

client.on("error", (err) => {
    console.error("Connection error:", err.message);
});
