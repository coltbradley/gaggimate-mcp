# CLAUDE.md — GaggiMate Notion Bridge

## What This Is
A Node.js bridge service (Docker on TrueNAS) that sits between a GaggiMate espresso machine and Notion.
Two data flows:
1. **Shots out:** Polls GaggiMate for new shots → auto-logs to Notion Brews DB
2. **Profiles in/out:** Reconciles Notion profile state ↔ GaggiMate; handles queued pushes from Notion webhooks

## Project Structure
```
src/
  index.ts                      — Entry point: starts HTTP server + pollers
  config.ts                     — Environment config (dotenv)
  gaggimate/
    client.ts                   — WebSocket/HTTP client for GaggiMate API
    types.ts                    — GaggiMate type definitions
    profileNormalization.ts     — Fills phase defaults + strips device-incompatible fields
  notion/
    client.ts                   — Notion API wrapper (Brews, Profiles, Beans)
    types.ts                    — Notion DB schema types
    mappers.ts                  — Shot data → Notion properties conversion
  http/
    server.ts                   — Express app setup
    routes/health.ts            — GET /health
    routes/webhook.ts           — POST /webhook/notion
    routes/status.ts            — GET /status (diagnostics + sync state)
    routes/logs.ts              — GET /logs (recent log lines)
    routes/device.ts            — GET /device/* (proxy to GaggiMate)
  sync/
    shotPoller.ts               — Background loop: GaggiMate → Notion shot sync
    profileReconciler.ts        — Background loop: Notion ↔ GaggiMate profile sync
    profilePush.ts              — Shared profile push logic (webhook + reconciler)
    profilePreferenceSync.ts    — Syncs favorite/selected checkboxes to device
    state.ts                    — Sync state persistence (JSON file)
  analysis/
    shotAnalysis.ts             — DDSA: per-phase pressure/flow/temp/resistance metrics
    types.ts                    — MetricStats, PhaseAnalysis, ShotAnalysis types
  mcp/
    server.ts                   — MCP server + Streamable HTTP transport mount
    tools.ts                    — MCP tool registrations (brew queries, profiles, device, analysis)
    resources.ts                — MCP resources (recent-brews, active-profiles, device-status)
  parsers/
    binaryIndex.ts              — Parses index.bin shot history (preserved from upstream)
    binaryShot.ts               — Parses .slog shot files (preserved from upstream)
  transformers/
    shotTransformer.ts          — Binary → AI-friendly JSON (preserved from upstream)
  utils/
    connectivity.ts             — Classifies connectivity errors (EHOSTUNREACH etc.)
    text.ts                     — Mojibake repair for profile label comparison
tests/
  sync/
    shotPoller.test.ts          — Shot poller unit tests (vitest)
```

## Key Commands
```bash
npm run build          # TypeScript compilation
npm run dev            # Development with tsx watch mode
npm start              # Production (compiled JS)
npm test               # Run unit tests (vitest)
docker compose up      # Run with Docker
curl localhost:3000/health  # Health check
```

