
import { Router } from "express";
import { createTorrent, listTorrents, getTorrentById, resumeTorrentById, pauseTorrentById } from "../controllers/torrent.controller.js";

const router = Router();

router.post("/", createTorrent);
router.get("/", listTorrents);
router.get("/:id", getTorrentById);
router.post("/:id/pause", pauseTorrentById);
router.post("/:id/resume", resumeTorrentById);

export default router;
