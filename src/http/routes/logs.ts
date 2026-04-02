import { Router } from "express";
import { getRecentLogs } from "../../utils/logBuffer.js";

export function createLogsRouter(): Router {
  const router = Router();
  router.get("/", (req, res) => {
    const count = Math.min(parseInt(req.query.count as string) || 100, 500);
    const logs = getRecentLogs(count);
    res.type("text/plain").send(logs.join("\n"));
  });
  return router;
}
