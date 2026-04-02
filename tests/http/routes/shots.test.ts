import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { createShotsRouter } from "../../../src/http/routes/shots.js";
import { ShotCache } from "../../../src/sync/shotCache.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("shots routes", () => {
  let app: express.Express;
  let cache: ShotCache;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shots-route-test-"));
    cache = new ShotCache(tmpDir);
    cache.write("040", { id: "040", metadata: { brew_time_s: 25 } });
    cache.write("041", { id: "041", metadata: { brew_time_s: 28 } });
    cache.write("042", { id: "042", metadata: { brew_time_s: 30 } });

    app = express();
    app.use("/shots", createShotsRouter(cache));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /shots/latest returns most recent shot", async () => {
    const res = await request(app).get("/shots/latest");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("042");
  });

  it("GET /shots/new?since=040 returns newer shots", async () => {
    const res = await request(app).get("/shots/new?since=040");
    expect(res.status).toBe(200);
    expect(res.body.shots).toHaveLength(2);
    expect(res.body.shots[0].id).toBe("041");
    expect(res.body.shots[1].id).toBe("042");
  });

  it("GET /shots/new without since returns 400", async () => {
    const res = await request(app).get("/shots/new");
    expect(res.status).toBe(400);
  });

  it("GET /shots/:id returns a specific shot", async () => {
    const res = await request(app).get("/shots/041");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("041");
  });

  it("GET /shots/:id returns 404 for missing", async () => {
    const res = await request(app).get("/shots/999");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("SHOT_NOT_FOUND");
  });
});
