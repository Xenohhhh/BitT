
import type { Request, Response, NextFunction } from "express";
import { addTorrent, getAllTorrents, getTorrent, resumeTorrent, pauseTorrent, removeTorrent } from "../services/torrent.service.js";

export async function createTorrent(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const torrent = await addTorrent(req.body);

        res.status(201).json({
            success: true,
            message: "Torrent added successfully",
            data: torrent
        });
    } catch (error) {
        next(error);
    }
}

export async function listTorrents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const torrent = await getAllTorrents();

        res.status(200).json({
            success: true,
            count: torrent.length,
            data: torrent
        });
    } catch (error) {
        next(error);
    }
}

export async function getTorrentById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const id = req.params.id;

        if (typeof id !== "string" || id.trim().length === 0) {
            res.status(400).json({
                success: false,
                message: "Invalid torrent ID"
            });
            return;
        }

        const torrent = await getTorrent(id);
        res.status(200).json({
            success: true,
            data: torrent
        });
    } catch (error) {
        next(error)
    }
}

export async function resumeTorrentById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try{
        const id = req.params.id
        if(typeof id !== "string" || id.trim().length === 0){
            res.status(400).json({
                success: false,
                message: "Invalid torrent id"
            })
            return;
        }

        const torrent = await resumeTorrent(id);
        res.status(200).json({
            success:true,
            message: "Torrent resumed successfully",
            data: torrent
        })

    }catch(error){
        next(error)
    }
}

export async function pauseTorrentById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try{
        const id = req.params.id
        if(typeof id !== "string" || id.trim().length === 0){
            res.status(400).json({
                success: false,
                message: "Invalid torrent id"
            })
            return;
        }

        const torrent = await pauseTorrent(id);
        res.status(200).json({
            success:true,
            message: "Torrent paused successfully",
            data: torrent
        })

    }catch(error){
        next(error)
    }
}

export async function deleteTorrentById(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = req.params.id;

    if (typeof id !== "string" || id.trim().length === 0) {
      res.status(400).json({
        success: false,
        message: "Invalid torrent ID"
      });
      return;
    }

    await removeTorrent(id);

    res.status(200).json({
      success: true,
      message: "Torrent removed successfully"
    });
  } catch (error) {
    next(error);
  }
}
