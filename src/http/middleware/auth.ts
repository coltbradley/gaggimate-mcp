// src/http/middleware/auth.ts
import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

export function createAuthMiddleware(token: string) {
  const tokenBuf = Buffer.from(token);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === "/health" && req.method === "GET") {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Missing or invalid API token" });
      return;
    }

    const provided = Buffer.from(authHeader.slice(7));
    if (provided.length !== tokenBuf.length || !timingSafeEqual(provided, tokenBuf)) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Missing or invalid API token" });
      return;
    }

    next();
  };
}
