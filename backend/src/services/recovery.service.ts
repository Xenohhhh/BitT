import {
  findAll,
  clearEngineIds,
  updateEngineId,
  clearEngineId,
  type TorrentRecord
} from "../repositories/torrent.repository.js";

import { sendEngineRequest } from "../engine/engine.client.js";

function isObject(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getNewEngineId(response: unknown): number {
  if (
    !isObject(response) ||
    response.success !== true ||
    typeof response.torrentId !== "number" ||
    !Number.isInteger(response.torrentId) ||
    response.torrentId < 0 ||
    response.torrentId > 0xFFFFFFFF
  ) {
    throw new Error("Invalid add_torrent response from engine");
  }

  return response.torrentId;
}

function validateCommandResponse(
  response: unknown,
  operation: string
): void {
  if (!isObject(response) || response.success !== true) {
    throw new Error(`Engine ${operation} operation failed`);
  }
}

async function recoverTorrent(
  torrent: TorrentRecord
): Promise<void> {
  let newEngineId: number | undefined;

  try {
    // Re-add the torrent to the newly started engine.
    const addResponse = await sendEngineRequest(
      "add_torrent",
      {
        torrentPath: torrent.torrent_path,
        savePath: torrent.save_path
      }
    );

    newEngineId = getNewEngineId(addResponse);

    // Store the newly assigned engine ID.
    const updated = updateEngineId(
      torrent.id,
      newEngineId
    );

    if (!updated) {
      throw new Error(
        "Failed to update torrent engine ID in database"
      );
    }

    // Newly added torrents are paused by default.
    // Only resume torrents whose desired state was active.
    if (torrent.desired_state === "active") {
      const resumeResponse = await sendEngineRequest(
        "resume_torrent",
        {
          torrentId: newEngineId
        }
      );

      validateCommandResponse(
        resumeResponse,
        "resume_torrent"
      );
    }

    console.info(
      `[Recovery] Restored "${torrent.name}" (engine ID: ${newEngineId}, desired state: ${torrent.desired_state})`
    );
  } catch (error) {
    // If the torrent was added but recovery subsequently failed,
    // attempt to remove it from the engine.
    if (newEngineId !== undefined) {
      try {
        await sendEngineRequest(
          "remove_torrent",
          {
            torrentId: newEngineId
          }
        );
      } catch (cleanupError) {
        console.error(
          `[Recovery] Could not remove partially recovered torrent "${torrent.name}":`,
          cleanupError
        );
      }
    }

    // Keep the permanent SQLite record, but mark it as
    // not currently registered in the engine.
    clearEngineId(torrent.id);

    console.error(
      `[Recovery] Failed to restore "${torrent.name}":`,
      error
    );
  }
}

export async function recoverTorrents(): Promise<void> {
  console.info("[Recovery] Starting torrent recovery...");

  // Old engine IDs are invalid after an engine restart.
  clearEngineIds();

  const torrents = findAll();

  console.info(
    `[Recovery] Found ${torrents.length} saved torrent(s)`
  );

  for (const torrent of torrents) {
    await recoverTorrent(torrent);
  }

  console.info("[Recovery] Torrent recovery completed");
}