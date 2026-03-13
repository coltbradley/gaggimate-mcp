import express from "express";
import type { GaggiMateClient } from "../gaggimate/client.js";
import type { ShotCache } from "../sync/shotCache.js";
import type { SyncState } from "../sync/state.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createHealthRouter } from "./routes/health.js";
import { createDeviceRouter } from "./routes/device.js";
import { createShotsRouter } from "./routes/shots.js";

export interface ServerOptions {
  apiToken: string;
  getSyncState: () => SyncState | null;
}

export function createServer(
  gaggimate: GaggiMateClient,
  shotCache: ShotCache,
  options: ServerOptions,
): express.Express {
  const app = express();
  app.use(express.json());

  if (options.apiToken) {
    app.use(createAuthMiddleware(options.apiToken));
  }

  app.use("/health", createHealthRouter(gaggimate, options.getSyncState));
  app.use("/device", createDeviceRouter(gaggimate));
  app.use("/shots", createShotsRouter(shotCache));

  return app;
}
