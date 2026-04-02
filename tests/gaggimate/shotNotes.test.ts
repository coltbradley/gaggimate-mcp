import { describe, expect, it, vi } from "vitest";
import { GaggiMateClient } from "../../src/gaggimate/client.js";
import type { ShotNotes } from "../../src/gaggimate/types.js";

function createClient() {
  return new GaggiMateClient({
    host: "gaggimate.local",
    protocol: "ws",
    requestTimeout: 1000,
  });
}

function makeFakeWs(client: any, resType: string, responseOverrides: Record<string, any> = {}) {
  return {
    send: vi.fn((payload: string, cb?: (error?: Error) => void) => {
      cb?.();
      const parsed = JSON.parse(payload);
      client.handleSharedMessage(
        JSON.stringify({ tp: resType, rid: parsed.rid, ...responseOverrides }),
      );
    }),
  };
}

describe("ShotNotes type shape", () => {
  it("has the expected fields at compile time and runtime", () => {
    const notes: ShotNotes = {
      id: 42,
      rating: 4,
      beanType: "Ethiopia Yirgacheffe",
      doseIn: 18.5,
      doseOut: 38,
      ratio: "1:2",
      grindSetting: "15",
      balanceTaste: "balanced",
      notes: "Tastes floral and bright.",
      timestamp: 1707900000,
    };

    expect(notes.id).toBe(42);
    expect(notes.rating).toBe(4);
    expect(notes.beanType).toBe("Ethiopia Yirgacheffe");
    expect(notes.doseIn).toBe(18.5);
    expect(notes.doseOut).toBe(38);
    expect(notes.ratio).toBe("1:2");
    expect(notes.grindSetting).toBe("15");
    expect(notes.balanceTaste).toBe("balanced");
    expect(notes.notes).toBe("Tastes floral and bright.");
    expect(notes.timestamp).toBe(1707900000);
  });

  it("allows all optional fields to be omitted", () => {
    const minimal: ShotNotes = { id: 1 };
    expect(minimal.id).toBe(1);
    expect(minimal.rating).toBeUndefined();
    expect(minimal.beanType).toBeUndefined();
  });

  it("enforces the balanceTaste literal union", () => {
    const bitter: ShotNotes = { id: 1, balanceTaste: "bitter" };
    const balanced: ShotNotes = { id: 1, balanceTaste: "balanced" };
    const sour: ShotNotes = { id: 1, balanceTaste: "sour" };
    expect(bitter.balanceTaste).toBe("bitter");
    expect(balanced.balanceTaste).toBe("balanced");
    expect(sour.balanceTaste).toBe("sour");
  });
});

describe("GaggiMateClient.fetchShotNotes", () => {
  it("sends req:history:notes:get with the shot id and returns the notes", async () => {
    const client = createClient() as any;
    const expectedNotes: ShotNotes = {
      id: 7,
      rating: 5,
      beanType: "Kenya AB",
      doseIn: 18,
      doseOut: 36,
      grindSetting: "12",
      balanceTaste: "balanced",
    };

    const fakeWs = {
      send: vi.fn((payload: string, cb?: (error?: Error) => void) => {
        cb?.();
        const parsed = JSON.parse(payload);
        expect(parsed.tp).toBe("req:history:notes:get");
        expect(parsed.id).toBe(7);
        client.handleSharedMessage(
          JSON.stringify({ tp: "res:history:notes:get", rid: parsed.rid, notes: expectedNotes }),
        );
      }),
    };
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    const result = await client.fetchShotNotes(7);
    expect(result).toEqual(expectedNotes);
    expect(fakeWs.send).toHaveBeenCalledTimes(1);
  });

  it("returns null when the device responds with an error (notes may not exist)", async () => {
    const client = createClient() as any;
    const fakeWs = {
      send: vi.fn((payload: string, cb?: (error?: Error) => void) => {
        cb?.();
        const parsed = JSON.parse(payload);
        client.handleSharedMessage(
          JSON.stringify({ tp: "res:history:notes:get", rid: parsed.rid, error: "Not found" }),
        );
      }),
    };
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    const result = await client.fetchShotNotes(99);
    expect(result).toBeNull();
  });

  it("returns null when the WebSocket connection fails", async () => {
    const client = createClient() as any;
    client.getOrCreateWs = vi.fn().mockRejectedValue(new Error("Connection refused"));

    const result = await client.fetchShotNotes(1);
    expect(result).toBeNull();
  });

  it("returns null when notes field is absent in a successful response", async () => {
    const client = createClient() as any;
    const fakeWs = makeFakeWs(client, "res:history:notes:get", {});
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    const result = await client.fetchShotNotes(3);
    expect(result).toBeNull();
  });
});

describe("GaggiMateClient.saveShotNotes", () => {
  it("sends req:history:notes:save with the shot id and note fields merged", async () => {
    const client = createClient() as any;
    const capturedPayloads: any[] = [];

    const fakeWs = {
      send: vi.fn((payload: string, cb?: (error?: Error) => void) => {
        cb?.();
        const parsed = JSON.parse(payload);
        capturedPayloads.push(parsed);
        client.handleSharedMessage(
          JSON.stringify({ tp: "res:history:notes:save", rid: parsed.rid }),
        );
      }),
    };
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    await client.saveShotNotes(12, {
      rating: 4,
      beanType: "Guatemala Huehuetenango",
      grindSetting: "13",
      balanceTaste: "sour",
    });

    expect(fakeWs.send).toHaveBeenCalledTimes(1);
    const sent = capturedPayloads[0];
    expect(sent.tp).toBe("req:history:notes:save");
    expect(sent.id).toBe(12);
    expect(sent.rating).toBe(4);
    expect(sent.beanType).toBe("Guatemala Huehuetenango");
    expect(sent.grindSetting).toBe("13");
    expect(sent.balanceTaste).toBe("sour");
  });

  it("propagates errors from the device (save failure is meaningful)", async () => {
    const client = createClient() as any;
    const fakeWs = {
      send: vi.fn((payload: string, cb?: (error?: Error) => void) => {
        cb?.();
        const parsed = JSON.parse(payload);
        client.handleSharedMessage(
          JSON.stringify({ tp: "res:history:notes:save", rid: parsed.rid, error: "Storage full" }),
        );
      }),
    };
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    await expect(client.saveShotNotes(5, { notes: "Great shot" })).rejects.toThrow("Storage full");
  });

  it("propagates WebSocket send errors", async () => {
    const client = createClient() as any;
    const fakeWs = {
      send: vi.fn((_payload: string, cb?: (error?: Error) => void) => {
        cb?.(new Error("write EPIPE"));
      }),
    };
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    await expect(client.saveShotNotes(8, { rating: 3 })).rejects.toThrow("WebSocket send failed: write EPIPE");
  });

  it("resolves to void on success", async () => {
    const client = createClient() as any;
    const fakeWs = makeFakeWs(client, "res:history:notes:save");
    client.getOrCreateWs = vi.fn().mockResolvedValue(fakeWs);

    const result = await client.saveShotNotes(20, { rating: 5 });
    expect(result).toBeUndefined();
  });
});
