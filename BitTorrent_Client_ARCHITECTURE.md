# BitTorrent Client — Architecture and Decision Record

This file is the engineering companion to `BitTorrent_Client_PRD.docx`. The PRD defines goals, scope, acceptance criteria, and roadmap; this document captures implementation policy and architecture decisions.

## 1. Architecture

![Component architecture](BitTorrent_Client_Architecture.png)

- **React:** UI only; calls Node.js REST APIs and consumes SSE. Never receives the engine token.
- **Node.js:** application API, scheduler, SQLite, process supervision, durable user intent, recovery reconciliation.
- **C++ adapter + libtorrent:** separate process; protocol/runtime behavior, piece validation, engine events, supported resume-data behavior.
- **SQLite:** app metadata, desired state, queue metadata, history, pending operations, checkpoint references.
- **Filesystem:** content, retained `.torrent` metadata, resume data.
- **Electron:** added after browser-first core workflows are stable; Windows first.

## 2. Decisions and rationale

| ID | Decision | Status | Rationale |
|---|---|---|---|
| D1 | Use libtorrent in C++ | Committed | Avoid implementing all protocol internals; learn through integration, instrumentation, experiments, and source study. |
| D2 | Separate engine process | Committed | Crash isolation and independent supervision. |
| D3 | Loopback TCP IPC | Committed | Cross-platform and easy to debug; bind to `127.0.0.1`, never `0.0.0.0`. |
| D4 | Length-prefixed JSON | Committed | 4-byte unsigned big-endian byte length followed by UTF-8 JSON; strict frame cap and partial-read handling. |
| D5 | Request/response + async events | Committed | Correlated request IDs; events can race responses; reconnect uses handshake and fresh snapshot. |
| D6 | Safe retry semantics | Committed | Timeout means unknown outcome. Use idempotent desired-state commands and reconcile before retrying ambiguous operations. |
| D7 | Progress-aware shutdown | Committed | Stop new work, request/await resume data, persist, enforce hard deadline, recover conservatively. |
| D8 | Core first, advanced later | Committed | Define Stage 1 and Stage 2; evolve to advanced client capabilities after a reliable core. |
| D9 | Desired vs runtime state | Selected staged approach | Persist desired state; derive runtime state from engine observations; add explicit transition validation as complexity grows. |
| D10 | SQLite + resume data | Committed | SQLite owns application truth and user intent; resume data aids engine recovery; conditional rechecking. |
| D11 | Bounded resources | Committed | Shared active-torrent cap, peer/bandwidth limits, bounded IPC and event queues. |
| D12 | Download-priority queue | Committed with ownership rule below | Downloads are preferred when a slot opens; do not preempt seeders automatically in Stage 1. |
| D13 | IPC token | Committed | High-entropy per-engine-session token, protected delivery, never exposed to UI/logs/CLI. |
| D14 | Strict path containment | Committed | Selectively reject unsafe entries only if safe with libtorrent; otherwise reject entire torrent. |
| D15 | Removal semantics | Committed | Remove-from-list is non-destructive; history deletion and downloaded-file deletion are separate explicit actions. File deletion moved to Stage 2. |
| D16 | Layered metadata validation | Committed | Validate at app boundaries and enforce budgets; rely on libtorrent for protocol parsing/validation. |
| D17 | Layered testing | Committed | Unit, integration, E2E, and failure-injection testing. |
| D18 | Windows first, Electron later | Committed | Focus first release; keep platform-specific process/filesystem behavior isolated. |

## 3. Authoritative queue and engine ownership

**Single authority rule:** Node.js owns application scheduling policy and the authoritative application queue. Libtorrent owns protocol/runtime behavior and enforces engine resource limits. Do not run two independent, competing queue policies.

Implementation must verify the pinned libtorrent version's queueing capabilities. If libtorrent's own queueing is enabled, configure it so it does not independently contradict Node.js scheduling (for example, Node.js admits only its selected active set and the engine is configured consistently). Do not duplicate queue-position logic in two layers.

- One shared active-torrent cap counts downloading and seeding torrents.
- Prefer eligible downloads when a slot opens; tie-break with explicit priority then queue order.
- Do not automatically preempt a seeder just because a new download arrives in Stage 1.
- User-paused torrents must not be resumed by the scheduler.
- Reconcile scheduling decisions with observed engine state after restart and events.
- Exact caps are set after baseline tests.

## 4. IPC contract policy

### Transport and authentication
- Bind to `127.0.0.1` only; explicitly decide whether IPv6 loopback is supported.
- Per-engine-process session token generated with a cryptographically secure RNG.
- Deliver the token through a **private inherited stdin pipe** from the Node.js parent to the C++ child during startup; do not put it in environment variables, command-line arguments, logs, or React.
- Authenticate before processing application commands; rotate token on engine restart.
- Treat the token as defense-in-depth, not protection against a compromised same-user process.

### Framing
- Header: 4-byte unsigned big-endian payload byte length.
- Payload: exactly that many UTF-8 JSON bytes.
- Reject oversized frames before allocating the complete payload; bound buffers and in-flight work.
- Handle partial headers/payloads, malformed JSON, disconnects, unknown commands, and invalid arguments.

### Message semantics
- Requests include a unique request ID; responses carry the same ID.
- Async engine events have event IDs or sequence metadata where useful, but events are not durable history.
- `inspect_torrent` parses/inspects metadata without starting a torrent and returns a bounded manifest: stable info hash/identity where available, file paths, sizes, and relevant metadata needed for policy.
- Node.js applies application path, collision, and admission rules to the returned manifest. The engine remains responsible for parsing torrent metadata.
- On reconnect: authenticate, wait for readiness, request fresh snapshot, then reconcile; do not assume no events were missed.
- Distinguish accepted from completed for long-running work.
- Commands should be idempotent where possible; destructive actions need operation-specific recovery.

