
const net = require("net");

const PORT = 5000;
const HEADER_SIZE = 4;
const MAX_PAYLOAD = 1024 * 1024;

function createFrame(message) {
    const payload = Buffer.from(JSON.stringify(message));

    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32BE(payload.length, 0);

    return Buffer.concat([header, payload]);
}

const server = net.createServer((socket) => {
    console.log("Client connected");

    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= HEADER_SIZE) {
            const length = buffer.readUInt32BE(0);

            if (length === 0 || length > MAX_PAYLOAD) {
                socket.destroy();
                return;
            }

            if (buffer.length < HEADER_SIZE + length) {
                return;
            }

            const payload = buffer.subarray(4, 4 + length);
            buffer = buffer.subarray(4 + length);

            const request = JSON.parse(payload.toString());

            console.log("Received:", request.method, request.id);

            // Test 5: Disconnect intentionally.
            if (request.method === "test_disconnect") {
                console.log("Destroying connection intentionally");
                socket.destroy();
                continue;
            }

            // Test 2: Never respond.
            if (request.method === "test_timeout") {
                console.log("Intentionally ignoring request");
                continue;
            }

            // Test 3: Respond after 3 seconds.
            if (request.method === "test_late") {
                setTimeout(() => {
                    if (!socket.destroyed) {
                        socket.write(createFrame({
                            jsonrpc: "2.0",
                            id: request.id,
                            result: { message: "Late response" }
                        }));
                    }
                }, 3000);

                continue;
            }

            // Test 4: Return concurrent responses out of order.
            if (request.method === "test_concurrent") {
                const delays = {
                    1: 700,
                    2: 100,
                    3: 400
                };

                setTimeout(() => {
                    if (!socket.destroyed) {
                        socket.write(createFrame({
                            jsonrpc: "2.0",
                            id: request.id,
                            result: { requestId: request.id }
                        }));
                    }
                }, delays[request.id] || 100);

                continue;
            }

            // Normal response.
            socket.write(createFrame({
                jsonrpc: "2.0",
                id: request.id,
                result: { status: "OK" }
            }));
        }
    });

    socket.on("close", () => {
        console.log("Client disconnected");
    });
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`Mock server listening on ${PORT}`);
});
