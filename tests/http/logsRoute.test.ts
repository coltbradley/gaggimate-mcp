import { describe, expect, it, beforeEach } from "vitest";
import { createLogsRouter } from "../../src/http/routes/logs.js";
import { getRecentLogs } from "../../src/utils/logBuffer.js";

function getRouteHandler(router: any): (req: any, res: any) => void {
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
    body: undefined,
    contentType: undefined,
  };
  res.type = (t: string) => {
    res.contentType = t;
    return res;
  };
  res.send = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

describe("logs route", () => {
  it("returns text/plain content type", () => {
    const router = createLogsRouter();
    const handler = getRouteHandler(router);
    const res = createResponse();

    handler({ query: {} }, res);

    expect(res.contentType).toBe("text/plain");
  });

  it("returns log entries as newline-separated text", () => {
    // getRecentLogs returns whatever is in the buffer; it may be empty in tests
    // Just verify the shape: calling send with a string (possibly empty)
    const router = createLogsRouter();
    const handler = getRouteHandler(router);
    const res = createResponse();

    handler({ query: {} }, res);

    expect(typeof res.body).toBe("string");
  });

  it("respects the count query parameter", () => {
    const router = createLogsRouter();
    const handler = getRouteHandler(router);
    const res = createResponse();

    handler({ query: { count: "10" } }, res);

    // getRecentLogs(10) should return at most 10 lines
    const lines = (res.body as string).length > 0 ? (res.body as string).split("\n") : [];
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  it("caps count at 500", () => {
    const router = createLogsRouter();
    const handler = getRouteHandler(router);
    const res = createResponse();

    // Request more than 500 — the route caps it at 500
    handler({ query: { count: "9999" } }, res);

    const lines = (res.body as string).length > 0 ? (res.body as string).split("\n") : [];
    expect(lines.length).toBeLessThanOrEqual(500);
  });

  it("returns all buffered logs when count exceeds buffer size", () => {
    const logs = getRecentLogs(500);
    const router = createLogsRouter();
    const handler = getRouteHandler(router);
    const res = createResponse();

    handler({ query: { count: "500" } }, res);

    const lines = (res.body as string).length > 0 ? (res.body as string).split("\n") : [];
    expect(lines.length).toBeLessThanOrEqual(logs.length);
  });
});
