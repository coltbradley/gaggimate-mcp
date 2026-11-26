// src/http/middleware/auth.ts
import type { Request, Response, NextFunction } from "express";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "gm_session";

/** Compare two strings in constant time regardless of length. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Cookie value derived from the token, so the token itself never sits in a cookie. */
export function sessionValue(token: string): string {
  return createHmac("sha256", token).update("gaggimate-control-session-v1").digest("hex");
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function isSameOrigin(req: Request): boolean {
  if (req.headers["sec-fetch-site"] === "same-origin") return true;
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const TOKEN_UNSET_MESSAGE =
  "API_TOKEN is not set on the server, so every protected route is closed. Set API_TOKEN and restart.";

/**
 * Every route behind this middleware needs the token, by `Authorization: Bearer`
 * or by the session cookie from /login. With no token configured it refuses all.
 * `getToken` is read per request so tests and reloads see the current value.
 */
export function createAuthMiddleware(token: string | (() => string | undefined)) {
  const getToken = typeof token === "function" ? token : () => token;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === "/health" && req.method === "GET") {
      next();
      return;
    }

    const expected = getToken();
    if (!expected) {
      res.status(401).json({ error: "UNAUTHORIZED", message: TOKEN_UNSET_MESSAGE });
      return;
    }

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      if (safeEqual(authHeader.slice(7), expected)) {
        next();
        return;
      }
    } else {
      const cookie = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (cookie && safeEqual(cookie, sessionValue(expected))) {
        // Cookies ride along on cross-site requests, so writes must prove
        // they come from this origin (defense in depth beside SameSite=Strict).
        if (req.method !== "GET" && req.method !== "HEAD" && !isSameOrigin(req)) {
          res.status(403).json({ error: "FORBIDDEN", message: "Cross-origin request refused" });
          return;
        }
        next();
        return;
      }
    }

    if (req.method === "GET" && req.path === "/control" && String(req.headers.accept ?? "").includes("text/html")) {
      res.redirect(302, "/login");
      return;
    }
    res.status(401).json({ error: "UNAUTHORIZED", message: "Missing or invalid API token" });
  };
}
