import { describe, expect, it, vi } from "vitest";
import { createHealthRouter } from "../../src/http/routes/health.js";
import { config } from "../../src/config.js";

function getHealthHandler(router: any): (req: any, res: any) => Promise<void> {
  const routeLayer = router.stack?.find(
    (layer: any) => layer.route?.path === "/" && layer.route?.methods?.get,
  );
  if (!routeLayer) {
    throw new Error("Could not find GET / route handler");
  }
  return routeLayer.route.stack[0].handle;
}

function createResponse(): any {
  const res: any = {
    statusCode: 200,
    jsonBody: undefined,
  };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((payload: any) => {
    res.jsonBody = payload;
    return res;
  });
  return res;
}

describe("health route", () => {
  it("reports webhook signature verification as enabled when secret is set", async () => {
    const previousSecret = config.webhook.secret;
    (config as any).webhook.secret = "token-abc";
    try {
      const gaggimate = {
        host: "192.168.1.10",
        isReachable: vi.fn().mockResolvedValue(true),
        getConnectionDiagnostics: vi.fn().mockReturnValue({
          wsQueueDepth: 2,
          wsPendingResponses: 1,
          wsState: "open",
        }),
      };
      const notion = {
        isConnected: vi.fn().mockResolvedValue(true),
        imageUploadDisabled: null,
      };
      const router = createHealthRouter(gaggimate as any, notion as any, () => null);
      const handler = getHealthHandler(router);
      const res = createResponse();

      await handler({}, res);

      expect(res.statusCode).toBe(200);
      expect(res.jsonBody.webhook).toEqual({ secretSet: true });
      expect(res.jsonBody.gaggimate).toEqual({ reachable: true });
    } finally {
      (config as any).webhook.secret = previousSecret;
    }
  });

  it("reports webhook signature verification as disabled when secret is empty", async () => {
    const previousSecret = config.webhook.secret;
    (config as any).webhook.secret = "";
    try {
      const gaggimate = {
        host: "192.168.1.11",
        isReachable: vi.fn().mockResolvedValue(false),
      };
      const notion = {
        isConnected: vi.fn().mockResolvedValue(false),
        imageUploadDisabled: null,
      };
      const syncState = {
        lastSyncTime: "2026-02-26T00:00:00.000Z",
        lastSyncedShotId: "42",
        totalShotsSynced: 100,
      };
      const router = createHealthRouter(gaggimate as any, notion as any, () => syncState as any);
      const handler = getHealthHandler(router);
      const res = createResponse();

      await handler({}, res);

      expect(res.statusCode).toBe(200);
      expect(res.jsonBody.webhook).toEqual({ secretSet: false });
      expect(res.jsonBody).not.toHaveProperty("lastShotId");
      expect(JSON.stringify(res.jsonBody)).not.toContain("192.168.1.11");
    } finally {
      (config as any).webhook.secret = previousSecret;
    }
  });
});
