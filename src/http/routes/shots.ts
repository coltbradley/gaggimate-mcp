import { Router } from "express";
import type { ShotCache } from "../../sync/shotCache.js";

export function createShotsRouter(cache: ShotCache): Router {
  const router = Router();

  router.get("/latest", (_req, res) => {
    const latest = cache.latest();
    if (!latest) {
      res.status(404).json({ error: "SHOT_NOT_FOUND", message: "No shots in cache" });
      return;
    }
    res.json(latest);
  });

  router.get("/new", (req, res) => {
    const since = req.query.since as string | undefined;
    if (!since) {
      res.status(400).json({ error: "MISSING_PARAM", message: "since query parameter required" });
      return;
    }
    const shots = cache.newSince(since);
    res.json({ shots, count: shots.length });
  });

  router.get("/:id", (req, res) => {
    const shot = cache.read(req.params.id);
    if (!shot) {
      res.status(404).json({ error: "SHOT_NOT_FOUND", message: `Shot ${req.params.id} not found` });
      return;
    }
    res.json(shot);
  });

  return router;
}
