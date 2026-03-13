import { Router } from "express";
import type { GaggiMateClient } from "../../gaggimate/client.js";

export function createDeviceRouter(gaggimate: GaggiMateClient): Router {
  const router = Router();

  router.get("/profiles", async (_req, res) => {
    try {
      const profiles = await gaggimate.fetchProfiles();
      res.json({
        profiles: (profiles || []).map((p: any) => ({
          id: p.id ?? null,
          label: p.label ?? "",
          favorite: Boolean(p.favorite),
          selected: Boolean(p.selected),
          type: p.type ?? null,
          utility: Boolean(p.utility),
        })),
        source: "device",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(502).json({ error: "DEVICE_OFFLINE", message });
    }
  });

  router.post("/profiles/push", async (req, res) => {
    const { profile, select } = req.body || {};
    if (!profile) {
      res.status(400).json({ error: "MISSING_PARAM", message: "profile field required" });
      return;
    }

    try {
      const saved = await gaggimate.saveProfile(profile);
      const profileId = saved?.id || profile.id;

      if (select && profileId) {
        try {
          await gaggimate.selectProfile(profileId);
          res.json({ pushed: true, selected: true, profileId });
        } catch (selectErr) {
          res.status(207).json({
            pushed: true,
            selected: false,
            profileId,
            error: "SELECT_FAILED",
            message: selectErr instanceof Error ? selectErr.message : "Select failed",
          });
        }
      } else {
        res.json({ pushed: true, selected: false, profileId });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(502).json({ error: "DEVICE_PUSH_FAILED", message });
    }
  });

  router.post("/profiles/:id/select", async (req, res) => {
    const id = decodeURIComponent(req.params.id);
    try {
      await gaggimate.selectProfile(id);
      res.json({ ok: true, selected: id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(502).json({ error: "DEVICE_OFFLINE", message });
    }
  });

  router.post("/profiles/:id/favorite", async (req, res) => {
    const id = decodeURIComponent(req.params.id);
    const favorite = req.body?.favorite !== false;
    try {
      await gaggimate.favoriteProfile(id, favorite);
      res.json({ ok: true, favorite });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(502).json({ error: "DEVICE_OFFLINE", message });
    }
  });

  router.delete("/profiles/:id", async (req, res) => {
    const id = decodeURIComponent(req.params.id);
    try {
      await gaggimate.deleteProfile(id);
      res.json({ ok: true, deleted: id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(502).json({ error: "DEVICE_OFFLINE", message });
    }
  });

  return router;
}
