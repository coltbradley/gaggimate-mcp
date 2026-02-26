import { config } from "./config.js";
import { GaggiMateClient } from "./gaggimate/client.js";
import { createServer } from "./http/server.js";
import { ShotPoller } from "./sync/shotPoller.js";
import { ProfileReconciler } from "./sync/profileReconciler.js";
import { NotionClient } from "./notion/client.js";

function validateConfig(): void {
  const errors: string[] = [];

  if (!config.notion.apiKey) {
    errors.push("NOTION_API_KEY is required");
  }
  if (!config.notion.brewsDbId) {
    errors.push("NOTION_BREWS_DB_ID is required");
  }
  if (!config.notion.profilesDbId) {
    errors.push("NOTION_PROFILES_DB_ID is required");
  }
  if (!config.gaggimate.host) {
    errors.push("GAGGIMATE_HOST is required");
  }

  if (errors.length > 0) {
    console.error("Configuration errors:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  if (!config.notion.beansDbId) {
    console.warn("NOTION_BEANS_DB_ID is not set — bean queries will fail");
  }
  if (!config.webhook.secret) {
    console.warn("WEBHOOK_SECRET is not set — webhook signature verification is disabled");
  } else if (/^sha256=[a-f0-9]{64}$/i.test(config.webhook.secret)) {
    console.warn(
      "WEBHOOK_SECRET appears to be a signature digest (sha256=...) instead of Notion's verification token. " +
      "Set WEBHOOK_SECRET to the raw webhook verification token from Notion integration settings.",
    );
  }

  const deprecatedEnvMappings: Array<{ legacyKey: string; replacement: string }> = [
    {
      legacyKey: "POLLING_FALLBACK",
      replacement: "Remove it (profile reconcile is always active when PROFILE_RECONCILE_ENABLED=true).",
    },
    {
      legacyKey: "PROFILE_POLL_INTERVAL_MS",
      replacement: "Use PROFILE_RECONCILE_INTERVAL_MS.",
    },
  ];
  for (const { legacyKey, replacement } of deprecatedEnvMappings) {
    if (process.env[legacyKey] !== undefined) {
      console.warn(`Deprecated env var ${legacyKey} is set and ignored. ${replacement}`);
    }
  }
}

async function main() {
  validateConfig();

  const buildDate = process.env.BUILD_DATE;
  const gitSha = process.env.GIT_SHA;
  const version = buildDate
    ? `${buildDate}${gitSha ? ` (${gitSha.slice(0, 7)})` : ""}`
    : "dev";

  console.log("GaggiMate Notion Bridge starting...");
  console.log(`  Version: ${version}`);
  console.log(`  GaggiMate: ${config.gaggimate.protocol}://${config.gaggimate.host}`);
  console.log(`  HTTP port: ${config.http.port}`);
  console.log(`  Webhook signature verification: ${config.webhook.secret ? "enabled" : "disabled"}`);
  console.log(`  Shot sync interval: ${config.sync.intervalMs}ms`);
  console.log(`  Import missing profiles during shot sync: ${config.sync.importMissingProfilesFromShots}`);
  console.log(`  Profile reconciler: ${config.sync.profileReconcileEnabled}`);
  if (config.sync.profileReconcileEnabled) {
    console.log(`  Profile reconcile interval: ${config.sync.profileReconcileIntervalMs}ms`);
    console.log(`  Profile delete enabled: ${config.sync.profileReconcileDeleteEnabled}`);
    console.log(`  Profile delete limit per reconcile: ${config.sync.profileReconcileDeleteLimitPerRun}`);
    console.log(`  Profile save limit per reconcile: ${config.sync.profileReconcileSaveLimitPerRun}`);
    console.log(`  Sync Selected to device: ${config.sync.profileSyncSelectedToDevice} (set PROFILE_SYNC_SELECTED_TO_DEVICE=true for Notion to control selection)`);
    console.log(`  Sync Favorite to device: ${config.sync.profileSyncFavoriteToDevice}`);
    console.log(`  Import unmatched device profiles: ${config.sync.profileImportUnmatchedDeviceProfiles}`);
  }
  console.log(`  Brew title time zone: ${config.time.brewTitleTimeZone}`);

  // Initialize clients
  const gaggimate = new GaggiMateClient(config.gaggimate);
  const notion = new NotionClient(config.notion);

  // Create shot poller (before server so health endpoint can read cached state)
  const shotPoller = new ShotPoller(gaggimate, notion, {
    intervalMs: config.sync.intervalMs,
    dataDir: config.data.dir,
    recentShotLookbackCount: config.sync.recentShotLookbackCount,
    brewTitleTimeZone: config.time.brewTitleTimeZone,
    repairIntervalMs: config.sync.brewRepairIntervalMs,
    importMissingProfilesFromShots: config.sync.importMissingProfilesFromShots,
  });

  // Start HTTP server
  const app = createServer(gaggimate, notion, {
    getSyncState: () => shotPoller.syncState,
  });
  app.listen(config.http.port, () => {
    console.log(`HTTP server listening on port ${config.http.port}`);
  });

  // Start shot poller
  shotPoller.start();

  // Start profile reconciler — delayed by 10 s so it doesn't open a WebSocket
  // at the exact same moment the shot poller makes its first HTTP request.
  // The ESP32 can struggle when both connections land simultaneously at startup.
  let profileReconciler: ProfileReconciler | null = null;
  if (config.sync.profileReconcileEnabled) {
    profileReconciler = new ProfileReconciler(gaggimate, notion, {
      intervalMs: config.sync.profileReconcileIntervalMs,
      deleteEnabled: config.sync.profileReconcileDeleteEnabled,
      maxDeletesPerRun: config.sync.profileReconcileDeleteLimitPerRun,
      maxSavesPerRun: config.sync.profileReconcileSaveLimitPerRun,
      syncSelectedToDevice: config.sync.profileSyncSelectedToDevice,
      syncFavoriteToDevice: config.sync.profileSyncFavoriteToDevice,
      importUnmatchedDeviceProfiles: config.sync.profileImportUnmatchedDeviceProfiles,
    });
    setTimeout(() => profileReconciler!.start(), 10_000);
  }

  // Handle shutdown
  const shutdown = () => {
    console.log("Shutting down...");
    shotPoller.stop();
    if (profileReconciler) {
      profileReconciler.stop();
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
