import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ShotPoller } from "../../src/sync/shotPoller.js";

function createMockShotData() {
  return {
    id: "1",
    version: 4,
    fieldsMask: 0,
    sampleCount: 1,
    sampleInterval: 100,
    profileId: "profile-1",
    profileName: "Device Profile",
    timestamp: 1707900000,
    rating: 0,
    duration: 28000,
    weight: 36,
    samples: [
      {
        t: 0,
        tt: 93,
        ct: 93,
        cp: 9,
        pf: 1.2,
        v: 0,
        systemInfo: {
          bluetoothScaleConnected: true,
          shotStartedVolumetric: false,
        },
      },
    ],
    phases: [],
    incomplete: false,
  };
}

describe("ShotPoller", () => {
  it("re-checks profile existence before creating Draft import", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));

    const gaggimate = {
      fetchShotHistory: vi.fn().mockResolvedValue([{ id: "1" }]),
      fetchShot: vi.fn().mockResolvedValue(createMockShotData()),
      fetchProfiles: vi.fn().mockResolvedValue([{ label: "Device Profile", id: "profile-1" }]),
      uploadBrewChart: vi.fn(),
    };

    const notion = {
      findBrewByShotId: vi.fn().mockResolvedValue(null),
      hasProfileByName: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      normalizeProfileName: vi.fn().mockImplementation((name: string) => name.trim().toLowerCase()),
      createDraftProfile: vi.fn().mockResolvedValue("profile-page"),
      uploadProfileImage: vi.fn().mockResolvedValue(true),
      createBrew: vi.fn().mockResolvedValue("brew-page"),
      updateBrewFromData: vi.fn(),
      brewHasProfileImage: vi.fn().mockResolvedValue(true),
      imageUploadDisabled: null,
      uploadBrewChart: vi.fn().mockResolvedValue(true),
    };

    try {
      const poller = new ShotPoller(gaggimate as any, notion as any, {
        intervalMs: 1000,
        dataDir,
        recentShotLookbackCount: 5,
        brewTitleTimeZone: "America/Los_Angeles",
        repairIntervalMs: -1, // disable periodic repair for this test
        importMissingProfilesFromShots: true,
      });

      await (poller as any).poll();

      expect(notion.hasProfileByName).toHaveBeenCalledTimes(2);
      expect(notion.createDraftProfile).not.toHaveBeenCalled();
      expect(notion.createBrew).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("skips in-progress shots flagged incomplete in the index without fetching the shot file", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));

    const gaggimate = {
      // Index returns a shot that is still recording (SHOT_FLAG_COMPLETED not set)
      fetchShotHistory: vi.fn().mockResolvedValue([{ id: "5", incomplete: true }]),
      fetchShot: vi.fn(),
      fetchProfiles: vi.fn(),
      uploadBrewChart: vi.fn(),
    };

    const notion = {
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

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const poller = new ShotPoller(gaggimate as any, notion as any, {
        intervalMs: 1000,
        dataDir,
        recentShotLookbackCount: 5,
        brewTitleTimeZone: "America/Los_Angeles",
        repairIntervalMs: -1, // disable periodic repair for this test
      });

      await (poller as any).poll();

      // Must not hit the network for the shot file — the index flag is sufficient
      expect(gaggimate.fetchShot).not.toHaveBeenCalled();
      // Must not create or update any Notion entry
      expect(notion.createBrew).not.toHaveBeenCalled();
      expect(notion.updateBrewFromData).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("still recording"));
    } finally {
      logSpy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("skips stale incomplete shots and still syncs newer completed shots", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));

    const gaggimate = {
      fetchShotHistory: vi.fn().mockResolvedValue([
        { id: "6", incomplete: false },
        { id: "5", incomplete: true },
      ]),
      fetchShot: vi.fn().mockResolvedValue({ ...createMockShotData(), id: "6", incomplete: false }),
      fetchProfiles: vi.fn().mockResolvedValue([{ label: "Device Profile", id: "profile-1" }]),
      uploadBrewChart: vi.fn(),
    };

    const notion = {
      findBrewByShotId: vi.fn().mockResolvedValue(null),
      hasProfileByName: vi.fn().mockResolvedValue(true),
      normalizeProfileName: vi.fn().mockImplementation((name: string) => name.trim().toLowerCase()),
      createDraftProfile: vi.fn(),
      uploadProfileImage: vi.fn(),
      createBrew: vi.fn().mockResolvedValue("brew-page-6"),
      updateBrewFromData: vi.fn(),
      brewHasProfileImage: vi.fn().mockResolvedValue(true),
      imageUploadDisabled: null,
      uploadBrewChart: vi.fn().mockResolvedValue(true),
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const poller = new ShotPoller(gaggimate as any, notion as any, {
        intervalMs: 1000,
        dataDir,
        recentShotLookbackCount: 5,
        brewTitleTimeZone: "America/Los_Angeles",
        repairIntervalMs: -1,
      });

      (poller as any).state.lastSyncedShotId = "4";
      await (poller as any).poll();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("stale incomplete index entry"));
      expect(gaggimate.fetchShot).toHaveBeenCalledWith("6");
      expect(notion.createBrew).toHaveBeenCalledTimes(1);
      expect((poller as any).state.lastSyncedShotId).toBe("6");
    } finally {
      warnSpy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("repairs stale brews with empty JSON and missing chart image by re-syncing both", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));

    // Shot 2 was already synced (id <= lastSyncedShotId) but with empty JSON.
    // Shot 3 is a new shot that will be synced normally this poll.
    const staleShot = createMockShotData(); // has samples, so GaggiMate now has real data

    const gaggimate = {
      fetchShotHistory: vi.fn().mockResolvedValue([
        { id: "2", incomplete: false }, // previously synced — stale
        { id: "3", incomplete: false }, // new shot
      ]),
      fetchShot: vi.fn().mockResolvedValue({ ...staleShot, id: "2" }),
      fetchProfiles: vi.fn().mockResolvedValue([{ label: "Device Profile", id: "profile-1" }]),
      uploadBrewChart: vi.fn().mockResolvedValue(true),
    };

    const notion = {
      findBrewByShotId: vi.fn()
        .mockResolvedValueOnce("existing-brew-2") // repair scan: shot 2
        .mockResolvedValueOnce(null),             // main loop: shot 3 is new (shot 2 skipped via fullySyncedShots)
      getBrewShotJson: vi.fn().mockResolvedValue(
        JSON.stringify({ metadata: { sample_count: 0 } }) // stale!
      ),
      hasProfileByName: vi.fn().mockResolvedValue(true),
      normalizeProfileName: vi.fn().mockImplementation((name: string) => name.trim().toLowerCase()),
      createDraftProfile: vi.fn(),
      uploadProfileImage: vi.fn(),
      createBrew: vi.fn().mockResolvedValue("brew-3"),
      updateBrewFromData: vi.fn().mockResolvedValue(undefined),
      brewHasProfileImage: vi.fn().mockResolvedValue(false),
      imageUploadDisabled: null,
      uploadBrewChart: vi.fn().mockResolvedValue(true),
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const poller = new ShotPoller(gaggimate as any, notion as any, {
        intervalMs: 1000,
        dataDir,
        recentShotLookbackCount: 5,
        brewTitleTimeZone: "America/Los_Angeles",
        repairIntervalMs: 1, // runs immediately since repairLastRun starts at 0
      });

      // Seed sync state so shot 2 is considered "already synced" (in lookback, not new)
      (poller as any).state.lastSyncedShotId = "2";

      await (poller as any).poll();

      // Repair: should have updated the stale brew's JSON and re-uploaded the chart
      expect(notion.getBrewShotJson).toHaveBeenCalled();
      expect(notion.updateBrewFromData).toHaveBeenCalledWith(
        "existing-brew-2",
        expect.objectContaining({ activityId: "2" }),
        expect.stringContaining('"sample_count"'),
      );
      expect(notion.uploadBrewChart).toHaveBeenCalledWith("existing-brew-2", "2", expect.any(Object));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("repaired brew"));
    } finally {
      logSpy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("skips polling while connectivity cooldown is active and resumes when device recovers", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));
    const networkError: any = new TypeError("fetch failed");
    networkError.cause = { code: "EHOSTUNREACH" };

    let callCount = 0;
    const gaggimate = {
      fetchShotHistory: vi.fn().mockImplementation(() => {
        callCount++;
        // First call: fails (device offline)
        if (callCount === 1) return Promise.reject(networkError);
        // Subsequent calls: succeed
        return Promise.resolve([]);
      }),
      fetchShot: vi.fn(),
      fetchProfiles: vi.fn(),
      uploadBrewChart: vi.fn(),
    };

    const notion = {
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

    try {
      const poller = new ShotPoller(gaggimate as any, notion as any, {
        intervalMs: 1000,
        dataDir,
        recentShotLookbackCount: 5,
        brewTitleTimeZone: "America/Los_Angeles",
        repairIntervalMs: -1, // disable periodic repair for this test
      });

      // Poll 1: device unreachable — enters cooldown
      await (poller as any).poll();
      expect(gaggimate.fetchShotHistory).toHaveBeenCalledTimes(1);
      expect((poller as any).connectivityCooldownUntil).toBeGreaterThan(Date.now());

      // Poll 2: still in cooldown — fetchShotHistory must NOT be called again
      await (poller as any).poll();
      expect(gaggimate.fetchShotHistory).toHaveBeenCalledTimes(1); // unchanged

      // Simulate cooldown expiry
      (poller as any).connectivityCooldownUntil = 0;

      // Poll 3: cooldown cleared — device now responds, connectivity restored
      await (poller as any).poll();
      expect(gaggimate.fetchShotHistory).toHaveBeenCalledTimes(2);
      expect((poller as any).connectivityCooldownUntil).toBe(0); // cleared on success
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("treats EHOSTUNREACH as connectivity issue and skips noisy fatal errors", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));
    const networkError: any = new TypeError("fetch failed");
    networkError.cause = { code: "EHOSTUNREACH", message: "connect EHOSTUNREACH 192.168.68.51:80" };

    const gaggimate = {
      fetchShotHistory: vi.fn().mockRejectedValue(networkError),
      fetchShot: vi.fn(),
      fetchProfiles: vi.fn(),
      uploadBrewChart: vi.fn(),
    };

    const notion = {
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

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const poller = new ShotPoller(gaggimate as any, notion as any, {
        intervalMs: 1000,
        dataDir,
        recentShotLookbackCount: 5,
        brewTitleTimeZone: "America/Los_Angeles",
        repairIntervalMs: -1, // disable periodic repair for this test
      });

      await (poller as any).poll();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("GaggiMate unreachable"));
      expect(errorSpy).not.toHaveBeenCalledWith("Shot poller error:", expect.anything());
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
