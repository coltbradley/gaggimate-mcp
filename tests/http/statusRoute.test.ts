import { describe, expect, it, vi } from "vitest";
import { createStatusRouter } from "../../src/http/routes/status.js";

function getRouteHandler(router: any): (req: any, res: any) => Promise<void> {
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

describe("status route", () => {
  it("returns JSON with gaggimate reachable, sync state, uptime, and memoryMb", async () => {
    const gaggimate = {
      isReachable: vi.fn().mockResolvedValue(true),
      getConnectionDiagnostics: vi.fn().mockReturnValue({ wsState: "open" }),
    };
    const notion = {};
    const syncState = {
      lastSyncedShotId: "042",
      lastSyncTime: "2026-04-01T10:00:00.000Z",
      totalShotsSynced: 42,
    };

    const router = createStatusRouter(gaggimate as any, notion as any, () => syncState);
    const handler = getRouteHandler(router);
    const res = createResponse();

    await handler({}, res);

    expect(res.jsonBody.gaggimate.reachable).toBe(true);
    expect(res.jsonBody.sync.lastShotId).toBe("042");
    expect(res.jsonBody.sync.lastSyncTime).toBe("2026-04-01T10:00:00.000Z");
    expect(res.jsonBody.sync.totalSynced).toBe(42);
    expect(typeof res.jsonBody.uptime).toBe("number");
    expect(typeof res.jsonBody.memoryMb).toBe("number");
  });

  it("handles unreachable device gracefully", async () => {
    const gaggimate = {
      isReachable: vi.fn().mockRejectedValue(new Error("EHOSTUNREACH")),
      getConnectionDiagnostics: vi.fn().mockReturnValue(null),
    };
    const notion = {};

    const router = createStatusRouter(gaggimate as any, notion as any, () => null);
    const handler = getRouteHandler(router);
    const res = createResponse();

    await handler({}, res);

    expect(res.jsonBody.gaggimate.reachable).toBe(false);
    expect(res.jsonBody.sync.lastShotId).toBeNull();
    expect(res.jsonBody.sync.totalSynced).toBe(0);
  });

  it("returns null sync state fields when no sync has occurred", async () => {
    const gaggimate = {
      isReachable: vi.fn().mockResolvedValue(false),
      getConnectionDiagnostics: vi.fn().mockReturnValue(null),
    };
    const notion = {};

    const router = createStatusRouter(gaggimate as any, notion as any, () => null);
    const handler = getRouteHandler(router);
    const res = createResponse();

    await handler({}, res);

    expect(res.jsonBody.sync.lastShotId).toBeNull();
    expect(res.jsonBody.sync.lastSyncTime).toBeNull();
    expect(res.jsonBody.sync.totalSynced).toBe(0);
  });

  it("includes diagnostics from getConnectionDiagnostics", async () => {
    const diagnostics = { wsState: "open", wsQueueDepth: 0, wsPendingResponses: 0 };
    const gaggimate = {
      isReachable: vi.fn().mockResolvedValue(true),
      getConnectionDiagnostics: vi.fn().mockReturnValue(diagnostics),
    };
    const notion = {};

    const router = createStatusRouter(gaggimate as any, notion as any, () => null);
    const handler = getRouteHandler(router);
    const res = createResponse();

    await handler({}, res);

    expect(res.jsonBody.gaggimate.diagnostics).toEqual(diagnostics);
  });
});
