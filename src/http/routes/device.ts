import { Router } from "express";
import type { GaggiMateClient } from "../../gaggimate/client.js";

/**
 * Device control API — allows switching profiles and managing settings through the bridge
 * when the GaggiMate web portal is not directly accessible (e.g. remote via Tailscale).
 */
export function createDeviceRouter(gaggimate: GaggiMateClient): Router {
  const router = Router();

  /** List all profiles on the device */
  router.get("/profiles", async (_req, res) => {
    try {
      const profiles = await gaggimate.fetchProfiles();
      const list = (profiles || []).map((p: any) => ({
        id: p?.id ?? null,
        label: p?.label ?? "",
        favorite: Boolean(p?.favorite),
        selected: Boolean(p?.selected),
        type: p?.type ?? null,
        utility: Boolean(p?.utility),
      }));
      res.json({ profiles: list });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(502).json({
        error: "Device unreachable",
        detail: message,
      });
    }
  });

  /** Select a profile by ID (makes it the active profile on the machine) */
  router.post("/profiles/:id/select", async (req, res) => {
    const id = decodeURIComponent(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Profile ID required" });
      return;
    }
    try {
      await gaggimate.selectProfile(id);
      res.json({ ok: true, selected: id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(502).json({
        error: "Select failed",
        detail: message,
      });
    }
  });

  /** Set favorite state for a profile */
  router.post("/profiles/:id/favorite", async (req, res) => {
    const id = decodeURIComponent(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Profile ID required" });
      return;
    }
    const favorite = req.body?.favorite !== false;
    try {
      await gaggimate.favoriteProfile(id, favorite);
      res.json({ ok: true, favorite });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(502).json({
        error: "Favorite update failed",
        detail: message,
      });
    }
  });

  /** Unfavorite a profile (convenience for favorite=false) */
  router.post("/profiles/:id/unfavorite", async (req, res) => {
    const id = decodeURIComponent(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Profile ID required" });
      return;
    }
    try {
      await gaggimate.favoriteProfile(id, false);
      res.json({ ok: true, favorite: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(502).json({
        error: "Unfavorite failed",
        detail: message,
      });
    }
  });

  return router;
}
