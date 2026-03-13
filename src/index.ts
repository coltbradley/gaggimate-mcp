import { config } from "./config.js";
import { GaggiMateClient } from "./gaggimate/client.js";
import { ShotCache } from "./sync/shotCache.js";
import { ShotPoller } from "./sync/shotPoller.js";
import { createServer } from "./http/server.js";

function validateConfig(): void {
  const errors: string[] = [];

  if (!config.gaggimate.host) {
    errors.push("GAGGIMATE_HOST is required");
  }
  if (!config.api.token) {
    errors.push("API_TOKEN is required");
  }

  if (errors.length > 0) {
    console.error("Configuration errors:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
}

async function main() {
  validateConfig();

  const buildDate = process.env.BUILD_DATE;
  const gitSha = process.env.GIT_SHA;
  const version = buildDate
    ? `${buildDate}${gitSha ? ` (${gitSha.slice(0, 7)})` : ""}`
    : "dev";

  console.log("GaggiMate Bridge starting...");
  console.log(`  Version: ${version}`);
  console.log(`  GaggiMate: ${config.gaggimate.protocol}://${config.gaggimate.host}`);
  console.log(`  HTTP port: ${config.http.port}`);
  console.log(`  Shot sync interval: ${config.sync.intervalMs}ms`);
  console.log(`  Shot retention: ${config.data.shotRetentionDays} days`);

  // Initialize clients
  const gaggimate = new GaggiMateClient(config.gaggimate);
  const shotCache = new ShotCache(config.data.dir);

  // Create shot poller
  const shotPoller = new ShotPoller(gaggimate, shotCache, {
    intervalMs: config.sync.intervalMs,
    dataDir: config.data.dir,
    connectivityCooldownMs: config.connectivity.cooldownMs,
  });

  // Start HTTP server
  const app = createServer(gaggimate, shotCache, {
    apiToken: config.api.token,
    getSyncState: () => shotPoller.syncState,
  });
  app.listen(config.http.port, () => {
    console.log(`HTTP server listening on port ${config.http.port}`);
  });

  // Start shot poller
  shotPoller.start();

  // Prune old shots on startup
  shotCache.prune(config.data.shotRetentionDays);

  // Handle shutdown
  const shutdown = () => {
    console.log("Shutting down...");
    shotPoller.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
