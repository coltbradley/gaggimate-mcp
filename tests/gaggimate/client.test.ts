import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
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

  it("dedupes concurrent selectProfile commands for the same profile id", async () => {
    const client = createClient() as any;
    const responseGate = createDeferred();

    const fakeWs = {
      send: vi.fn((payload: string, cb?: (error?: Error) => void) => {
        cb?.();
        const parsed = JSON.parse(payload);
        responseGate.promise.then(() => {
          client.handleSharedMessage(JSON.stringify({
            tp: "res:profiles:select",
            rid: parsed.rid,
          }));
        });
      }),
    };
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    const first = client.selectProfile("profile-123");
    const second = client.selectProfile("profile-123");

    await vi.waitFor(() => {
      expect(fakeWs.send).toHaveBeenCalledTimes(1);
    });

    responseGate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(fakeWs.send).toHaveBeenCalledTimes(1);
  });

  it("dedupes rapid repeated selectProfile calls after success", async () => {
    const client = createClient() as any;
    const fakeWs = {
      send: vi.fn((payload: string, cb?: (error?: Error) => void) => {
        cb?.();
        const parsed = JSON.parse(payload);
        client.handleSharedMessage(JSON.stringify({
          tp: "res:profiles:select",
          rid: parsed.rid,
        }));
      }),
    };
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    await client.selectProfile("profile-abc");
    await client.selectProfile("profile-abc");

    // second call is deduped by short completion window
    expect(fakeWs.send).toHaveBeenCalledTimes(1);
  });

  it("does not dedupe opposite favorite actions", async () => {
    const client = createClient() as any;
    const sentTypes: string[] = [];
    const fakeWs = {
      send: vi.fn((payload: string, cb?: (error?: Error) => void) => {
        cb?.();
        const parsed = JSON.parse(payload);
        sentTypes.push(parsed.tp);
        client.handleSharedMessage(JSON.stringify({
          tp: `res:profiles:${parsed.tp.endsWith(":favorite") ? "favorite" : "unfavorite"}`,
          rid: parsed.rid,
        }));
      }),
    };
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    await client.favoriteProfile("profile-fav", true);
    await client.favoriteProfile("profile-fav", false);

    expect(fakeWs.send).toHaveBeenCalledTimes(2);
    expect(sentTypes).toEqual(["req:profiles:favorite", "req:profiles:unfavorite"]);
  });

  it("withHttpExclusion closes an open WebSocket before executing the function", async () => {
    vi.useFakeTimers();
    const client = createClient() as any;

    const closeSpy = vi.fn();
    const fakeWs = {
      readyState: WebSocket.OPEN,
      close: closeSpy,
    };
    client.sharedWs = fakeWs;

    let executedAfterClose = false;
    const fn = vi.fn(async () => {
      executedAfterClose = closeSpy.mock.calls.length > 0;
      return "result";
    });

    const resultPromise = client.withHttpExclusion(fn);
    // Advance past the 500ms close delay
    await vi.advanceTimersByTimeAsync(600);
    const result = await resultPromise;

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(executedAfterClose).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toBe("result");

    vi.useRealTimers();
  });

  it("withHttpExclusion executes immediately when no WebSocket is open", async () => {
    const client = createClient() as any;
    expect(client.sharedWs).toBeNull();

    const fn = vi.fn(async () => "no-ws-result");
    const result = await client.withHttpExclusion(fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toBe("no-ws-result");
  });

  it("withHttpExclusion skips close when WebSocket is not OPEN", async () => {
    const client = createClient() as any;

    const closeSpy = vi.fn();
    const fakeWs = {
      readyState: WebSocket.CONNECTING,
      close: closeSpy,
    };
    client.sharedWs = fakeWs;

    const fn = vi.fn(async () => "connecting-result");
    const result = await client.withHttpExclusion(fn);

    expect(closeSpy).not.toHaveBeenCalled();
    expect(result).toBe("connecting-result");
  });

  it("fetchShotMetadata parses res:history:list shots array into ShotMetadataEntry objects", async () => {
    const client = createClient() as any;
    const fakeWs = {
      send: vi.fn((payload: string, cb?: (error?: Error) => void) => {
        cb?.();
        const parsed = JSON.parse(payload);
        client.handleSharedMessage(JSON.stringify({
          tp: "res:history:list",
          rid: parsed.rid,
          shots: [
            { id: 42, timestamp: 1700000000, profile: "Classic Espresso", duration: 28, volume: 36, sampleCount: 120 },
            { id: 43, ts: 1700000060, profileLabel: "Ristretto" },
          ],
        }));
      }),
    };
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    const metadata = await client.fetchShotMetadata();

    expect(metadata).toHaveLength(2);
    expect(metadata[0]).toMatchObject({
      id: 42,
      timestamp: 1700000000,
      profile: "Classic Espresso",
      duration: 28,
      volume: 36,
      sampleCount: 120,
    });
    expect(metadata[1]).toMatchObject({
      id: 43,
      timestamp: 1700000060,
      profile: "Ristretto",
    });
  });

  it("fetchShotMetadata returns empty array on WS error", async () => {
    const client = createClient() as any;
    client.getOrCreateWs = vi.fn().mockRejectedValue(new Error("connection refused"));

    const metadata = await client.fetchShotMetadata();
    expect(metadata).toEqual([]);
  });

  it("fetchShotMetadata handles entries array field name as fallback", async () => {
    const client = createClient() as any;
    const fakeWs = {
      send: vi.fn((payload: string, cb?: (error?: Error) => void) => {
        cb?.();
        const parsed = JSON.parse(payload);
        client.handleSharedMessage(JSON.stringify({
          tp: "res:history:list",
          rid: parsed.rid,
          entries: [{ id: 7, timestamp: 1700000100 }],
        }));
      }),
    };
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    const metadata = await client.fetchShotMetadata();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].id).toBe(7);
  });

  it("keeps completed-command dedupe cache bounded", async () => {
    const client = createClient() as any;
    const fakeWs = {
      send: vi.fn((payload: string, cb?: (error?: Error) => void) => {
        cb?.();
        const parsed = JSON.parse(payload);
        client.handleSharedMessage(JSON.stringify({
          tp: "res:profiles:select",
          rid: parsed.rid,
        }));
      }),
    };
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    for (let i = 0; i < 1105; i += 1) {
      // Unique IDs avoid short-window dedupe and force cache growth checks.
      // eslint-disable-next-line no-await-in-loop
      await client.selectProfile(`profile-${i}`);
    }

    expect(client.recentlyCompletedCommandDedupUntil.size).toBeLessThanOrEqual(1000);
    expect(fakeWs.send).toHaveBeenCalledTimes(1105);
  });
});
