import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { config } from "../../src/config.js";
import { createServer } from "../../src/http/server.js";
import { buildNotionWebhookSignature } from "../../src/http/routes/webhook.js";
import { assertSafeBind, isLoopbackHost } from "../../src/http/bind.js";

const TOKEN = "unit-test-token-123";

function build(shotCache?: any) {
  const gaggimate: any = {
    host: "192.168.9.9",
    isReachable: vi.fn().mockResolvedValue(true),
  };
  const notion: any = { isConnected: vi.fn().mockResolvedValue(true), imageUploadDisabled: null };
  return createServer(gaggimate, notion, { getSyncState: () => null, shotCache });
}

const protectedRoutes: Array<[string, string]> = [
  ["get", "/mcp"],
  ["post", "/mcp"],
  ["delete", "/mcp"],
  ["get", "/control"],
  ["get", "/api/device/profiles"],
  ["post", "/api/device/profiles/x/select"],
  ["get", "/logs"],
  ["get", "/status"],
  ["get", "/shots/latest"],
];

describe("server security", () => {
  const original = { token: config.api.token, secret: config.webhook.secret };
  beforeEach(() => {
    (config as any).api.token = TOKEN;
    (config as any).webhook.secret = "";
  });
  afterEach(() => {
    (config as any).api.token = original.token;
    (config as any).webhook.secret = original.secret;
  });

  it.each(protectedRoutes)("%s %s answers 401 without a token", async (method, path) => {
    const res = await (request(build({ getLatest: vi.fn() }) as any) as any)[method](path);
    expect(res.status).toBe(401);
  });

  it.each(protectedRoutes)("%s %s answers 401 with a clear message when API_TOKEN is unset", async (method, path) => {
    (config as any).api.token = "";
    const res = await (request(build({ getLatest: vi.fn() }) as any) as any)[method](path);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toContain("API_TOKEN");
  });

  it("rejects a wrong bearer token and accepts the right one", async () => {
    const app = build();
    expect((await request(app).get("/logs").set("Authorization", "Bearer nope")).status).toBe(401);
    expect((await request(app).get("/logs").set("Authorization", `Bearer ${TOKEN}`)).status).toBe(200);
  });

  it("does not authenticate with the token when API_TOKEN is unset, even if the client sends an empty bearer", async () => {
    (config as any).api.token = "";
    const res = await request(build()).get("/logs").set("Authorization", "Bearer ");
    expect(res.status).toBe(401);
  });

  it("serves /health without a token and exposes booleans only", async () => {
    (config as any).webhook.secret = "whsec";
    const res = await request(build()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.auth).toEqual({ tokenSet: true });
    expect(res.body.webhook).toEqual({ secretSet: true });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("whsec");
    expect(text).not.toContain("192.168.9.9");
    expect(res.body).not.toHaveProperty("lastShotId");
  });

  it("serves /health when API_TOKEN is unset and says so", async () => {
    (config as any).api.token = "";
    const res = await request(build()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.auth).toEqual({ tokenSet: false });
    expect(res.body.webhook).toEqual({ secretSet: false });
  });

  describe("control panel login", () => {
    it("redirects a browser to /login when unauthenticated", async () => {
      const res = await request(build()).get("/control").set("Accept", "text/html");
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/login");
    });

    it("serves the login form without a token", async () => {
      const res = await request(build()).get("/login");
      expect(res.status).toBe(200);
      expect(res.text).toContain("<form");
    });

    it("refuses login when API_TOKEN is unset", async () => {
      (config as any).api.token = "";
      const res = await request(build()).post("/login").type("form").send({ token: "" });
      expect(res.status).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("rejects a wrong token without setting a cookie", async () => {
      const res = await request(build()).post("/login").type("form").send({ token: "wrong" });
      expect(res.status).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("sets an HttpOnly SameSite=Strict cookie that never contains the token, and the cookie opens /control", async () => {
      const app = build();
      const login = await request(app).post("/login").type("form").send({ token: TOKEN });
      expect(login.status).toBe(302);
      expect(login.headers.location).toBe("/control");
      const cookie = (login.headers["set-cookie"] as unknown as string[])[0];
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).not.toContain(TOKEN);
      const control = await request(app).get("/control").set("Cookie", cookie.split(";")[0]);
      expect(control.status).toBe(200);
      const api = await request(app).get("/logs").set("Cookie", cookie.split(";")[0]);
      expect(api.status).toBe(200);
    });

    it("marks the cookie Secure behind an https proxy", async () => {
      const login = await request(build()).post("/login").type("form")
        .set("X-Forwarded-Proto", "https").send({ token: TOKEN });
      expect((login.headers["set-cookie"] as unknown as string[])[0]).toMatch(/Secure/i);
    });

    it("rejects a forged cookie", async () => {
      const res = await request(build()).get("/logs").set("Cookie", "gm_session=deadbeef");
      expect(res.status).toBe(401);
    });
  });

  describe("webhook", () => {
    const body = { type: "page.properties_updated", entity: { type: "page", id: "p" }, data: { parent: { database_id: "other" } } };

    it("is off (404) when WEBHOOK_SECRET is unset, even with a bearer token", async () => {
      const res = await request(build()).post("/webhook/notion").send(body);
      expect(res.status).toBe(404);
    });

    it("needs no bearer token but requires a valid signature when the secret is set", async () => {
      (config as any).webhook.secret = "whsec";
      const app = build();
      const unsigned = await request(app).post("/webhook/notion").send(body);
      expect(unsigned.status).toBe(401);
      const raw = JSON.stringify(body);
      const signed = await request(app).post("/webhook/notion")
        .set("Content-Type", "application/json")
        .set("X-Notion-Signature", buildNotionWebhookSignature(raw, "whsec"))
        .send(raw);
      expect(signed.status).toBe(200);
    });

    it("rejects malformed and non-ASCII signature headers with 401", async () => {
      (config as any).webhook.secret = "whsec";
      const app = build();
      const raw = JSON.stringify(body);
      for (const header of ["sha256=zz", "sha256=" + "é".repeat(64), "abc", "sha256=" + "a".repeat(63)]) {
        const res = await request(app).post("/webhook/notion")
          .set("Content-Type", "application/json")
          .set("X-Notion-Signature", Buffer.from(header, "utf8").toString("latin1"))
          .send(raw);
        expect(res.status).toBe(401);
      }
    });
  });
});

describe("bind safety", () => {
  it("recognises loopback hosts", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "::1", "localhost", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ["0.0.0.0", "::", "192.168.1.5", "100.64.0.1", "example.com", ""]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it("refuses a non-loopback bind without a token", () => {
    expect(() => assertSafeBind("0.0.0.0", "")).toThrow(/API_TOKEN/);
    expect(() => assertSafeBind("0.0.0.0", "t")).not.toThrow();
    expect(() => assertSafeBind("127.0.0.1", "")).not.toThrow();
  });
});