## Environment Variables
| Variable | Default | Description |
|---|---|---|
| `GAGGIMATE_HOST` | `localhost` | GaggiMate IP/hostname (required) |
| `GAGGIMATE_PROTOCOL` | `ws` | `ws` or `wss` |
| `REQUEST_TIMEOUT` | `5000` | GaggiMate request timeout (ms) |
| `NOTION_API_KEY` | — | Notion integration token (required) |
| `NOTION_BREWS_DB_ID` | — | Notion brews database ID (required) |
| `NOTION_PROFILES_DB_ID` | — | Notion profiles database ID (required) |
| `NOTION_BEANS_DB_ID` | — | Notion beans database ID (optional) |
| `WEBHOOK_SECRET` | — | Notion webhook verification token |
| `SYNC_INTERVAL_MS` | `300000` | Fallback shot poll interval (ms); primary trigger is `evt:status` WebSocket event |
| `RECENT_SHOT_LOOKBACK_COUNT` | `5` | Lookback window for rehydrating incomplete shots |
| `BREW_REPAIR_INTERVAL_MS` | `3600000` | How often to scan for stale/missing brew data (1 hour) |
| `PROFILE_RECONCILE_ENABLED` | `true` | Enable profile reconciler |
| `PROFILE_RECONCILE_INTERVAL_MS` | `60000` | Reconciler interval |
| `PROFILE_RECONCILE_DELETE_ENABLED` | `true` | Allow deleting profiles from device |
| `PROFILE_RECONCILE_DELETE_LIMIT_PER_RUN` | `3` | Max device deletes per cycle |
| `PROFILE_RECONCILE_SAVE_LIMIT_PER_RUN` | `5` | Max device saves per cycle |
| `PROFILE_SYNC_SELECTED_TO_DEVICE` | `false` | Sync Notion Selected checkbox → device (opt-in; default off to preserve device-side selection) |
| `PROFILE_SYNC_FAVORITE_TO_DEVICE` | `false` | Sync Notion Favorite checkbox → device (opt-in) |
| `PROFILE_IMPORT_UNMATCHED_DEVICE_PROFILES` | `false` | Import device-only profiles into Notion as Draft on each reconcile cycle |
| `IMPORT_MISSING_PROFILES_FROM_SHOTS` | `false` | Auto-import profiles referenced in shots that don't yet exist in Notion |
| `BREW_TITLE_TIMEZONE` | `America/Los_Angeles` | Timezone for brew title date strings |
| `HTTP_PORT` | `3000` | HTTP server port |
| `DATA_DIR` | `./data` | Persistent data directory |

## GaggiMate API
- **Shot history index:** `GET /api/history/index.bin` — binary format, `SHOT_INDEX_ENTRY_SIZE=128` bytes/entry
- **Shot files:** `GET /api/history/{paddedId}.slog` — binary format, ID zero-padded to 6 digits
- **WebSocket:** `ws://{host}/ws` — JSON messages with `tp` field for type, `rid` for request ID
  - Profile commands: `req/res:profiles:list`, `load`, `save`, `delete`, `select`, `favorite`, `unfavorite`
- `SHOT_FLAG_COMPLETED (0x01)` is set in the index entry only after the shot file is fully written
- The device omits fields like `targets: []` and returns them as absent rather than empty arrays

## Shot Sync Flow (ShotPoller)
1. **Event-driven trigger:** Subscribes to `evt:status` WebSocket events from the device. When brew state transitions from `"brewing"` to any other state, a sync is triggered after a 2-second delay (shot file settling time)
2. **Fallback polling:** A `setInterval` at `SYNC_INTERVAL_MS` (default 30s) runs as backup for cases where WebSocket events are missed or the connection is not yet established
3. **Connectivity cooldown:** Any connectivity error activates 3-minute cooldown; polls are skipped entirely until it expires, then reset on first successful poll
4. **Hourly repair scan** (`repairStaleBrews`): Checks last 50 synced shots for stale Shot JSON (`sample_count === 0`) or missing Brew Profile chart images; re-syncs only what's missing. Batched 3 at a time to avoid starving shot ingest
5. **New shots** (`id > lastSyncedShotId`): Processed oldest-first from `GET /api/history/index.bin`; stops at first incomplete shot
6. **Lookback window** (`RECENT_SHOT_LOOKBACK_COUNT` shots back from `lastSyncedShotId`): Re-processes recently-synced shots to rehydrate any that were captured while the .slog was still settling
7. **Per-shot:** Fetches .slog + shot notes + checks Notion for existing brew in parallel; skips if index flag says incomplete
8. **DDSA analysis:** `analyzeShotData()` runs on the parsed shot binary to compute per-phase metrics; results folded into the Notion brew upsert
9. **Profile auto-import:** If the brew references a profile not in Notion, imports it as Draft (with double-check to avoid races)
10. **Notion create/update:** Shot JSON + analysis folded into the brew create/update call; chart SVG uploaded separately
11. **`fullySyncedShots` cache:** Tracks shots where brew + JSON + chart are all confirmed present; pruned as `lastSyncedShotId` advances to keep memory bounded
12. **State persistence:** `lastSyncedShotId`, `lastSyncTime`, `totalShotsSynced` → `/app/data/sync-state.json` after each new sync

