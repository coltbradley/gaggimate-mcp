import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createDeviceRouter } from "../../../src/http/routes/device.js";

function mockGaggiMate() {
  return {
    fetchProfiles: vi.fn().mockResolvedValue([
      { id: "prof-1", label: "Flat 9", favorite: true, selected: true },
    ]),
    saveProfile: vi.fn().mockResolvedValue({ id: "prof-new", label: "Test" }),
    selectProfile: vi.fn().mockResolvedValue(undefined),
    favoriteProfile: vi.fn().mockResolvedValue(undefined),
    deleteProfile: vi.fn().mockResolvedValue(undefined),
  };
}

describe("device routes", () => {
  it("GET /profiles lists device profiles", async () => {
    const gaggimate = mockGaggiMate();
    const app = express();
    app.use(express.json());
    app.use("/device", createDeviceRouter(gaggimate as any));

    const res = await request(app).get("/device/profiles");
    expect(res.status).toBe(200);
    expect(res.body.profiles).toHaveLength(1);
    expect(res.body.source).toBe("device");
  });

  it("POST /profiles/push pushes and optionally selects", async () => {
    const gaggimate = mockGaggiMate();
    const app = express();
    app.use(express.json());
    app.use("/device", createDeviceRouter(gaggimate as any));

    const profile = { id: "prof-new", label: "Test", phases: [{ phase: "brew" }] };
    const res = await request(app)
      .post("/device/profiles/push")
      .send({ profile, select: true });

    expect(res.status).toBe(200);
    expect(res.body.pushed).toBe(true);
    expect(res.body.selected).toBe(true);
    expect(gaggimate.saveProfile).toHaveBeenCalledWith(profile);
    expect(gaggimate.selectProfile).toHaveBeenCalled();
  });

  it("POST /profiles/push returns 207 on select failure", async () => {
    const gaggimate = mockGaggiMate();
    gaggimate.selectProfile.mockRejectedValue(new Error("Select timeout"));
    const app = express();
    app.use(express.json());
    app.use("/device", createDeviceRouter(gaggimate as any));

    const profile = { id: "prof-new", label: "Test", phases: [{ phase: "brew" }] };
    const res = await request(app)
      .post("/device/profiles/push")
      .send({ profile, select: true });

    expect(res.status).toBe(207);
    expect(res.body.pushed).toBe(true);
    expect(res.body.selected).toBe(false);
    expect(res.body.error).toBe("SELECT_FAILED");
  });

  it("DELETE /profiles/:id deletes from device", async () => {
    const gaggimate = mockGaggiMate();
    const app = express();
    app.use(express.json());
    app.use("/device", createDeviceRouter(gaggimate as any));

    const res = await request(app).delete("/device/profiles/prof-1");
    expect(res.status).toBe(200);
    expect(gaggimate.deleteProfile).toHaveBeenCalledWith("prof-1");
  });
});
