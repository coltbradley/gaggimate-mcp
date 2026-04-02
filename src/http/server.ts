import express from "express";
import type { GaggiMateClient } from "../gaggimate/client.js";
import type { NotionClient } from "../notion/client.js";
import type { SyncState } from "../sync/state.js";
import { createHealthRouter } from "./routes/health.js";
import { createWebhookRouter } from "./routes/webhook.js";
import { createDeviceRouter } from "./routes/device.js";
import { createLogsRouter } from "./routes/logs.js";
import { createStatusRouter } from "./routes/status.js";
import { getControlPanelHtml } from "./controlPanelHtml.js";
import { mountMcpRoutes } from "../mcp/server.js";

export interface ServerOptions {
  getSyncState: () => SyncState | null;
}

export function createServer(
  gaggimate: GaggiMateClient,
  notion: NotionClient,
  options: ServerOptions,
): express.Express {
  const app = express();

  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  }));

  app.use("/health", createHealthRouter(gaggimate, notion, options.getSyncState));
  app.use("/webhook", createWebhookRouter(gaggimate, notion));
  app.use("/api/device", createDeviceRouter(gaggimate, notion));
  app.use("/logs", createLogsRouter());
  app.use("/status", createStatusRouter(gaggimate, notion, options.getSyncState));

  app.get("/control", (_req, res) => {
    res.type("html").send(getControlPanelHtml("/api/device"));
  });

  mountMcpRoutes(app, gaggimate, notion);

  return app;
}
