
const net = require("net");

const TOKEN = process.env.BITT_IPC_TOKEN;

if (!TOKEN) {
    console.error("BITT_IPC_TOKEN is not set");
    process.exit(1);
}

const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "add_torrent",
    params: {
    torrentPath: "C:\\Users\\stvks\\Downloads\\Practice\\New folder\\BitT\\test-data\\debian-netinst.torrent",
    savePath: "C:\\Users\\stvks\\Downloads\\Practice\\New folder\\BitT\\test-downloads\\debian-pause-test"
},
    token: TOKEN
};

const client = new net.Socket();

client.connect(5000, "127.0.0.1", () => {
    console.log("Connected to C++ engine");

    const body = Buffer.from(JSON.stringify(request));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);

    client.write(Buffer.concat([header, body]));
});

let buffer = Buffer.alloc(0);

client.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);

    if (buffer.length < 4) return;

    const length = buffer.readUInt32BE(0);

    if (buffer.length < 4 + length) return;

    const response = JSON.parse(
        buffer.subarray(4, 4 + length).toString()
    );

    console.log("\nAdd torrent response:");
    console.log(JSON.stringify(response, null, 4));

    client.end();
});

client.on("error", (err) => {
    console.error("Connection error:", err.message);
});
