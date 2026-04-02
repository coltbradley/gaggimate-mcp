import { Router } from "express";
import type { GaggiMateClient } from "../../gaggimate/client.js";
import type { NotionClient } from "../../notion/client.js";

export function createStatusRouter(
  gaggimate: GaggiMateClient,
  notion: NotionClient,
  getSyncState: () => any,
): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    const [reachable] = await Promise.allSettled([gaggimate.isReachable()]);
    const state = getSyncState();
    res.json({
      gaggimate: {
        reachable: reachable.status === "fulfilled" && reachable.value,
        diagnostics: typeof (gaggimate as any).getConnectionDiagnostics === "function"
          ? (gaggimate as any).getConnectionDiagnostics()
          : null,
      },
      sync: {
        lastShotId: state?.lastSyncedShotId ?? null,
        lastSyncTime: state?.lastSyncTime ?? null,
        totalSynced: state?.totalShotsSynced ?? 0,
      },
      uptime: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
  });
  return router;
}
