import { describe, it, expect, vi } from "vitest";
import express from "express";
import { mountMcpRoutes } from "../../src/mcp/server.js";

function createApp() {
  const app = express();
  app.use(express.json());

  const gaggimate = {
    host: "192.168.1.10",
    isReachable: vi.fn().mockResolvedValue(true),
  };
  const notion = {
    isConnected: vi.fn().mockResolvedValue(true),
    imageUploadDisabled: null,
  };

  mountMcpRoutes(app as any, gaggimate as any, notion as any);
  return app;
}

async function sendRequest(
  app: express.Express,
  method: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = Object.assign(
      {
        method,
        headers: { "content-type": "application/json", ...headers },
        body,
        url: "/mcp",
        path: "/mcp",
      },
      {},
    );
    const res: any = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      body: undefined as unknown,
      headersSent: false,
    };
    res.status = (code: number) => {
      res.statusCode = code;
      return res;
    };
    res.json = (payload: unknown) => {
      res.body = payload;
      res.headersSent = true;
      resolve({ status: res.statusCode, body: payload });
      return res;
    };
    res.send = (payload: unknown) => {
      res.body = payload;
      res.headersSent = true;
      resolve({ status: res.statusCode, body: payload });
      return res;
    };
    res.setHeader = (key: string, value: string) => {
      res.headers[key] = value;
    };
    res.getHeader = (key: string) => res.headers[key];

    // Find matching route and call handler
    const layer = (app as any)._router?.stack?.find(
      (l: any) =>
        l.route?.path === "/mcp" && l.route?.methods?.[method.toLowerCase()],
    );
    if (!layer) {
      reject(new Error(`No handler for ${method} /mcp`));
      return;
    }
    const handler = layer.route.stack[0].handle;
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

describe("MCP server routes", () => {
  it("POST /mcp without session or initialize body returns 400", async () => {
    const app = createApp();
    const result = await sendRequest(app, "post", {}, { jsonrpc: "2.0", method: "tools/list", id: 1 });
    expect(result.status).toBe(400);
    expect((result.body as any).jsonrpc).toBe("2.0");
    expect((result.body as any).error.code).toBe(-32000);
  });

  it("DELETE /mcp without session returns 400", async () => {
    const app = createApp();
    const result = await sendRequest(app, "delete", {});
    expect(result.status).toBe(400);
  });

  it("GET /mcp without session returns 400", async () => {
    const app = createApp();
    const result = await sendRequest(app, "get", {});
    expect(result.status).toBe(400);
  });

  it("POST /mcp with unknown session id returns 400", async () => {
    const app = createApp();
    const result = await sendRequest(
      app,
      "post",
      { "mcp-session-id": "nonexistent-session-id" },
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
    );
    expect(result.status).toBe(400);
    expect((result.body as any).error.code).toBe(-32000);
  });
});
