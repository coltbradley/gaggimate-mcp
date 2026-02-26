import "dotenv/config";

function parseEnvNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseEnvBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return defaultValue;
}

function parseGaggimateProtocol(value: string | undefined): "ws" | "wss" {
  const normalized = value?.trim().toLowerCase();
  return normalized === "wss" ? "wss" : "ws";
}

export const config = {
  gaggimate: {
    host: process.env.GAGGIMATE_HOST || "localhost",
    protocol: parseGaggimateProtocol(process.env.GAGGIMATE_PROTOCOL),
    requestTimeout: parseEnvNumber(process.env.REQUEST_TIMEOUT, 5000),
  },
  notion: {
    apiKey: process.env.NOTION_API_KEY || "",
    beansDbId: process.env.NOTION_BEANS_DB_ID || "",
    brewsDbId: process.env.NOTION_BREWS_DB_ID || "",
    profilesDbId: process.env.NOTION_PROFILES_DB_ID || "",
  },
  webhook: {
    secret: process.env.WEBHOOK_SECRET || "",
  },
  sync: {
    intervalMs: parseEnvNumber(process.env.SYNC_INTERVAL_MS, 30000),
    profileReconcileEnabled: parseEnvBoolean(process.env.PROFILE_RECONCILE_ENABLED, true),
    profileReconcileIntervalMs: parseEnvNumber(process.env.PROFILE_RECONCILE_INTERVAL_MS, 60000),
    profileReconcileDeleteEnabled: parseEnvBoolean(process.env.PROFILE_RECONCILE_DELETE_ENABLED, true),
    profileReconcileDeleteLimitPerRun: parseEnvNumber(process.env.PROFILE_RECONCILE_DELETE_LIMIT_PER_RUN, 3),
    profileReconcileSaveLimitPerRun: parseEnvNumber(process.env.PROFILE_RECONCILE_SAVE_LIMIT_PER_RUN, 5),
    /** When false, the bridge does not overwrite the device's selected profile with Notion's Selected checkbox.
     * This lets you change profiles on the GaggiMate (physical controls, web UI) without Notion reverting it. */
    profileSyncSelectedToDevice: parseEnvBoolean(process.env.PROFILE_SYNC_SELECTED_TO_DEVICE, false),
    /** When false, the bridge does not overwrite the device's favorite state with Notion's Favorite checkbox. */
    profileSyncFavoriteToDevice: parseEnvBoolean(process.env.PROFILE_SYNC_FAVORITE_TO_DEVICE, false),
    // When false, shot polling never calls the device profile WebSocket APIs.
    // This keeps shot ingest prioritized and avoids profile-list fetch load.
    importMissingProfilesFromShots: parseEnvBoolean(process.env.IMPORT_MISSING_PROFILES_FROM_SHOTS, false),
    recentShotLookbackCount: parseEnvNumber(process.env.RECENT_SHOT_LOOKBACK_COUNT, 5),
    brewRepairIntervalMs: parseEnvNumber(process.env.BREW_REPAIR_INTERVAL_MS, 3600000), // 1 hour
  },
  time: {
    brewTitleTimeZone: process.env.BREW_TITLE_TIMEZONE || process.env.TZ || "America/Los_Angeles",
  },
  http: {
    port: parseEnvNumber(process.env.HTTP_PORT, 3000),
  },
  data: {
    dir: process.env.DATA_DIR || "./data",
  },
} as const;
