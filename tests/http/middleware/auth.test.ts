// tests/http/middleware/auth.test.ts
import { describe, it, expect, vi } from "vitest";
import { createAuthMiddleware } from "../../../src/http/middleware/auth.js";

describe("auth middleware", () => {
  const middleware = createAuthMiddleware("test-secret-token");

  function mockReqResNext(authHeader?: string) {
    const req = { headers: { authorization: authHeader } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();
    return { req, res, next };
  }

  it("passes with valid Bearer token", () => {
    const { req, res, next } = mockReqResNext("Bearer test-secret-token");
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects missing Authorization header", () => {
    const { req, res, next } = mockReqResNext(undefined);
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "UNAUTHORIZED", message: "Missing or invalid API token" });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects wrong token", () => {
    const { req, res, next } = mockReqResNext("Bearer wrong-token");
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("skips auth on GET /health", () => {
    const noAuthMiddleware = createAuthMiddleware("secret");
    const req = { headers: {}, path: "/health", method: "GET" } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();
    noAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