## 5. State model

- `desiredState`: durable user intent, initially `running` or `paused`.
- `runtimeState`: latest observed mapped engine state, such as `checking`, `downloading`, `seeding`, `error`, or `queued`.
- Never update runtime state merely because a command was sent.
- Scheduler state (`queued`/slot eligibility) is app policy; make its relation to runtime state explicit in API/UI.
- Final state names and transition table must be frozen before Milestone 1.

## 6. Persistence and recovery

- SQLite owns stable torrent record, desired state, destination, user preferences, queue priority/order, history, pending operations, and checkpoint metadata.
- Libtorrent resume data is an engine recovery aid; actual content and engine checking behavior remain authoritative for integrity.
- Conditional rechecking: trust usable resume data when appropriate; recheck missing, changed, or inconsistent files, or when recovery evidence requires it.
- Retain last known-good checkpoint until replacement is successfully written and accepted.
- Separate “resume data requested”, “resume data produced”, “file written”, and “SQLite reference updated”.
- Atomic replacement is not by itself a guarantee against power loss; use platform-appropriate durability and conservative recovery.
- If resume data is missing/corrupt, reconstruct from retained `.torrent` metadata or other available metadata; preserve the app record if recovery fails.
- Desired user intent wins over stale resume-time activity: a paused torrent must remain paused after restart.

## 7. Shutdown

1. Stop new admissions.
2. Settle/classify in-flight commands.
3. Request resume data and wait for asynchronous completion.
4. Persist new checkpoint and metadata; track pending operations and engine health.
5. Exit gracefully if possible; enforce hard deadline.
6. On next start, reconcile SQLite, resume data, files, and desired state.

## 8. Resource policy

- One shared active limit for downloads + seeders.
- Node.js owns scheduling; libtorrent handles actual transfer/peer runtime. Configure engine queueing to avoid a second competing policy.
- Prefer downloads over seeders when a slot opens; do not automatically interrupt active seeders in Stage 1.
- Bound global and per-torrent peer counts as supported; global upload/download limits.
- Bound metadata acquisition, command queues, frame sizes, pending events, and progress update frequency.
- Use admission control even for valid requests. A timeout alone does not cancel work.
- Numeric thresholds are implementation-time tuning values; record benchmark machine and workload.

## 9. Path and file safety

- Engine `inspect_torrent` parses metadata and returns the manifest before starting; Node.js applies policy to the manifest.
- Reject absolute paths, traversal, drive/UNC paths, unsafe components, and normalized-path collisions.
- Do not rely on string-prefix checks; lexical normalization alone cannot prevent symlink escapes or filesystem races.
- Use documented libtorrent path/storage protections and validate exact behavior for the pinned version.
- Selectively exclude unsafe entries only if libtorrent can safely support the resulting file selection. Otherwise reject the torrent.
- Never silently overwrite unrelated files.
- Stage 1 supports safe non-destructive remove-from-list. Downloaded-file deletion is Stage 2 and must be explicit, tracked, and recoverable.

## 10. Metadata/resource validation

- Node.js checks upload/input limits and admission policy.
- `inspect_torrent` delegates torrent parsing to libtorrent through C++ and returns a bounded manifest.
- Apply structural budgets: metadata size, file count, path length, aggregate manifest size, and any relevant limits.
- Magnet metadata acquisition is also bounded by size, time, and concurrent fetch limits.
- C++ validates IPC schemas and arguments independently of frontend checks.
- Rely on libtorrent for protocol parsing and piece validation rather than implementing a competing parser.
- Bound command queues and background work; test floods of individually valid requests.

## 11. Testing

- **Unit:** scheduler, state reconciliation, validation, retry classification, operation records.
- **Integration:** real Node.js + C++ adapter; framing/authentication; partial messages; timeout and reconnect; `inspect_torrent`.
- **End-to-end:** legal test torrent, hash verification, pause/resume, seed, restart.
- **Failure injection:** kill engine before/after command execution, lose response, interrupt checkpoint stages, corrupt/miss resume data, remove/alter files.
- **Security/resource:** path traversal, drive/UNC paths, symlink cases, collisions, oversized metadata/frames, command flood, bounded queues.
- **Packaged app:** Windows standard-user launch, dependency discovery, child-process cleanup, restart and filesystem behavior.

Initial proposed acceptance targets are in the PRD. Treat them as hypotheses to validate, not measured performance claims.

## 12. Milestone 0 exit criteria (must precede Milestone 1)

1. **Pin libtorrent version and build configuration** before implementation. Select one supported major/minor release and commit dependency/build metadata. Verify resume-data, file-storage, file-selection, queue, and shutdown APIs against that version.
2. Define IPC commands/events and error codes, including `inspect_torrent`, `add_torrent`, `set_paused`, `set_running`, `remove_torrent`, `get_snapshot`, and shutdown/checkpoint commands.
3. Define REST API and SSE event schemas.
4. Freeze initial state names and transition rules.
5. Define SQLite schema, stable torrent identity, operation records, and resume-data naming/retention.
6. Define initial numeric safety limits and test harness.
7. Establish baseline performance measurement procedure.
8. Build a minimal C++ adapter executable and verify packaged/native dependency discovery in the Windows dev environment.

## 13. Decisions deliberately deferred

- Exact numeric limits (select after baseline measurements).
- Detailed peer-statistics UX and advanced scheduling.
- Linux packaging.
- Advanced deletion UI (Stage 2).
- More extensive randomized peer/network simulation.
