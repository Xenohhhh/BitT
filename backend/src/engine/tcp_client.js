
const net = require("net");

const { createComponentLogger } = require("../observability/logger");

const log = createComponentLogger("ipc");

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
  const rejectedCount = pendingRequests.size;

  for (const { reject, timer } of pendingRequests.values()) {
    clearTimeout(timer);
    reject(error);
  }

  pendingRequests.clear();

  if (rejectedCount > 0) {
    log.warn(
      {
        event: "pending_requests_rejected",
        count: rejectedCount,
        error_message: error.message
      },
      "All pending IPC requests rejected"
    );
  }
}


function handleEngineCrash(error) {
  const crashError = error instanceof Error
    ? error
    : new Error("C++ engine terminated unexpectedly");

  log.error(
    {
      event: "engine_crash_handled",
      error: crashError
    },
    "Handling engine crash in TCP client"
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
      log.info(
        {
          event: "torrent_state_changed",
          params
        },
        "Torrent state changed"
      );
      break;

    default:
      log.warn(
        {
          event: "unknown_engine_notification",
          method
        },
        "Received unknown engine notification"
      );
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

      log.error(
        {
          event: "invalid_response_frame",
          payload_length: payloadLength,
          max_payload: MAX_PAYLOAD
        },
        error.message
      );

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

      log.error(
        {
          event: "invalid_json_response",
          err
        },
        error.message
      );

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
        log.warn(
          {
            event: "unknown_response_id",
            request_id: response.id
          },
          "Received response with unknown request ID"
        );

        continue;
      }

      clearTimeout(pending.timer);
      pendingRequests.delete(response.id);

      const durationMs = Date.now() - pending.startedAt;

      if (response.error) {
        const error = new Error(
          `${response.error.code}: ${response.error.message}`
        );

        log.error(
          {
            event: "ipc_request_failed",
            request_id: response.id,
            method: pending.method,
            duration_ms: durationMs,
            error_code: response.error.code,
            error_message: response.error.message
          },
          "IPC request returned an error"
        );

        pending.reject(error);
      } else {
        log.debug(
          {
            event: "ipc_response_received",
            request_id: response.id,
            method: pending.method,
            duration_ms: durationMs
          },
          "IPC response received"
        );

        pending.resolve(response.result);
      }

      continue;
    }

    log.warn(
      {
        event: "unrecognized_json_rpc_message"
      },
      "Received unrecognized JSON-RPC message"
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

  log.info(
    {
      event: "ipc_connection_started",
      host: HOST,
      port: PORT
    },
    "Connecting to C++ engine"
  );

  client = net.createConnection({
    host: HOST,
    port: PORT
  });

  return new Promise((resolve, reject) => {
    let connectionSettled = false;

    client.on("connect", () => {
      connectionState = "CONNECTED";

      log.info(
        {
          event: "ipc_connected",
          host: HOST,
          port: PORT
        },
        "Connected to C++ engine"
      );

      connectionSettled = true;
      resolve(client);
    });

    client.on("data", handleData);

    client.on("end", () => {
      connectionState = "DISCONNECTED";

      log.warn(
        {
          event: "ipc_server_ended_stream",
          incomplete_frame: receiveBuffer.length !== 0,
          remaining_buffer_bytes: receiveBuffer.length
        },
        "Server ended its sending stream"
      );

      rejectAllPending(
        new Error("Server ended the connection")
      );
    });

    client.on("error", (err) => {
      connectionState = "DISCONNECTED";

      log.error(
        {
          event: "ipc_socket_error",
          err
        },
        "IPC socket error"
      );

      rejectAllPending(err);

      if (!connectionSettled) {
        connectionSettled = true;
        reject(err);
      }
    });

    client.on("close", () => {
      connectionState = "DISCONNECTED";

      log.info(
        {
          event: "ipc_connection_closed"
        },
        "IPC connection closed"
      );

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
      const error = new Error(
        `Cannot send request: socket is ${connectionState}`
      );

      log.warn(
        {
          event: "ipc_request_rejected",
          method,
          connection_state: connectionState
        },
        error.message
      );

      reject(error);
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
      log.error(
        {
          event: "ipc_request_serialization_failed",
          request_id: id,
          method,
          err
        },
        "Failed to serialize IPC request"
      );

      reject(err);
      return;
    }

    const startedAt = Date.now();

    const timer = setTimeout(() => {
      const pending = pendingRequests.get(id);

      if (!pending) return;

      pendingRequests.delete(id);

      const durationMs = Date.now() - pending.startedAt;

      const error = new Error(
        `Request ${id} timed out after ${timeout}ms`
      );

      log.warn(
        {
          event: "ipc_request_timeout",
          request_id: id,
          method,
          timeout_ms: timeout,
          duration_ms: durationMs
        },
        error.message
      );

      pending.reject(error);
    }, timeout);

    pendingRequests.set(id, {
      resolve,
      reject,
      timer,
      method,
      startedAt
    });

    log.debug(
      {
        event: "ipc_request_sent",
        request_id: id,
        method,
        timeout_ms: timeout
      },
      "IPC request sent"
    );

    client.write(frame, (err) => {
      if (err) {
        const pending = pendingRequests.get(id);

        if (!pending) return;

        clearTimeout(pending.timer);
        pendingRequests.delete(id);

        log.error(
          {
            event: "ipc_write_failed",
            request_id: id,
            method,
            err
          },
          "Failed to write IPC request"
        );

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

  log.info(
    {
      event: "ipc_disconnect_started",
      timeout_ms: timeout
    },
    "Disconnecting from C++ engine"
  );

  return new Promise((resolve) => {
    let settled = false;

    function finish() {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      socket.removeListener("close", finish);

      connectionState = "DISCONNECTED";

      log.info(
        {
          event: "ipc_disconnect_completed"
        },
        "IPC disconnection completed"
      );

      resolve();
    }

    socket.once("close", finish);

    const timer = setTimeout(() => {
      log.warn(
        {
          event: "ipc_disconnect_timeout",
          timeout_ms: timeout
        },
        "TCP connection did not close in time. Destroying socket"
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
