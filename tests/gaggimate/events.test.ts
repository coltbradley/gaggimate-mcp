import { describe, expect, it, vi } from "vitest";
import { GaggiMateClient } from "../../src/gaggimate/client.js";

function createClient() {
  return new GaggiMateClient({
    host: "gaggimate.local",
    protocol: "ws",
    requestTimeout: 1000,
  });
}

describe("GaggiMateClient event listener", () => {
  it("registers and fires event callbacks for evt: messages (no rid)", () => {
    const client = createClient() as any;
    const received: any[] = [];

    client.on("evt:status", (data: any) => received.push(data));
    client.handleSharedMessage(JSON.stringify({ tp: "evt:status", brewState: "brewing", progress: 0.5 }));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ tp: "evt:status", brewState: "brewing", progress: 0.5 });
  });

  it("does NOT fire event callbacks for response messages that have a rid", () => {
    const client = createClient() as any;
    const received: any[] = [];

    client.on("res:profiles:list", (data: any) => received.push(data));

    // Register a real pending request so the rid lookup works
    const rid = "bridge-test-rid-001";
    const resolve = vi.fn();
    const reject = vi.fn();
    const timeoutHandle = setTimeout(() => {}, 9999);
    client.pendingRequests.set(rid, {
      resType: "res:profiles:list",
      extractResult: (res: any) => res.profiles,
      errorPrefix: "test",
      resolve,
      reject,
      timeoutHandle,
    });

    client.handleSharedMessage(JSON.stringify({ tp: "res:profiles:list", rid, profiles: [] }));

    // The event listener must NOT have been called — this was a request-response
    expect(received).toHaveLength(0);
    // But the pending request resolver must have fired
    expect(resolve).toHaveBeenCalledWith([]);

    clearTimeout(timeoutHandle);
  });

  it("supports multiple listeners for the same event type", () => {
    const client = createClient() as any;
    const callbackA = vi.fn();
    const callbackB = vi.fn();

    client.on("evt:status", callbackA);
    client.on("evt:status", callbackB);

    client.handleSharedMessage(JSON.stringify({ tp: "evt:status", brewState: "idle" }));

    expect(callbackA).toHaveBeenCalledTimes(1);
    expect(callbackB).toHaveBeenCalledTimes(1);
    expect(callbackA).toHaveBeenCalledWith(expect.objectContaining({ brewState: "idle" }));
    expect(callbackB).toHaveBeenCalledWith(expect.objectContaining({ brewState: "idle" }));
  });

  it("removes listeners with off()", () => {
    const client = createClient() as any;
    const callback = vi.fn();

    client.on("evt:status", callback);
    client.off("evt:status", callback);

    client.handleSharedMessage(JSON.stringify({ tp: "evt:status", brewState: "idle" }));

    expect(callback).not.toHaveBeenCalled();
  });

  it("error in one listener does not crash others", () => {
    const client = createClient() as any;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const goodCallback = vi.fn();

    const badCallback = vi.fn(() => {
      throw new Error("listener exploded");
    });

    client.on("evt:status", badCallback);
    client.on("evt:status", goodCallback);

    expect(() => {
      client.handleSharedMessage(JSON.stringify({ tp: "evt:status", brewState: "done" }));
    }).not.toThrow();

    expect(badCallback).toHaveBeenCalledTimes(1);
    expect(goodCallback).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("evt:status"),
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("ignores messages without a tp field", () => {
    const client = createClient() as any;
    const callback = vi.fn();

    client.on("evt:status", callback);

    // No tp field — should be silently dropped
    client.handleSharedMessage(JSON.stringify({ rid: "abc", result: "something" }));

    expect(callback).not.toHaveBeenCalled();
  });

  it("off() is a no-op for a listener that was never registered", () => {
    const client = createClient() as any;
    const callback = vi.fn();

    expect(() => client.off("evt:status", callback)).not.toThrow();
  });
});
