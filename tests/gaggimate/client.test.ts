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
});