## Profile Sync Flow (ProfileReconciler)
Runs every 30s. Fetches device profiles and Notion profiles in parallel, then:

**Notion → Device (by status):**
- `Draft` — ignored; user hasn't queued it yet
- `Queued` — validates (temperature 60–100°C, ≥1 phase, ≤20 phases), normalizes, pushes to device, saves normalized JSON + `Pushed` status back to Notion
- `Pushed` — checks equivalence against device profile; re-pushes from Notion JSON if drift detected; syncs `favorite`/`selected` checkboxes to device independently
- `Archived` — deletes from device (rate-limited; skips utility profiles like Flush/Descale)
- `Failed` — ignored; requires manual intervention in Notion

**Device → Notion (import):**
- Device profiles with no matching Notion record (by ID or normalized name) are imported as `Draft`

**Backfill:**
- Brews without a Profile relation are backfilled by fetching the shot's profile name and linking to the matching Notion profile page; cooldown (2–5 min) prevents hammering when nothing is linkable

**Profile equivalence (`areProfilesEquivalent`):**
- Both sides are passed through `normalizeProfileForGaggiMate` before comparison
- Normalization fills phase defaults (`valve→1`, `pump.target→"pressure"`, `pump.pressure→9`, `pump.flow→0`) and strips fields the device omits (e.g. `targets: []`)
- Text is normalized via mojibake repair + whitespace collapse before string comparison
- `isSubsetMatch` checks that every key in the Notion JSON exists in the device profile with the same value (desired ⊆ actual, not symmetric)
- When a mismatch is found, the first differing path is logged as a warn for diagnosis

## Profile Normalization (`normalizeProfileForGaggiMate`)
Called by both `saveProfile` (before sending to device) and all Notion JSON writes, so both sides are always in the same canonical form:
- Fills missing phase defaults
- Normalizes `phase.phase` to `"preinfusion"` or `"brew"`
- Strips `targets: []` (device omits empty arrays; storing them causes false equivalence mismatches)

## Webhook Flow
`POST /webhook/notion`:
1. Responds immediately with `200 { ok: true }` before any device calls (prevents Notion timeout)
2. Verifies HMAC-SHA256 signature against `WEBHOOK_SECRET` if configured (timing-safe comparison)
3. Filters to profile DB pages only (using `parent.database_id` from payload when available)
4. Background: fetches page data, checks `pushStatus`:
   - `Queued` → calls `pushProfileToGaggiMate` (shared with reconciler)
   - `Pushed` → syncs `favorite`/`selected` to device if those properties changed
   - Anything else → ignored

## MCP Server

Endpoint: `POST/GET/DELETE /mcp` (Streamable HTTP transport, MCP protocol version 2.0).

**How Claude Code connects:**
```json
{
  "mcpServers": {
    "gaggimate": {
      "type": "url",
      "url": "http://<bridge-host>:3000/mcp"
    }
  }
}
```

**Tools registered (`src/mcp/tools.ts`):**
| Tool | Description |
|---|---|
| `get_recent_brews` | Query recent brews from Notion (default 10, max 50) |
| `get_brew_detail` | Full details for a specific shot by ID |
| `compare_shots` | Side-by-side comparison of two shots for dialing in |
| `get_brew_trends` | Trend analysis across recent brews |
| `list_profiles` | List all profiles from Notion |
| `push_profile` | Queue a profile for push to device |
| `archive_profile` | Archive a profile (removes from device) |
| `get_device_status` | Live device reachability + WS diagnostics |
| `analyze_shot` | Run DDSA analysis on a specific shot |
| `get_shot_notes` | Fetch user notes from GaggiMate for a shot |
| `save_shot_notes` | Write notes back to GaggiMate for a shot |

