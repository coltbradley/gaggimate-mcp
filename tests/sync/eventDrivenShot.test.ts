import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShotPoller } from "../../src/sync/shotPoller.js";

function makeGaggimate() {
  return {
    fetchShotHistory: vi.fn().mockResolvedValue([]),
    fetchShot: vi.fn(),
    fetchShotNotes: vi.fn().mockResolvedValue(null),
    fetchProfiles: vi.fn(),
    uploadBrewChart: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function makeNotion() {
  return {
    findBrewByShotId: vi.fn(),
    hasProfileByName: vi.fn(),
    normalizeProfileName: vi.fn(),
    createDraftProfile: vi.fn(),
    uploadProfileImage: vi.fn(),
    createBrew: vi.fn(),
    updateBrewFromData: vi.fn(),
    brewHasProfileImage: vi.fn(),
    imageUploadDisabled: null,
    uploadBrewChart: vi.fn(),
  };
}

describe("Event-driven shot detection", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "event-shot-test-"));
    vi.useFakeTimers();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("registers evt:status listener on start()", () => {
    const gaggimate = makeGaggimate();
    const notion = makeNotion();

    const poller = new ShotPoller(gaggimate as any, notion as any, {
      intervalMs: 300000,
      dataDir,
      recentShotLookbackCount: 5,
      brewTitleTimeZone: "America/Los_Angeles",
      repairIntervalMs: -1,
    });

    poller.start();
    expect(gaggimate.on).toHaveBeenCalledWith("evt:status", expect.any(Function));
    poller.stop();
  });

  it("unregisters evt:status listener on stop()", () => {
    const gaggimate = makeGaggimate();
    const notion = makeNotion();

    const poller = new ShotPoller(gaggimate as any, notion as any, {
      intervalMs: 300000,
      dataDir,
      recentShotLookbackCount: 5,
      brewTitleTimeZone: "America/Los_Angeles",
      repairIntervalMs: -1,
    });

    poller.start();

    const registeredHandler = gaggimate.on.mock.calls.find(
      (call: any[]) => call[0] === "evt:status"
    )?.[1];
    expect(registeredHandler).toBeDefined();

    poller.stop();
    expect(gaggimate.off).toHaveBeenCalledWith("evt:status", registeredHandler);
  });

  it("triggers poll after 2s when process.a transitions from 1 to 0 (brew complete)", async () => {
    const gaggimate = makeGaggimate();
    const notion = makeNotion();

    const poller = new ShotPoller(gaggimate as any, notion as any, {
      intervalMs: 300000,
      dataDir,
      recentShotLookbackCount: 5,
      brewTitleTimeZone: "America/Los_Angeles",
      repairIntervalMs: -1,
    });

    const pollSpy = vi.spyOn(poller as any, "poll");

    poller.start();
    await Promise.resolve();

    const handler = gaggimate.on.mock.calls.find(
      (call: any[]) => call[0] === "evt:status"
    )?.[1] as (event: any) => void;

    // Simulate: device starts brewing (process.a=1, process.s="brew")
    handler({ process: { a: 1, s: "brew" } });
    expect(pollSpy).toHaveBeenCalledTimes(1); // only the start() immediate poll

    // Simulate: brew completes (process.a=0)
    handler({ process: { a: 0 } });

    // Poll should not fire immediately — scheduled after 2s
    expect(pollSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(pollSpy).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it("triggers poll when infusion phase ends", async () => {
    const gaggimate = makeGaggimate();
    const notion = makeNotion();

    const poller = new ShotPoller(gaggimate as any, notion as any, {
      intervalMs: 300000,
      dataDir,
      recentShotLookbackCount: 5,
      brewTitleTimeZone: "America/Los_Angeles",
      repairIntervalMs: -1,
    });

    const pollSpy = vi.spyOn(poller as any, "poll");

    poller.start();
    await Promise.resolve();

    const handler = gaggimate.on.mock.calls.find(
      (call: any[]) => call[0] === "evt:status"
    )?.[1] as (event: any) => void;

    // Preinfusion active
    handler({ process: { a: 1, s: "infusion" } });
    // Shot completes
    handler({ process: { a: 0 } });

    await vi.advanceTimersByTimeAsync(2000);
    expect(pollSpy).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it("does NOT trigger poll for non-brew state transitions", async () => {
    const gaggimate = makeGaggimate();
    const notion = makeNotion();

    const poller = new ShotPoller(gaggimate as any, notion as any, {
      intervalMs: 300000,
      dataDir,
      recentShotLookbackCount: 5,
      brewTitleTimeZone: "America/Los_Angeles",
      repairIntervalMs: -1,
    });

    const pollSpy = vi.spyOn(poller as any, "poll");

    poller.start();
    await Promise.resolve();

    const handler = gaggimate.on.mock.calls.find(
      (call: any[]) => call[0] === "evt:status"
    )?.[1] as (event: any) => void;

    // Status events with no active brew (a=0 or absent)
    handler({ process: { a: 0, s: "idle" } });
    handler({ process: { a: 0, s: "heating" } });
    handler({});

    await vi.advanceTimersByTimeAsync(5000);

    // Only the initial poll from start() should have fired
    expect(pollSpy).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it("does NOT trigger poll while brew stays active", async () => {
    const gaggimate = makeGaggimate();
    const notion = makeNotion();

    const poller = new ShotPoller(gaggimate as any, notion as any, {
      intervalMs: 300000,
      dataDir,
      recentShotLookbackCount: 5,
      brewTitleTimeZone: "America/Los_Angeles",
      repairIntervalMs: -1,
    });

    const pollSpy = vi.spyOn(poller as any, "poll");

    poller.start();
    await Promise.resolve();

    const handler = gaggimate.on.mock.calls.find(
      (call: any[]) => call[0] === "evt:status"
    )?.[1] as (event: any) => void;

    // Consecutive brew events — no completion
    handler({ process: { a: 1, s: "brew" } });
    handler({ process: { a: 1, s: "brew" } });

    await vi.advanceTimersByTimeAsync(5000);

    expect(pollSpy).toHaveBeenCalledTimes(1);

    poller.stop();
  });
});
