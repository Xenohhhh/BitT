# IPC Protocol

## 1. Purpose

The BitTorrent client uses a separate C++ engine process powered by libtorrent and a Node.js backend.

The two processes communicate over a local TCP connection using UTF-8 JSON messages with length-prefixed framing.

The protocol supports:

* Request-response communication for commands initiated by Node.js.
* Asynchronous event notifications emitted by the C++ engine.
* Error reporting and request correlation.
* Engine status and lifecycle synchronization.

## 2. Transport and Framing


| Property             | Specification                 |
| -------------------- | ----------------------------- |
| Transport            | Local TCP socket              |
| Encoding             | UTF-8                         |
| Message format       | JSON                          |
| Framing              | 4-byte unsigned length prefix |
| Byte order           | Big-endian                    |
| Maximum message size | 1 MiB                         |
| Oversized messages   | Reject and close connection   |

The length prefix represents the number of bytes in the JSON payload, excluding the prefix itself.

TCP is a byte stream and does not preserve message boundaries. Both processes must buffer incoming data, decode the length prefix, and wait until the complete payload is available before parsing JSON.

The receiver must reject messages exceeding the configured maximum size.

## 3. Message Format

The protocol follows JSON-RPC 2.0 conventions.

### 3.1 Request

Requests are initiated by Node.js and include a unique ID, method name, and optional parameters.

```
{
  "jsonrpc": "2.0",
  "method": "pause_torrent",
  "params": {
    "torrentId": "abc123"
  },
  "id": 1
}
```

### 3.2 Successful Response

The engine returns the same request ID with a result.

```
{
  "jsonrpc": "2.0",
  "result": {
    "success": true
  },
  "id": 1
}
```

### 3.3 Error Response

Errors contain a code, message, and the corresponding request ID.

```
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32602,
    "message": "Invalid params"
  },
  "id": 1
}
```

### 3.4 Event Notification

Events are initiated by the engine and do not contain a request ID.

```
{
  "jsonrpc": "2.0",
  "method": "torrent_completed",
  "params": {
    "torrentId": "abc123"
  }
}
```

Events are notifications, not responses to requests.

## 4. Initial Commands


| Method                         | Purpose                                    |
| ------------------------------ | ------------------------------------------ |
| `<span>inspect_torrent</span>` | Inspect torrent metadata without adding it |
| `<span>add_torrent</span>`     | Add a torrent to the engine                |
| `<span>pause_torrent</span>`   | Pause a torrent                            |
| `<span>resume_torrent</span>`  | Resume a torrent                           |
| `<span>remove_torrent</span>`  | Remove a torrent from the engine           |
| `<span>get_status</span>`      | Retrieve current torrent status            |

Command parameters and result schemas will be defined in the implementation contract.

## 5. Initial Events


| Event                                | Purpose                        |
| ------------------------------------ | ------------------------------ |
| `<span>torrent_state_changed</span>` | Report lifecycle state changes |
| `<span>stats_updated</span>`         | Report transfer statistics     |
| `<span>torrent_completed</span>`     | Report download completion     |
| `<span>torrent_error</span>`         | Report torrent-specific errors |

Event payloads will contain the torrent identifier and the relevant state, statistics, or error information.

## 6. Error Codes

Standard JSON-RPC error codes:


| Code   | Meaning          |
| ------ | ---------------- |
| -32700 | Parse error      |
| -32600 | Invalid request  |
| -32601 | Method not found |
| -32602 | Invalid params   |
| -32603 | Internal error   |

Application-specific errors will use a separate documented code range.

## 7. Connection Lifecycle

* Node.js starts and supervises the C++ engine process.
* The engine opens its local TCP server.
* Node.js establishes the connection and includes the per-engine-session token as a top-level `token` field on each request. Both processes read the same high-entropy value from `BITT_IPC_TOKEN`; the engine rejects requests without a matching token. The token is stripped before JSON-RPC dispatch.
* Requests and events are exchanged over the connection.
* If the connection is lost, Node.js detects the failure and initiates recovery.
* The engine and backend must reconcile state after reconnection or restart.

## 8. Design Constraints

* Node.js owns application-level scheduling and persistence.
* The C++ engine owns torrent protocol execution and transfer management.
* Libtorrent handles torrent metadata parsing, peer management, piece selection, and verification.
* Torrent file contents are not transmitted as large JSON IPC payloads; paths or references are used instead.
* IPC messages must be validated before processing.
