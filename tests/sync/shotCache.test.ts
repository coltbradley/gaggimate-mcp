import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ShotCache } from "../../src/sync/shotCache.js";

describe("ShotCache", () => {
  let tmpDir: string;
  let cache: ShotCache;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shotcache-test-"));
    cache = new ShotCache(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads a shot", () => {
    const shot = { id: "042", metadata: { brew_time_s: 28 } };
    cache.write("042", shot);
    const result = cache.read("042");
    expect(result).toEqual(shot);
  });

  it("returns null for missing shot", () => {
    expect(cache.read("999")).toBeNull();
  });

  it("lists shots since a given ID", () => {
    cache.write("040", { id: "040" });
    cache.write("041", { id: "041" });
    cache.write("042", { id: "042" });
    const newer = cache.newSince("040");
    expect(newer.map((s: any) => s.id)).toEqual(["041", "042"]);
  });

  it("returns the latest shot", () => {
    cache.write("040", { id: "040" });
    cache.write("042", { id: "042" });
    cache.write("041", { id: "041" });
    const latest = cache.latest();
    expect(latest?.id).toBe("042");
  });

  it("prunes shots older than retention days", () => {
    cache.write("040", { id: "040" });
    const filePath = path.join(tmpDir, "shots", "040.json");
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
    fs.utimesSync(filePath, tenDaysAgo, tenDaysAgo);
    cache.prune(7);
    expect(cache.read("040")).toBeNull();
  });
});
