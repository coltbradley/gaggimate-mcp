import "dotenv/config";

function parseEnvNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
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
  api: {
    token: process.env.API_TOKEN || "",
  },
  sync: {
    intervalMs: parseEnvNumber(process.env.SYNC_INTERVAL_MS, 30000),
  },
  http: {
    port: parseEnvNumber(process.env.HTTP_PORT, 3000),
  },
  data: {
    dir: process.env.DATA_DIR || "./data",
    shotRetentionDays: parseEnvNumber(process.env.SHOT_RETENTION_DAYS, 7),
  },
  connectivity: {
    cooldownMs: parseEnvNumber(process.env.CONNECTIVITY_COOLDOWN_MS, 180000),
  },
} as const;
