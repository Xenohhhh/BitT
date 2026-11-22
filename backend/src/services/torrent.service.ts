
import { randomUUID } from "node:crypto";

import * as torrentRepository from "../repositories/torrent.repository.js";

import {
    sendEngineRequest
} from "../engine/engine.client.js";

import type {
    TorrentRecord
} from "../repositories/torrent.repository.js";
import { db } from "../database/connection.js";

// Application-level error with an HTTP-compatible status code.
export class TorrentServiceError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number
    ) {
        super(message);
        this.name = "TorrentServiceError";
    }
}

interface AddTorrentInput {
    torrentPath: string;
    savePath: string;
}

interface EngineAddResult {
    success: boolean;
    torrentId: number;
    name: string;
}

function isObject(
    value: unknown
): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function validatePath(
    value: unknown,
    fieldName: string
): string {
    if (
        typeof value !== "string" ||
        value.trim().length === 0
    ) {
        throw new TorrentServiceError(
            `${fieldName} must be a non-empty string`,
            400
        );
    }

    return value.trim();
}

function validateEngineAddResult(
    response: unknown
): EngineAddResult {
    if (!isObject(response)) {
        throw new Error("Invalid engine response");
    }

    const { success, torrentId, name } = response;

    if (
        success !== true ||
        typeof torrentId !== "number" ||
        !Number.isInteger(torrentId) ||
        torrentId < 0 ||
        torrentId > 0xFFFFFFFF ||
        typeof name !== "string" ||
        name.length === 0
    ) {
        throw new Error("Invalid add_torrent response");
    }

    return {
        success,
        torrentId,
        name
    };
}

// Add a torrent to the application and C++ engine.
export async function addTorrent(
    input: AddTorrentInput
): Promise<TorrentRecord> {
    if (!isObject(input)) {
        throw new TorrentServiceError(
            "Invalid request body",
            400
        );
    }

    const torrentPath = validatePath(
        input.torrentPath,
        "torrentPath"
    );

    const savePath = validatePath(
        input.savePath,
        "savePath"
    );

    // Ask the C++ engine to add the torrent.
    // The engine initially adds torrents in a paused state.
    const response = await sendEngineRequest(
        "add_torrent",
        {
            torrentPath,
            savePath
        }
    );

    const engineResult = validateEngineAddResult(response);

    // Generate a permanent application-level identifier.
    const applicationId = randomUUID();

    try {
        // Persist the torrent in SQLite.
        return torrentRepository.create({
            id: applicationId,
            engine_id: engineResult.torrentId,
            name: engineResult.name,
            torrent_path: torrentPath,
            save_path: savePath
        });
    } catch (databaseError) {
        // The engine succeeded, but persistence failed.
        // Attempt to compensate by removing the engine torrent.
        try {
            await sendEngineRequest(
                "remove_torrent",
                {
                    torrentId: engineResult.torrentId
                }
            );
        } catch (cleanupError) {
            console.error(
                "Failed to compensate after database failure:",
                cleanupError
            );
        }

        throw databaseError;
    }
}

// Retrieve all application torrent records.
export function getAllTorrents(): TorrentRecord[] {
    return torrentRepository.findAll();
}

// Retrieve one torrent and its current engine status.
export async function getTorrent(
    id: string
) {
    const torrent = torrentRepository.findById(id);

    if (!torrent) {
        throw new TorrentServiceError(
            "Torrent not found",
            404
        );
    }

    const engineStatus = await sendEngineRequest(
        "get_torrent_status",
        {
            torrentId: torrent.engine_id
        }
    );

    return {
        ...torrent,
        engineStatus
    };
}

// Pause a torrent.

export async function pauseTorrent(id: string): Promise<TorrentRecord> {
    const torrent = torrentRepository.findById(id);

    if (!torrent) {
        throw new TorrentServiceError("Torrent not found", 404);
    }

    await sendEngineRequest("pause_torrent", {
        torrentId: torrent.engine_id
    });

    const updated = torrentRepository.updateDesiredState(id, "paused");

    if (!updated) {
        throw new TorrentServiceError(
            "Failed to update torrent state",
            500
        );
    }

    const updatedTorrent = torrentRepository.findById(id);

    if (!updatedTorrent) {
        throw new TorrentServiceError(
            "Torrent record not found after update",
            500
        );
    }

    return updatedTorrent;
}

export async function resumeTorrent(id: string): Promise<TorrentRecord> {
    const torrent = torrentRepository.findById(id);

    if (!torrent) {
        throw new TorrentServiceError("Torrent not found", 404);
    }

    await sendEngineRequest("resume_torrent", {
        torrentId: torrent.engine_id
    });

    const updated = torrentRepository.updateDesiredState(id, "active");

    if (!updated) {
        throw new TorrentServiceError(
            "Failed to update torrent state",
            500
        );
    }

    const updatedTorrent = torrentRepository.findById(id);

    if (!updatedTorrent) {
        throw new TorrentServiceError(
            "Torrent record not found after update",
            500
        );
    }

    return updatedTorrent;
}


// Remove a torrent from the engine and database.
// Downloaded files are not explicitly deleted.
export async function removeTorrent(
    id: string
): Promise<void> {
    const torrent = torrentRepository.findById(id);

    if (!torrent) {
        throw new TorrentServiceError(
            "Torrent not found",
            404
        );
    }

    await sendEngineRequest(
        "remove_torrent",
        {
            torrentId: torrent.engine_id
        }
    );

    const deleted = torrentRepository.deleteById(id);

    if (!deleted) {
        throw new Error(
            "Torrent was removed from engine but database deletion failed"
        );
    }
}

export function clearEngineId(id: string): boolean {
  const statement = db.prepare(`
    UPDATE torrents
    SET engine_id = NULL
    WHERE id = ?
  `);

  const result = statement.run(id);

  return result.changes > 0;
}