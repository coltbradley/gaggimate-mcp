import { describe, expect, it, vi } from "vitest";
import { GaggiMateClient } from "../../src/gaggimate/client.js";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createClient() {
  return new GaggiMateClient({
    host: "gaggimate.local",
    protocol: "ws",
    requestTimeout: 1000,
  });
}

describe("GaggiMateClient WebSocket request flow", () => {
  it("serializes requests so only one WS round-trip is in flight at a time", async () => {
    const client = createClient() as any;
    const firstCanRespond = createDeferred();
    const sentPayloads: Array<{ tp: string; rid: string }> = [];

    const fakeWs = {
      send: vi.fn((payload: string, cb?: (error?: Error) => void) => {
        const parsed = JSON.parse(payload);
        sentPayloads.push(parsed);
        cb?.();
        if (parsed.tp === "req:first") {
          firstCanRespond.promise.then(() => {
            client.handleSharedMessage(JSON.stringify({
              tp: "res:first",
              rid: parsed.rid,
              result: "first-ok",
            }));
          });
        } else {
          client.handleSharedMessage(JSON.stringify({
            tp: "res:second",
            rid: parsed.rid,
            result: "second-ok",
          }));
        }
      }),
    };

    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    const first = client.sendWsRequest({
      reqType: "req:first",
      resType: "res:first",
      extractResult: (res: any) => res.result,
      errorPrefix: "first failed",
    });
    const second = client.sendWsRequest({
      reqType: "req:second",
      resType: "res:second",
      extractResult: (res: any) => res.result,
      errorPrefix: "second failed",
    });

    await vi.waitFor(() => {
      expect(fakeWs.send).toHaveBeenCalledTimes(1);
    });
    expect(sentPayloads[0]?.tp).toBe("req:first");

    firstCanRespond.resolve();
    await expect(first).resolves.toBe("first-ok");
    await expect(second).resolves.toBe("second-ok");

    expect(fakeWs.send).toHaveBeenCalledTimes(2);
    expect(sentPayloads[1]?.tp).toBe("req:second");
  });

  it("rejects immediately when ws.send returns an error", async () => {
    const client = createClient() as any;
    const fakeWs = {
      send: vi.fn((_payload: string, cb?: (error?: Error) => void) => {
        cb?.(new Error("socket write failed"));
      }),
    };
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    await expect(client.sendWsRequest({
      reqType: "req:test",
      resType: "res:test",
      extractResult: (res: any) => res,
      errorPrefix: "test failed",
    })).rejects.toThrow("WebSocket send failed: socket write failed");
  });

  it("continues processing queued requests after a failed send", async () => {
    const client = createClient() as any;
    const fakeWs = {
      send: vi.fn((payload: string, cb?: (error?: Error) => void) => {
        const parsed = JSON.parse(payload);
        if (parsed.tp === "req:first") {
          cb?.(new Error("first failed"));
          return;
        }
        cb?.();
        client.handleSharedMessage(JSON.stringify({
          tp: "res:second",
          rid: parsed.rid,
          result: "second-ok",
        }));
      }),
    };
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    const first = client.sendWsRequest({
      reqType: "req:first",
      resType: "res:first",
      extractResult: (res: any) => res,
      errorPrefix: "first failed",
    });
    const second = client.sendWsRequest({
      reqType: "req:second",
      resType: "res:second",
      extractResult: (res: any) => res.result,
      errorPrefix: "second failed",
    });

    await expect(first).rejects.toThrow("WebSocket send failed: first failed");
    await expect(second).resolves.toBe("second-ok");
    expect(fakeWs.send).toHaveBeenCalledTimes(2);
  });

  it("exposes websocket diagnostics for queue depth and pending responses", async () => {
    const client = createClient() as any;
    const gate = createDeferred();
    const fakeWs = {
      readyState: 1, // OPEN
      send: vi.fn((payload: string, cb?: (error?: Error) => void) => {
        cb?.();
        const parsed = JSON.parse(payload);
        gate.promise.then(() => {
          client.handleSharedMessage(JSON.stringify({
            tp: "res:test",
            rid: parsed.rid,
            result: "ok",
          }));
        });
      }),
    };
    client.sharedWs = fakeWs;
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    const request = client.sendWsRequest({
      reqType: "req:test",
      resType: "res:test",
      extractResult: (res: any) => res.result,
      errorPrefix: "test failed",
    });

    await vi.waitFor(() => {
      const diagnostics = client.getConnectionDiagnostics();
      expect(diagnostics.wsState).toBe("open");
      expect(diagnostics.wsQueueDepth).toBe(1);
      expect(diagnostics.wsPendingResponses).toBe(1);
    });

    gate.resolve();
    await expect(request).resolves.toBe("ok");

    const diagnosticsAfter = client.getConnectionDiagnostics();
    expect(diagnosticsAfter.wsQueueDepth).toBe(0);
    expect(diagnosticsAfter.wsPendingResponses).toBe(0);
  });

  it("resets a stalled connecting socket when request timeout is hit", async () => {
    vi.useFakeTimers();
    const client = createClient() as any;

    const connectingWs = {
      readyState: 0, // CONNECTING
      removeAllListeners: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
    };
    client.sharedWs = connectingWs;
    client.sharedWsConnectPromise = Promise.resolve(connectingWs);
    client.getOrCreateWs = vi.fn().mockReturnValue(new Promise(() => {}));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const request = client.sendWsRequest({
        reqType: "req:timeout",
        resType: "res:timeout",
        extractResult: (res: any) => res,
        errorPrefix: "timeout failed",
      });
      const requestResult = request.then(
        () => ({ ok: true } as const),
        (error) => ({ ok: false, error } as const),
      );

      await vi.advanceTimersByTimeAsync(1001);

      const result = await requestResult;
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected timeout rejection");
      }
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toContain("Request timeout");
      expect(connectingWs.removeAllListeners).toHaveBeenCalledTimes(1);
      expect(connectingWs.terminate).toHaveBeenCalledTimes(1);
      expect(client.sharedWs).toBeNull();
      expect(client.sharedWsConnectPromise).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("GaggiMate WS connect stalled"),
      );
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
