import express, { Router } from "express";
import { config } from "../../config.js";
import { SESSION_COOKIE, TOKEN_UNSET_MESSAGE, safeEqual, sessionValue } from "../middleware/auth.js";

const page = (note = "") => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>GaggiMate login</title>
<style>body{font-family:system-ui,sans-serif;background:#1a1a1a;color:#e0e0e0;max-width:360px;margin:3rem auto;padding:0 1rem}
input,button{width:100%;padding:.6rem;margin-top:.5rem;font-size:1rem;box-sizing:border-box}.note{color:#ff7f7f}</style></head>
<body><h1>GaggiMate control</h1>${note ? `<p class="note">${note}</p>` : ""}
<form method="post" action="/login"><label>API token<input type="password" name="token" autocomplete="current-password" autofocus required></label>
<button type="submit">Sign in</button></form></body></html>`;

/** One-time login: trades the API token for an HttpOnly session cookie. */
export function createLoginRouter(): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    if (!config.api.token) {
      res.status(401).type("html").send(page(TOKEN_UNSET_MESSAGE));
      return;
    }
    res.type("html").send(page());
  });

  router.post("/", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    const expected = config.api.token;
    if (!expected) {
      res.status(401).type("html").send(page(TOKEN_UNSET_MESSAGE));
      return;
    }
    const provided = typeof req.body?.token === "string" ? req.body.token : "";
    if (!safeEqual(provided, expected)) {
      res.status(401).type("html").send(page("Wrong token."));
      return;
    }
    const secure = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
    res.cookie(SESSION_COOKIE, sessionValue(expected), {
      httpOnly: true,
      sameSite: "strict",
      secure,
      path: "/",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.redirect(302, "/control");
  });

  return router;
}
