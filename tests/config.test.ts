import { describe, it, expect, vi } from "vitest";

describe("config", () => {
  it("exports a config object with expected shape", async () => {
    // Dynamically import to avoid side effects from dotenv in other tests
    const { config } = await import("../src/config.js");

    expect(config).toHaveProperty("gaggimate");
    expect(config).toHaveProperty("notion");
    expect(config).toHaveProperty("webhook");
    expect(config).toHaveProperty("sync");
    expect(config).toHaveProperty("http");
    expect(config).toHaveProperty("data");

    // Check defaults
    expect(config.gaggimate.protocol).toBe("ws");
    expect(config.gaggimate.requestTimeout).toBe(5000);
    expect(config.http.port).toBe(3000);
    expect(config.sync.intervalMs).toBe(30000);
    expect(config.sync.profileReconcileEnabled).toBe(true);
    expect(config.sync.profileReconcileIntervalMs).toBe(60000);
    expect(config.sync.profileReconcileDeleteEnabled).toBe(true);
    expect(config.sync.profileReconcileDeleteLimitPerRun).toBe(3);
    expect(config.sync.profileReconcileSaveLimitPerRun).toBe(5);
    expect(config.sync.profileSyncSelectedToDevice).toBe(false);
    expect(config.sync.profileSyncFavoriteToDevice).toBe(false);
    expect(config.sync.importMissingProfilesFromShots).toBe(false);
  });

  it("parses boolean env flags case-insensitively and accepts zero delete limit", async () => {
    const previous = { ...process.env };
    try {
      process.env.PROFILE_RECONCILE_ENABLED = "FALSE";
      process.env.PROFILE_RECONCILE_DELETE_ENABLED = "0";
      process.env.PROFILE_RECONCILE_DELETE_LIMIT_PER_RUN = "0";
      process.env.SYNC_INTERVAL_MS = "45000";
      process.env.REQUEST_TIMEOUT = "7000";
      process.env.GAGGIMATE_PROTOCOL = "invalid";
      process.env.PROFILE_RECONCILE_SAVE_LIMIT_PER_RUN = "2";

      vi.resetModules();
      const { config } = await import("../src/config.js");

      expect(config.sync.profileReconcileEnabled).toBe(false);
      expect(config.sync.profileReconcileDeleteEnabled).toBe(false);
      expect(config.sync.profileReconcileDeleteLimitPerRun).toBe(0);
      expect(config.sync.profileReconcileSaveLimitPerRun).toBe(2);
      expect(config.sync.intervalMs).toBe(45000);
      expect(config.gaggimate.requestTimeout).toBe(7000);
      expect(config.gaggimate.protocol).toBe("ws");
    } finally {
      process.env = previous;
      vi.resetModules();
    }
  });
});
