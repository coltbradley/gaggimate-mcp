import { describe, it, expect, vi } from "vitest";

describe("config", () => {
  it("exports a config object with expected shape", async () => {
    const { config } = await import("../src/config.js");

    expect(config).toHaveProperty("gaggimate");
    expect(config).toHaveProperty("api");
    expect(config).toHaveProperty("sync");
    expect(config).toHaveProperty("http");
    expect(config).toHaveProperty("data");
    expect(config).toHaveProperty("connectivity");

    // Check defaults
    expect(config.gaggimate.protocol).toBe("ws");
    expect(config.gaggimate.requestTimeout).toBe(5000);
    expect(config.http.port).toBe(3000);
    expect(config.sync.intervalMs).toBe(30000);
    expect(config.data.shotRetentionDays).toBe(7);
    expect(config.connectivity.cooldownMs).toBe(180000);
  });

  it("parses numeric env vars with fallback defaults", async () => {
    const previous = { ...process.env };
    try {
      process.env.SYNC_INTERVAL_MS = "45000";
      process.env.REQUEST_TIMEOUT = "7000";
      process.env.SHOT_RETENTION_DAYS = "14";
      process.env.CONNECTIVITY_COOLDOWN_MS = "300000";
      process.env.GAGGIMATE_PROTOCOL = "invalid";

      vi.resetModules();
      const { config } = await import("../src/config.js");

      expect(config.sync.intervalMs).toBe(45000);
      expect(config.gaggimate.requestTimeout).toBe(7000);
      expect(config.data.shotRetentionDays).toBe(14);
      expect(config.connectivity.cooldownMs).toBe(300000);
      expect(config.gaggimate.protocol).toBe("ws"); // invalid falls back to ws
    } finally {
      process.env = previous;
      vi.resetModules();
    }
  });
});