**Resources registered (`src/mcp/resources.ts`):**
| URI | Description |
|---|---|
| `gaggimate://brews/recent` | Recent brews snapshot |
| `gaggimate://profiles/active` | Active profiles list |
| `gaggimate://device/status` | Live device status |

**Session management:** Each MCP client gets a UUID session ID. Sessions are tracked in-memory; `DELETE /mcp` terminates a session. Concurrent clients are supported.

## DDSA Analysis (`src/analysis/`)

DDSA (per-shot data analysis) runs `analyzeShotData()` on every parsed `.slog` binary to compute structured metrics stored in the Notion brew record.

**Computed metrics (`ShotAnalysis`):**
- `phases[]` — per-phase breakdown (`PhaseAnalysis`):
  - `pressure`, `flow`, `temperature`, `puckResistance` — each a `MetricStats` (min/max/avg/start/end), time-weighted
  - `weightFlowRate` — g/s via linear regression over last 4 seconds of phase
  - `exitReason` — "Time Stop", "Weight Stop", or null
- `totalDurationMs` — full shot duration
- `isBrewByWeight` — true if shot started in volumetric/by-weight mode
- `finalWeight` — last weight reading in grams (or null)
- `avgPuckResistance` / `peakPuckResistance` — across all phases
- `avgWeightFlowRate` — overall g/s average
- `exitReason` — final stop reason
- `phaseSummary` — human-readable string, e.g. `"Preinfusion: 8s @ 3 bar -> Brew: 24s @ 9 bar"`

All numeric values are rounded to 1 decimal place. Analysis is stored in the `Shot JSON` Notion property alongside the raw transformer output.

## Shot Notes

The device supports per-shot text notes stored on the GaggiMate. The bridge:
- **Fetches notes** during shot sync (`gaggimate.fetchShotNotes(id)`) in parallel with `.slog` fetch and Notion lookup
- **Syncs to Notion** — `doseIn` → `Dose In` (number), `grindSetting` → `Grind Setting` (number), `balanceTaste` → `Taste Balance` (select)
- **Not synced:** `doseOut` maps to existing `Yield Out` (already written from shot binary weight data), `ratio` is a Notion formula (Yield Out ÷ Dose In), `beanType` has no direct property (use `Beans` relation instead)
- **Read/write via MCP** — `get_shot_notes` and `save_shot_notes` tools allow Claude to read and write notes on demand

## Notion Brews DB Schema

**System-written properties** (written by bridge on every sync):

| Property | Type | Source |
|---|---|---|
| `Brew` | title | `#047 - Feb 14 AM` formatted from shot ID + date |
| `Activity ID` | text | GaggiMate shot ID (dedup key) |
| `Date` | date | Shot timestamp |
| `Brew Time` | number | Duration in seconds |
| `Brew Temp` | number | Average temperature (°C) |
| `Peak Pressure` | number | Max pressure (bar) |
| `Pre-infusion Time` | number | Preinfusion duration (seconds) |
| `Total Volume` | number | Volume in mL |
| `Yield Out` | number | Final weight in grams (nullable) |
| `Source` | select | "Auto" or "Manual" |
| `Dose In` | number | From shot notes (grams, nullable) |
| `Grind Setting` | number | From shot notes (nullable) |
| `Taste Balance` | select | From shot notes: bitter/balanced/sour (nullable) |
| `Avg Puck Resistance` | number | DDSA analysis (nullable) |
| `Peak Puck Resistance` | number | DDSA analysis (nullable) |
| `Weight Flow Rate` | number | DDSA analysis, g/s (nullable) |
| `Phase Summary` | text | DDSA: e.g. "Preinfusion: 8s @ 3 bar → Brew: 24s @ 9 bar" |
| `Exit Reason` | text | DDSA: e.g. "Weight Stop" (nullable) |
| `Shot JSON` | text | Full transformed shot + analysis JSON |
| `Brew Profile` | file | SVG chart image |

**Computed properties** (Notion formulas, not written by bridge):
| `Ratio` | formula | Yield Out ÷ Dose In |
| `Bean Age` | formula | Days since related bean's Roast Date |

