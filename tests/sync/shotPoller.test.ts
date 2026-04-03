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
      fetchShotNotes: vi.fn().mockResolvedValue(null),
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
      fetchShotNotes: vi.fn().mockResolvedValue(null),
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
      fetchShotNotes: vi.fn().mockResolvedValue(null),
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

  it("only advances lastSyncedShotId contiguously so failed gaps are retried", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));
    const brewByShot = new Map<string, string>();
    let shot2CreateAttempts = 0;

    const gaggimate = {
      fetchShotHistory: vi.fn().mockResolvedValue([
        { id: "3", incomplete: false },
        { id: "2", incomplete: false },
        { id: "1", incomplete: false },
      ]),
      fetchShot: vi.fn().mockImplementation((shotId: string) => Promise.resolve({
        ...createMockShotData(),
        id: shotId,
        profileId: "profile-1",
        profileName: "Device Profile",
      })),
      fetchShotNotes: vi.fn().mockResolvedValue(null),
      fetchProfiles: vi.fn(),
      uploadBrewChart: vi.fn(),
    };

    const notion = {
      findBrewByShotId: vi.fn().mockImplementation((shotId: string) => Promise.resolve(brewByShot.get(shotId) ?? null)),
      hasProfileByName: vi.fn().mockResolvedValue(true),
      normalizeProfileName: vi.fn().mockImplementation((name: string) => name.trim().toLowerCase()),
      createDraftProfile: vi.fn(),
      uploadProfileImage: vi.fn(),
      createBrew: vi.fn().mockImplementation((brew: any) => {
        const shotId = String(brew.activityId);
        if (shotId === "2") {
          shot2CreateAttempts += 1;
          if (shot2CreateAttempts === 1) {
            return Promise.reject(new Error("transient Notion create failure"));
          }
        }
        const pageId = `brew-${shotId}`;
        brewByShot.set(shotId, pageId);
        return Promise.resolve(pageId);
      }),
      updateBrewFromData: vi.fn().mockResolvedValue(undefined),
      brewHasProfileImage: vi.fn().mockResolvedValue(true),
      imageUploadDisabled: "disabled",
      uploadBrewChart: vi.fn().mockResolvedValue(false),
    };

    try {
      const poller = new ShotPoller(gaggimate as any, notion as any, {
        intervalMs: 1000,
        dataDir,
        recentShotLookbackCount: 5,
        brewTitleTimeZone: "America/Los_Angeles",
        repairIntervalMs: -1,
      });

      await (poller as any).poll();
      expect((poller as any).state.lastSyncedShotId).toBe("1");

      await (poller as any).poll();
      expect((poller as any).state.lastSyncedShotId).toBe("3");
      expect(shot2CreateAttempts).toBe(2);
      expect(notion.updateBrewFromData).toHaveBeenCalledWith(
        "brew-3",
        expect.objectContaining({ activityId: "3" }),
        expect.any(String),
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("persists sync state once per poll cycle when multiple shots advance contiguously", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));

    const gaggimate = {
      fetchShotHistory: vi.fn().mockResolvedValue([
        { id: "3", incomplete: false },
        { id: "2", incomplete: false },
        { id: "1", incomplete: false },
      ]),
      fetchShot: vi.fn().mockImplementation((shotId: string) => Promise.resolve({
        ...createMockShotData(),
        id: shotId,
        profileId: "profile-1",
        profileName: "Device Profile",
      })),
      fetchShotNotes: vi.fn().mockResolvedValue(null),
      fetchProfiles: vi.fn(),
      uploadBrewChart: vi.fn(),
    };

    const notion = {
      findBrewByShotId: vi.fn().mockResolvedValue(null),
      hasProfileByName: vi.fn().mockResolvedValue(true),
      normalizeProfileName: vi.fn().mockImplementation((name: string) => name.trim().toLowerCase()),
      createDraftProfile: vi.fn(),
      uploadProfileImage: vi.fn(),
      createBrew: vi.fn().mockImplementation((brew: any) => Promise.resolve(`brew-${brew.activityId}`)),
      updateBrewFromData: vi.fn().mockResolvedValue(undefined),
      brewHasProfileImage: vi.fn().mockResolvedValue(true),
      imageUploadDisabled: "disabled",
      uploadBrewChart: vi.fn().mockResolvedValue(false),
    };

    try {
      const poller = new ShotPoller(gaggimate as any, notion as any, {
        intervalMs: 1000,
        dataDir,
        recentShotLookbackCount: 5,
        brewTitleTimeZone: "America/Los_Angeles",
        repairIntervalMs: -1,
      });

      const saveSpy = vi.spyOn((poller as any).state, "save");
      await (poller as any).poll();

      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect((poller as any).state.lastSyncedShotId).toBe("3");
      expect((poller as any).state.totalShotsSynced).toBe(3);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("repairs stale brews with empty JSON and missing chart image by re-syncing both", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));
    const callOrder: string[] = [];

    // Shot 2 was already synced (id <= lastSyncedShotId) but with empty JSON.
    // Shot 3 is a new shot that will be synced normally this poll.
    const staleShot = createMockShotData(); // has samples, so GaggiMate now has real data

    const gaggimate = {
      fetchShotHistory: vi.fn().mockResolvedValue([
        { id: "2", incomplete: false }, // previously synced — stale
        { id: "3", incomplete: false }, // new shot
      ]),
      fetchShot: vi.fn().mockImplementation((shotId: string) => {
        if (shotId === "3") return Promise.resolve({ ...staleShot, id: "3" });
        return Promise.resolve({ ...staleShot, id: "2" });
      }),
      fetchShotNotes: vi.fn().mockResolvedValue(null),
      fetchProfiles: vi.fn().mockResolvedValue([{ label: "Device Profile", id: "profile-1" }]),
      uploadBrewChart: vi.fn().mockResolvedValue(true),
    };

    const notion = {
      findBrewByShotId: vi.fn().mockImplementation((shotId: string) => {
        if (shotId === "2") return Promise.resolve("existing-brew-2");
        return Promise.resolve(null);
      }),
      getBrewShotJson: vi.fn().mockImplementation(() => {
        callOrder.push("repair-json-read");
        return Promise.resolve(JSON.stringify({ metadata: { sample_count: 0 } })); // stale!
      }),
      hasProfileByName: vi.fn().mockResolvedValue(true),
      normalizeProfileName: vi.fn().mockImplementation((name: string) => name.trim().toLowerCase()),
      createDraftProfile: vi.fn(),
      uploadProfileImage: vi.fn(),
      createBrew: vi.fn().mockImplementation(() => {
        callOrder.push("create-brew");
        return Promise.resolve("brew-3");
      }),
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
        // Keep lookback empty so shot 2 is handled only by repair, not the main ingest loop.
        recentShotLookbackCount: 0,
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
      expect(callOrder).toEqual(expect.arrayContaining(["create-brew", "repair-json-read"]));
      expect(callOrder.indexOf("create-brew")).toBeLessThan(callOrder.indexOf("repair-json-read"));
    } finally {
      logSpy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("chunks large repair scans to avoid long single-cycle stalls", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));
    const shots = Array.from({ length: 10 }, (_, idx) => ({ id: String(10 - idx), incomplete: false }));

    const gaggimate = {
      fetchShotHistory: vi.fn().mockResolvedValue(shots),
      fetchShot: vi.fn(),
      fetchShotNotes: vi.fn().mockResolvedValue(null),
      fetchProfiles: vi.fn(),
      uploadBrewChart: vi.fn().mockResolvedValue(true),
    };

    const notion = {
      findBrewByShotId: vi.fn().mockResolvedValue(null),
      getBrewShotJson: vi.fn(),
      hasProfileByName: vi.fn().mockResolvedValue(true),
      normalizeProfileName: vi.fn().mockImplementation((name: string) => name.trim().toLowerCase()),
      createDraftProfile: vi.fn(),
      uploadProfileImage: vi.fn(),
      createBrew: vi.fn(),
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
        recentShotLookbackCount: 0,
        brewTitleTimeZone: "America/Los_Angeles",
        repairIntervalMs: 1,
      });

      (poller as any).state.lastSyncedShotId = "10";
      await (poller as any).poll();

      expect(notion.findBrewByShotId).toHaveBeenCalledTimes(3);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Repair scan: processed 3/10 shot(s)"));
    } finally {
      logSpy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rotates repair batches so missing brew pages do not starve later candidates", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));
    const shots = Array.from({ length: 6 }, (_, idx) => ({ id: String(6 - idx), incomplete: false }));

    const gaggimate = {
      fetchShotHistory: vi.fn().mockResolvedValue(shots),
      fetchShot: vi.fn(),
      fetchShotNotes: vi.fn().mockResolvedValue(null),
      fetchProfiles: vi.fn(),
      uploadBrewChart: vi.fn().mockResolvedValue(true),
    };

    const notion = {
      findBrewByShotId: vi.fn().mockResolvedValue(null),
      getBrewShotJson: vi.fn(),
      hasProfileByName: vi.fn().mockResolvedValue(true),
      normalizeProfileName: vi.fn().mockImplementation((name: string) => name.trim().toLowerCase()),
      createDraftProfile: vi.fn(),
      uploadProfileImage: vi.fn(),
      createBrew: vi.fn(),
      updateBrewFromData: vi.fn().mockResolvedValue(undefined),
      brewHasProfileImage: vi.fn().mockResolvedValue(false),
      imageUploadDisabled: null,
      uploadBrewChart: vi.fn().mockResolvedValue(true),
    };

    try {
      const poller = new ShotPoller(gaggimate as any, notion as any, {
        intervalMs: 1000,
        dataDir,
        recentShotLookbackCount: 0,
        brewTitleTimeZone: "America/Los_Angeles",
        repairIntervalMs: 1,
      });

      (poller as any).state.lastSyncedShotId = "6";

      await (poller as any).poll();
      expect(notion.findBrewByShotId.mock.calls.slice(0, 3).map((args: any[]) => args[0])).toEqual(["1", "2", "3"]);

      // Force immediate follow-up repair pass in test (instead of waiting continuation delay).
      (poller as any).repairLastRun = 0;
      await (poller as any).poll();
      expect(notion.findBrewByShotId.mock.calls.slice(3, 6).map((args: any[]) => args[0])).toEqual(["4", "5", "6"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("skips polling while connectivity cooldown is active and resumes when device recovers", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));
    const networkError: any = new TypeError("fetch failed");
    networkError.cause = { code: "EHOSTUNREACH" };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

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
      fetchShotNotes: vi.fn().mockResolvedValue(null),
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
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Shot poller: connectivity cooldown active"));

      // Simulate cooldown expiry
      (poller as any).connectivityCooldownUntil = 0;

      // Poll 3: cooldown cleared — device now responds, connectivity restored
      await (poller as any).poll();
      expect(gaggimate.fetchShotHistory).toHaveBeenCalledTimes(2);
      expect((poller as any).connectivityCooldownUntil).toBe(0); // cleared on success
    } finally {
      logSpy.mockRestore();
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
      fetchShotNotes: vi.fn().mockResolvedValue(null),
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

  it("pauses repair scan quickly on connectivity errors and applies cooldown", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));
    const networkError: any = new TypeError("fetch failed");
    networkError.cause = { code: "EHOSTUNREACH", message: "connect EHOSTUNREACH 192.168.68.51:80" };

    const gaggimate = {
      fetchShotHistory: vi.fn().mockResolvedValue([
        { id: "3", incomplete: false },
        { id: "2", incomplete: false },
        { id: "1", incomplete: false },
      ]),
      fetchShot: vi.fn().mockRejectedValue(networkError),
      fetchShotNotes: vi.fn().mockResolvedValue(null),
      fetchProfiles: vi.fn(),
      uploadBrewChart: vi.fn(),
    };

    const notion = {
      findBrewByShotId: vi.fn().mockResolvedValue("brew-page"),
      getBrewShotJson: vi.fn().mockResolvedValue(JSON.stringify({ metadata: { sample_count: 0 } })),
      hasProfileByName: vi.fn(),
      normalizeProfileName: vi.fn(),
      createDraftProfile: vi.fn(),
      uploadProfileImage: vi.fn(),
      createBrew: vi.fn(),
      updateBrewFromData: vi.fn(),
      brewHasProfileImage: vi.fn().mockResolvedValue(true),
      imageUploadDisabled: null,
      uploadBrewChart: vi.fn(),
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const poller = new ShotPoller(gaggimate as any, notion as any, {
        intervalMs: 1000,
        dataDir,
        recentShotLookbackCount: 0,
        brewTitleTimeZone: "America/Los_Angeles",
        repairIntervalMs: 1,
      });

      (poller as any).state.lastSyncedShotId = "3";

      await (poller as any).poll();
      expect(gaggimate.fetchShot).toHaveBeenCalledTimes(1);
      expect((poller as any).connectivityCooldownUntil).toBeGreaterThan(Date.now());
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Shot poller: GaggiMate unreachable"));

      await (poller as any).poll();
      expect(gaggimate.fetchShotHistory).toHaveBeenCalledTimes(1);
      expect(gaggimate.fetchShot).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("falls back to index entry data and creates a brew when .slog fetch throws", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));
    const fetchError = new Error("Request timeout: No response from GaggiMate");

    const gaggimate = {
      fetchShotHistory: vi.fn().mockResolvedValue([
        // Provide all ShotListItem fields that indexEntryToBrewData reads
        {
          id: "10",
          incomplete: false,
          timestamp: 1712000000, // Unix seconds
          duration: 28000, // ms
          volume: 36.0, // already scaled grams
          profile: "My Profile",
          profileId: "prof-1",
          samples: 0,
          rating: null,
          notes: null,
          loaded: false,
          data: null,
        },
      ]),
      // fetchShot throws (simulates firmware .slog hang / timeout)
      fetchShot: vi.fn().mockRejectedValue(fetchError),
      fetchShotNotes: vi.fn().mockResolvedValue(null),
      fetchProfiles: vi.fn(),
      uploadBrewChart: vi.fn(),
    };

    const notion = {
      findBrewByShotId: vi.fn().mockResolvedValue(null),
      hasProfileByName: vi.fn().mockResolvedValue(true),
      normalizeProfileName: vi.fn().mockImplementation((name: string) => name.trim().toLowerCase()),
      createDraftProfile: vi.fn(),
      uploadProfileImage: vi.fn(),
      createBrew: vi.fn().mockResolvedValue("brew-fallback-10"),
      updateBrewFromData: vi.fn(),
      brewHasProfileImage: vi.fn().mockResolvedValue(true),
      imageUploadDisabled: null,
      uploadBrewChart: vi.fn().mockResolvedValue(true),
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const poller = new ShotPoller(gaggimate as any, notion as any, {
        intervalMs: 1000,
        dataDir,
        recentShotLookbackCount: 5,
        brewTitleTimeZone: "America/Los_Angeles",
        repairIntervalMs: -1,
      });

      // Seed state so shot 10 is contiguous (cursor advances 9 → 10)
      (poller as any).state.lastSyncedShotId = "9";

      await (poller as any).poll();

      // Fallback path: brew created without shot JSON
      expect(notion.createBrew).toHaveBeenCalledTimes(1);
      const brewArg = (notion.createBrew as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(brewArg.activityId).toBe("10");
      expect(brewArg.profileName).toBe("My Profile");
      expect(brewArg.brewTime).toBe(28); // 28000ms → 28s
      expect(brewArg.yieldOut).toBe(36.0);
      expect(brewArg.source).toBe("Auto");
      // No shot JSON passed in fallback
      expect((notion.createBrew as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(".slog binary fetch failed"),
        expect.anything(),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("created fallback brew entry from index data"));

      // State should advance since the shot was handled
      expect((poller as any).state.lastSyncedShotId).toBe("10");
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("skips fallback create when brew already exists in Notion after .slog fetch failure", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));
    const fetchError = new Error("Request timeout: No response from GaggiMate");

    const gaggimate = {
      fetchShotHistory: vi.fn().mockResolvedValue([
        {
          id: "11",
          incomplete: false,
          timestamp: 1712001000,
          duration: 30000,
          volume: 40.0,
          profile: "Light Roast",
          profileId: "prof-2",
          samples: 0,
          rating: null,
          notes: null,
          loaded: false,
          data: null,
        },
      ]),
      fetchShot: vi.fn().mockRejectedValue(fetchError),
      fetchShotNotes: vi.fn().mockResolvedValue(null),
      fetchProfiles: vi.fn(),
      uploadBrewChart: vi.fn(),
    };

    const notion = {
      // findBrewByShotId returns existing page — no create should happen
      findBrewByShotId: vi.fn().mockResolvedValue("existing-brew-11"),
      hasProfileByName: vi.fn().mockResolvedValue(true),
      normalizeProfileName: vi.fn().mockImplementation((name: string) => name.trim().toLowerCase()),
      createDraftProfile: vi.fn(),
      uploadProfileImage: vi.fn(),
      createBrew: vi.fn().mockResolvedValue("brew-11"),
      updateBrewFromData: vi.fn(),
      brewHasProfileImage: vi.fn().mockResolvedValue(true),
      imageUploadDisabled: null,
      uploadBrewChart: vi.fn().mockResolvedValue(true),
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const poller = new ShotPoller(gaggimate as any, notion as any, {
        intervalMs: 1000,
        dataDir,
        recentShotLookbackCount: 5,
        brewTitleTimeZone: "America/Los_Angeles",
        repairIntervalMs: -1,
      });

      await (poller as any).poll();

      // Brew already exists — must NOT call createBrew again
      expect(notion.createBrew).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("fallback brew already exists in Notion"),
      );
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("calls fetchShotNotes with the numeric shot ID during per-shot sync", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));

    const gaggimate = {
      fetchShotHistory: vi.fn().mockResolvedValue([{ id: "7", incomplete: false }]),
      fetchShot: vi.fn().mockResolvedValue({ ...createMockShotData(), id: "7" }),
      fetchShotNotes: vi.fn().mockResolvedValue({
        id: 7,
        doseIn: 18.5,
        doseOut: 36.0,
        ratio: "1:1.9",
        grindSetting: "12",
        beanType: "Ethiopia Yirgacheffe",
        balanceTaste: "balanced",
      }),
      fetchProfiles: vi.fn(),
      uploadBrewChart: vi.fn().mockResolvedValue(true),
    };

    const notion = {
      findBrewByShotId: vi.fn().mockResolvedValue(null),
      hasProfileByName: vi.fn().mockResolvedValue(true),
      normalizeProfileName: vi.fn().mockImplementation((name: string) => name.trim().toLowerCase()),
      createDraftProfile: vi.fn(),
      uploadProfileImage: vi.fn(),
      createBrew: vi.fn().mockResolvedValue("brew-page-7"),
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
        repairIntervalMs: -1,
      });

      await (poller as any).poll();

      // fetchShotNotes must be called with the numeric shot ID
      expect(gaggimate.fetchShotNotes).toHaveBeenCalledWith(7);

      // The brew should have been created with shot notes fields populated
      expect(notion.createBrew).toHaveBeenCalledWith(
        expect.objectContaining({
          activityId: "7",
          doseIn: 18.5,
          grindSetting: 12,
          tasteBal: "balanced",
        }),
        expect.any(String),
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("gracefully handles null shot notes and still syncs the brew with analysis fields", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "shot-poller-test-"));

    const gaggimate = {
      fetchShotHistory: vi.fn().mockResolvedValue([{ id: "8", incomplete: false }]),
      fetchShot: vi.fn().mockResolvedValue({ ...createMockShotData(), id: "8" }),
      fetchShotNotes: vi.fn().mockResolvedValue(null),
      fetchProfiles: vi.fn(),
      uploadBrewChart: vi.fn().mockResolvedValue(true),
    };

    const notion = {
      findBrewByShotId: vi.fn().mockResolvedValue(null),
      hasProfileByName: vi.fn().mockResolvedValue(true),
      normalizeProfileName: vi.fn().mockImplementation((name: string) => name.trim().toLowerCase()),
      createDraftProfile: vi.fn(),
      uploadProfileImage: vi.fn(),
      createBrew: vi.fn().mockResolvedValue("brew-page-8"),
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
        repairIntervalMs: -1,
      });

      await (poller as any).poll();

      expect(gaggimate.fetchShotNotes).toHaveBeenCalledWith(8);
      // Brew should be created without shot notes fields but with analysis fields present
      // (analysis is always run — phaseSummary may be empty string for a single-sample shot)
      expect(notion.createBrew).toHaveBeenCalledWith(
        expect.objectContaining({ activityId: "8" }),
        expect.any(String),
      );
      const brewArg = (notion.createBrew as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // No shot notes fields when notes are null
      expect(brewArg.doseIn).toBeUndefined();
      expect(brewArg.grindSetting).toBeUndefined();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
