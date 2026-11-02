
const net = require("net");

const HOST = "127.0.0.1";
const PORT = 5000;
const MAX_PAYLOAD = 1024 * 1024;
const HEADER_SIZE = 4;

const token = process.env.BITT_IPC_TOKEN;

if (!token) {
  throw new Error(
    "BITT_IPC_TOKEN must be set to the engine session secret"
  );
}

const client = net.createConnection(
  { host: HOST, port: PORT }
);

let receiveBuffer = Buffer.alloc(0);
let nextId = 1;
const pendingRequests = new Map();

function createFrame(message) {
  const payload = Buffer.from(
    JSON.stringify(message),
    "utf8"
  );

  if (payload.length === 0 || payload.length > MAX_PAYLOAD) {
    throw new Error("Invalid payload size");
  }

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32BE(payload.length, 0);

  return Buffer.concat([header, payload]);
}

function sendRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;

    const request = {
      jsonrpc: "2.0",
      id,
      method,
      params,
      token
    };

    let frame;

    try {
      frame = createFrame(request);
    } catch (err) {
      reject(err);
      return;
    }

    pendingRequests.set(id, { resolve, reject });

    client.write(frame, (err) => {
      if (err) {
        pendingRequests.delete(id);
        reject(err);
      }
    });
  });
}

function rejectAllPending(error) {
  for (const { reject } of pendingRequests.values()) {
    reject(error);
  }

  pendingRequests.clear();
}


function handleNotification(notification) {
  const { method, params } = notification;

  switch (method) {
    case "torrent_state_changed":
      console.log("Torrent state changed:", params);

      // Later, this can update your application's torrent state.
      break;

    default:
      console.log("Unknown engine notification:", notification);
  }
}


client.on("connect", async () => {
  console.log("Connected to C++ engine");

  try {
    // Multiple requests over the same TCP connection.
    const status = await sendRequest("get_status");
    console.log("Status response:", status);

    const secondStatus = await sendRequest("get_status");
    console.log("Second response:", secondStatus);

    client.end();
  } catch (err) {
    console.error("Request failed:", err.message);
    client.destroy();
  }
});

client.on("data", (chunk) => {
  receiveBuffer = Buffer.concat([
    receiveBuffer,
    chunk
  ]);

  // Process every complete frame in the buffer.
  while (receiveBuffer.length >= HEADER_SIZE) {
    const payloadLength =
      receiveBuffer.readUInt32BE(0);

    if (payloadLength === 0 || payloadLength > MAX_PAYLOAD) {
      const error = new Error(
        `Invalid response payload length: ${payloadLength}`
      );

      console.error(error.message);
      rejectAllPending(error);
      client.destroy();
      return;
    }

    const frameLength = HEADER_SIZE + payloadLength;

    // Wait for the complete frame.
    if (receiveBuffer.length < frameLength) {
      return;
    }

    const payload = receiveBuffer.subarray(
      HEADER_SIZE,
      frameLength
    );

    // Keep any bytes belonging to later frames.
    receiveBuffer = receiveBuffer.subarray(frameLength);

    let response;

    try {
      response = JSON.parse(payload.toString("utf8"));
    } catch (err) {
      const error = new Error("Invalid JSON response");

      console.error(error.message);
      rejectAllPending(error);
      client.destroy();
      return;
    }

    
    // JSON-RPC notification: has a method but no id.
    if (
      Object.prototype.hasOwnProperty.call(response, "method") &&
      !Object.prototype.hasOwnProperty.call(response, "id")
    ) {
      handleNotification(response);
      continue;
    }

    // JSON-RPC response: has an id.
    if (Object.prototype.hasOwnProperty.call(response, "id")) {
      const pending = pendingRequests.get(response.id);

      if (!pending) {
        console.error(
          "Received response with unknown ID:",
          response.id
        );
        continue;
      }

      pendingRequests.delete(response.id);

      if (response.error) {
        pending.reject(
          new Error(
            `${response.error.code}: ${response.error.message}`
          )
        );
      } else {
        pending.resolve(response.result);
      }

      continue;
    }

    console.error("Received unrecognized JSON-RPC message:", response);

  }
});

client.on("end", () => {
  console.log("Server ended its sending stream");

  if (receiveBuffer.length !== 0) {
    console.error("Connection ended with an incomplete frame");
  }
});

client.on("error", (err) => {
  console.error("Socket error:", err.message);
  rejectAllPending(err);
});

client.on("close", () => {
  console.log("Connection closed");
  rejectAllPending(new Error("Connection closed"));
});