**User-owned properties** (never overwritten by bridge):
| `Notes` | text | Free-form user notes |
| `Taste Notes` | text | Flavor descriptors |
| `Channeling` | checkbox | Observed channeling |
| `Beans` | relation | Link to Beans DB |
| `Profile` | relation | Link to Profiles DB |

## Debug Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Full health check: GaggiMate reachability, Notion connectivity, sync state, uptime |
| `GET /status` | Diagnostics: GaggiMate WS diagnostics, sync state (lastShotId, lastSyncTime, totalSynced), uptime, heap usage |
| `GET /logs[?count=N]` | Recent log lines (default 100, max 500) as `text/plain` |

`/status` is lighter-weight than `/health` (no external API calls) and safe to poll frequently. `/logs` tails the in-memory log buffer (`src/utils/logBuffer.ts`).

## HTTP Health Endpoint
`GET /health` returns:
```json
{
  "status": "ok",
  "gaggimate": { "host": "192.168.x.x", "reachable": true },
  "notion": { "connected": true },
  "lastShotSync": "2025-02-25T10:30:15.123Z",
  "lastShotId": "078",
  "totalShotsSynced": 78,
  "uptime": 3600
}
```
- `gaggimate.reachable`: HEAD to `/api/history/index.bin` with 3s timeout (200 or 404 = reachable)
- `notion.connected`: `users.me()` API call
- `notion.imageUploadDisabled`: only present when image uploads are permanently disabled (e.g. after a 401 from Notion's file upload API)

## Important Conventions
- **Shot dedup key:** `Activity ID` property in Notion Brews DB = GaggiMate shot ID string
- **Brew title format:** `#047 - Feb 14 AM` (3-digit zero-padded ID + locale-aware date/time)
- **Profile push:** validates temperature 60–100°C, requires ≥1 phase, rejects >20 phases
- **All Notion writes are system-owned fields only** — user fields (Notes, Ratings, etc.) are never overwritten
- **Per-shot failure isolation** — one bad shot doesn't stop the poller; errors are caught and logged
- **Image uploads are best-effort** — a failed chart upload doesn't fail the brew sync; repair scan will retry
- **Connectivity cooldown** — both pollers activate 3-minute cooldown on connectivity errors; resets on first successful response

## Auto-Deploy (CI/CD + Watchtower)

**GitHub Actions (`/.github/workflows/ci.yml`):**
- On every push to `main`: runs type check, build, and tests across Node 18/20/22
- On passing tests: builds and pushes Docker image to GHCR with three tags:
  - `ghcr.io/graphite-productions/gaggimate-bridge:latest` — always current
  - `ghcr.io/graphite-productions/gaggimate-bridge:YYYY-MM-DD` — date-based for pinning
  - `ghcr.io/graphite-productions/gaggimate-bridge:<git-sha>` — exact commit

**Watchtower (in `docker-compose.yml`):**
- Polls GHCR every 5 minutes for a new `latest` image
- Pulls and restarts `gaggimate-bridge` automatically when a new image is available
- `--cleanup` removes the old image after update

This means: merge to `main` → CI builds + pushes → Watchtower picks it up within 5 min → container restarts with new version. No manual `docker pull` or restart needed.

## Known Limitations
- **Non-atomic state writes:** `sync-state.json` is written with `writeFileSync`; a crash mid-write could corrupt the file. Recovery: delete the file and the service will restart from shot 0 (Notion dedup prevents duplicates).
- **Image upload disabled process-lifetime:** A 401 from Notion's file upload API permanently disables image uploads for the current process. Restart the service to re-enable.
- **WebSocket concurrency:** If a webhook fires while the reconciler is mid-cycle, two concurrent WebSocket operations could collide. Failure mode is a logged error and retry on the next cycle; this is rare in practice.
- **Backfill requires device to be online:** Profile-to-brew relation backfill fetches the shot file to read the profile name; if the device is offline, the link is deferred to the next cycle.
