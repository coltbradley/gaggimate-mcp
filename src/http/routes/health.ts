import { Router } from "express";
import type { GaggiMateClient } from "../../gaggimate/client.js";
import type { SyncState } from "../../sync/state.js";

const startTime = Date.now();
const buildDate = process.env.BUILD_DATE ?? null;
const gitSha = process.env.GIT_SHA ?? null;

export function createHealthRouter(
  gaggimate: GaggiMateClient,
  getSyncState: () => SyncState | null,
): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const gaggiReachable = await gaggimate.isReachable();
      const gaggimateDiagnostics = typeof (gaggimate as any).getConnectionDiagnostics === "function"
        ? (gaggimate as any).getConnectionDiagnostics()
        : null;

      const syncState = getSyncState();

      res.json({
        status: "ok",
        version: buildDate ?? "dev",
        ...(gitSha ? { commit: gitSha.slice(0, 7) } : {}),
        gaggimate: {
          host: gaggimate.host,
          reachable: gaggiReachable,
          ...(gaggimateDiagnostics ? { websocket: gaggimateDiagnostics } : {}),
        },
        lastShotSync: syncState?.lastSyncTime ?? null,
        lastShotId: syncState?.lastSyncedShotId ?? null,
        totalShotsSynced: syncState?.totalShotsSynced ?? 0,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      });
    } catch (error) {
      res.status(500).json({
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  return router;
}
