
const net = require("net");

const HOST = "127.0.0.1";
const PORT = 5000;
const MAX_PAYLOAD = 1024 * 1024;
const HEADER_SIZE = 4;
const REQUEST_TIMEOUT_MS = 5000;

let token = null;
let client = null;
let connectionState = "DISCONNECTED";
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

function rejectAllPending(error) {
  for (const { reject, timer } of pendingRequests.values()) {
    clearTimeout(timer);
    reject(error);
  }

  pendingRequests.clear();
}

function handleEngineCrash(error) {
  const crashError = error instanceof Error
    ? error
    : new Error("C++ engine terminated unexpectedly");

  console.error(
    "Handling engine crash in TCP client:",
    crashError.message
  );

  // Prevent any new requests.
  connectionState = "DISCONNECTED";

  // Reject all outstanding requests immediately.
  rejectAllPending(crashError);

  // Close the socket if it is still alive.
  if (client && !client.destroyed) {
    client.destroy();
  }
}

function handleNotification(notification) {
  const { method, params } = notification;

  switch (method) {
    case "torrent_state_changed":
      console.log("Torrent state changed:", params);
      break;

    default:
      console.log("Unknown engine notification:", notification);
  }
}

function handleData(chunk) {
  receiveBuffer = Buffer.concat([
    receiveBuffer,
    chunk
  ]);

  while (receiveBuffer.length >= HEADER_SIZE) {
    const payloadLength = receiveBuffer.readUInt32BE(0);

    if (
      payloadLength === 0 ||
      payloadLength > MAX_PAYLOAD
    ) {
      const error = new Error(
        `Invalid response payload length: ${payloadLength}`
      );

      console.error(error.message);
      rejectAllPending(error);
      client.destroy();
      return;
    }

    const frameLength = HEADER_SIZE + payloadLength;

    if (receiveBuffer.length < frameLength) {
      return;
    }

    const payload = receiveBuffer.subarray(
      HEADER_SIZE,
      frameLength
    );

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

    // JSON-RPC notification.
    if (
      Object.prototype.hasOwnProperty.call(response, "method") &&
      !Object.prototype.hasOwnProperty.call(response, "id")
    ) {
      handleNotification(response);
      continue;
    }

    // JSON-RPC response.
    if (Object.prototype.hasOwnProperty.call(response, "id")) {
      const pending = pendingRequests.get(response.id);

      if (!pending) {
        console.error(
          "Received response with unknown ID:",
          response.id
        );
        continue;
      }

      clearTimeout(pending.timer);
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

    console.error(
      "Received unrecognized JSON-RPC message:",
      response
    );
  }
}

function connectToEngine() {
  if (connectionState === "CONNECTED") {
    return Promise.resolve(client);
  }

  if (connectionState === "CONNECTING") {
    return Promise.reject(
      new Error("Connection attempt already in progress")
    );
  }

  token = process.env.BITT_IPC_TOKEN;

  if (!token) {
    return Promise.reject(
      new Error(
        "BITT_IPC_TOKEN must be set to the engine session secret"
      )
    );
  }

  connectionState = "CONNECTING";
  receiveBuffer = Buffer.alloc(0);
  nextId = 1;

  client = net.createConnection({
    host: HOST,
    port: PORT
  });

  return new Promise((resolve, reject) => {
    let connectionSettled = false;

    client.on("connect", () => {
      connectionState = "CONNECTED";
      console.log("Connected to C++ engine");

      connectionSettled = true;
      resolve(client);
    });

    client.on("data", handleData);

    client.on("end", () => {
      connectionState = "DISCONNECTED";

      console.log("Server ended its sending stream");

      if (receiveBuffer.length !== 0) {
        console.error(
          "Connection ended with an incomplete frame"
        );
      }

      rejectAllPending(
        new Error("Server ended the connection")
      );
    });

    client.on("error", (err) => {
      connectionState = "DISCONNECTED";

      console.error("Socket error:", err.message);
      rejectAllPending(err);

      if (!connectionSettled) {
        connectionSettled = true;
        reject(err);
      }
    });

    client.on("close", () => {
      connectionState = "DISCONNECTED";

      console.log("Connection closed");

      rejectAllPending(
        new Error("Connection closed")
      );

      if (!connectionSettled) {
        connectionSettled = true;
        reject(new Error("Connection closed before connecting"));
      }
    });
  });
}

function sendRequest(
  method,
  params = {},
  timeout = REQUEST_TIMEOUT_MS
) {
  return new Promise((resolve, reject) => {
    if (
      connectionState !== "CONNECTED" ||
      !client ||
      !client.writable
    ) {
      reject(
        new Error(
          `Cannot send request: socket is ${connectionState}`
        )
      );
      return;
    }

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

    const timer = setTimeout(() => {
      const pending = pendingRequests.get(id);

      if (!pending) return;

      pendingRequests.delete(id);

      pending.reject(
        new Error(
          `Request ${id} timed out after ${timeout}ms`
        )
      );
    }, timeout);

    pendingRequests.set(id, {
      resolve,
      reject,
      timer
    });

    client.write(frame, (err) => {
      if (err) {
        const pending = pendingRequests.get(id);

        if (!pending) return;

        clearTimeout(pending.timer);
        pendingRequests.delete(id);
        pending.reject(err);
      }
    });
  });
}

function shutdownEngine() {
  return sendRequest("shutdown_engine");
}


function disconnect(timeout = 1000) {
  if (!client || client.destroyed) {
    connectionState = "DISCONNECTED";
    return Promise.resolve();
  }

  const socket = client;

  return new Promise((resolve) => {
    let settled = false;

    function finish() {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      socket.removeListener("close", finish);

      connectionState = "DISCONNECTED";
      resolve();
    }

    socket.once("close", finish);

    const timer = setTimeout(() => {
      console.warn(
        "TCP connection did not close in time. Destroying socket."
      );

      socket.destroy();
      finish();
    }, timeout);

    if (socket.writable) {
      socket.end();
    } else {
      socket.destroy();
    }
  });
}


function getConnectionState() {
  return connectionState;
}

module.exports = {
  connectToEngine,
  sendRequest,
  shutdownEngine,
  disconnect,
  getConnectionState,
  handleEngineCrash
};
