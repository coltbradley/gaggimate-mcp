import { Router } from "express";
import type { GaggiMateClient } from "../../gaggimate/client.js";
import type { NotionClient } from "../../notion/client.js";
import type { SyncState } from "../../sync/state.js";
import { config } from "../../config.js";

const startTime = Date.now();
const buildDate = process.env.BUILD_DATE ?? null;
const gitSha = process.env.GIT_SHA ?? null;

export function createHealthRouter(
  gaggimate: GaggiMateClient,
  notion: NotionClient,
  _getSyncState: () => SyncState | null,
): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const [gaggiReachable, notionConnected] = await Promise.all([
        gaggimate.isReachable(),
        notion.isConnected(),
      ]);
      // Public route: booleans and counters only, nothing identifying.
      res.json({
        status: "ok",
        version: buildDate ?? "dev",
        ...(gitSha ? { commit: gitSha.slice(0, 7) } : {}),
        gaggimate: { reachable: gaggiReachable },
        notion: { connected: notionConnected },
        auth: { tokenSet: config.api.token.length > 0 },
        webhook: { secretSet: config.webhook.secret.length > 0 },
        uptime: Math.floor((Date.now() - startTime) / 1000),
      });
    } catch {
      res.status(500).json({
        status: "error",
        error: "health check failed",
      });
    }
  });

  return router;
}
