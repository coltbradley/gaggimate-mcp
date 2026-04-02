import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShotPoller } from "../../src/sync/shotPoller.js";

function makeGaggimate() {
  return {
    fetchShotHistory: vi.fn().mockResolvedValue([]),
    fetchShot: vi.fn(),
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

    // Clean up the interval
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

    // Capture the handler registered in start()
    const registeredHandler = gaggimate.on.mock.calls.find(
      (call: any[]) => call[0] === "evt:status"
    )?.[1];
    expect(registeredHandler).toBeDefined();

    poller.stop();

    expect(gaggimate.off).toHaveBeenCalledWith("evt:status", registeredHandler);
  });

  it("triggers poll after 2s delay when brew state transitions from 'brewing' to another state", async () => {
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
    // Let the immediate poll triggered in start() settle (it's async)
    await Promise.resolve();

    const handler = gaggimate.on.mock.calls.find(
      (call: any[]) => call[0] === "evt:status"
    )?.[1] as (event: any) => void;

    // Simulate: device transitions into brewing
    handler({ process: { state: "brewing" } });
    // No poll yet — still brewing
    expect(pollSpy).toHaveBeenCalledTimes(1); // only the start() immediate poll

    // Simulate: device transitions out of brewing
    handler({ process: { state: "idle" } });

    // Poll should not fire immediately — it's scheduled after 2s
    expect(pollSpy).toHaveBeenCalledTimes(1);

    // Advance 2 seconds
    await vi.advanceTimersByTimeAsync(2000);

    expect(pollSpy).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it("does NOT trigger poll for state transitions that do not involve leaving 'brewing'", async () => {
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

    // idle → heating (not brewing at all)
    handler({ process: { state: "idle" } });
    handler({ process: { state: "heating" } });
    handler({ process: { state: "ready" } });

    await vi.advanceTimersByTimeAsync(5000);

    // Only the initial poll from start() should have fired
    expect(pollSpy).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it("does NOT trigger poll when 'brewing' stays 'brewing'", async () => {
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

    // Two consecutive brewing events — no transition out
    handler({ process: { state: "brewing" } });
    handler({ process: { state: "brewing" } });

    await vi.advanceTimersByTimeAsync(5000);

    expect(pollSpy).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it("supports the flat 's' field as fallback for brew state", async () => {
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

    // Use flat 's' field (no 'process' wrapper)
    handler({ s: "brewing" });
    handler({ s: "idle" });

    await vi.advanceTimersByTimeAsync(2000);

    expect(pollSpy).toHaveBeenCalledTimes(2);

    poller.stop();
  });
});
