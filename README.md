# GaggiMate Notion Bridge

Bridge service between a [GaggiMate](https://github.com/jniebuhr/gaggimate) espresso machine and [Notion](https://notion.so) for persistent shot logging and AI-assisted profile management.

Forked from [Matvey-Kuk/gaggimate-mcp](https://github.com/Matvey-Kuk/gaggimate-mcp) — we reuse the binary shot parsers and WebSocket patterns, but replace the MCP protocol with a standalone HTTP service.

## What It Does

- **Auto-logs shots** — Polls GaggiMate every 30s for new shots, creates entries in your Notion Brews database with brew time, temperature, pressure, weight, and profile name
- **Pushes profiles** — When you (or Notion AI) set a profile's Push Status to "Queued" in Notion, the service pushes it to the GaggiMate within seconds
- **Reconciles profiles** — Notion is the source of truth for bridge-managed profiles (`Queued`/`Pushed`/`Archived`)
- **Imports device-only profiles (opt-in)** — Unmatched machine-only profiles can be imported as `Draft` when enabled
- **Normalizes profile payloads** — Before device saves, phase defaults are applied (`valve`, `pump.target`, `pump.pressure`, `pump.flow`) for schema compatibility
- **Syncs profile state (opt-in)** — `Favorite` sync is bidirectional intent; `Selected` sync is "select when checked" (no explicit deselect command)
- **Generates charts** — Auto-attaches brew charts to `Brew Profile` and profile charts to `Profile Image` when missing
- **Repairs stale brew data** — Hourly background scan detects brews with empty Shot JSON or missing chart images and re-syncs them
- **Backfills brew/profile links** — Automatically links existing brews to profiles when `Activity ID` + shot metadata identifies the profile
- **Survives firmware updates** — Shot history on the ESP32 gets wiped by OTA updates; Notion is the permanent record
- **Device control panel** — Switch profiles and manage favorites through the bridge when the GaggiMate web portal isn't directly accessible (e.g. when remote via Tailscale)

## Architecture

```
GaggiMate (ESP32) ←→ Bridge Service (Docker) ←→ Notion (Cloud)
```

- **Bridge** runs on TrueNAS SCALE (or any Docker host on the LAN)
- **Notion** is the entire UI — browse shots, tag beans, ask Notion AI for dial-in advice
- **Webhook** (optional) gives low-latency profile push; the reconcile loop covers profiles without it

## Runtime Priorities

The bridge is intentionally tuned for reliability in this order:
1. **Shot ingest first** — shot polling runs every `SYNC_INTERVAL_MS` (default `30000`) and avoids overlap.
2. **Webhook speed + reconcile fallback** — webhooks push fast; reconcile loop (`PROFILE_RECONCILE_INTERVAL_MS`, default `60000`) guarantees queued work still runs if webhooks fail.
3. **Device-profile import is optional** — import flags default to `false` to reduce ESP32 WebSocket load.
4. **Control-panel fallback** — `/control` still works when the device portal is unavailable; if the device is offline it shows Notion fallback profiles in read-only mode.

## Quick Start

```bash
# Clone and install
git clone https://github.com/coltbradley/gaggimate-mcp.git
cd gaggimate-mcp
npm install

# Configure
cp .env.example .env
# Edit .env with your GaggiMate IP, Notion API key, and database IDs

# Run in development
npm run dev

# Or with Docker
docker compose up --build
```

## Network and access

By default the bridge listens on `127.0.0.1` only. Why: it holds the Notion and device credentials and can change the machine's profiles, so a LAN-wide listener with no token was an open door.

- Every route except `GET /health` needs `API_TOKEN`, as `Authorization: Bearer <token>` (MCP clients, scripts) or as the session cookie below. If `API_TOKEN` is unset, protected routes answer 401 with a message saying so, and the server refuses to start on any non-loopback `HTTP_HOST`.
- Control panel: open `/control`. Without a session you are redirected to `/login`; enter the token once. The server sets an HttpOnly, `SameSite=Strict` cookie (Secure when proxied over https) that holds a keyed hash of the token, not the token. The panel's own calls to `/api/device/*` then work without a header. Scripts keep using the bearer header.
- Remote access: Desk's deploy publishes the loopback port to the tailnet with `tailscale serve` (for example `tailscale serve --bg --https=443 http://127.0.0.1:3000`), so only tailnet devices reach it, over https.
- The TrueNAS deploy (`docker-compose.truenas.yml`) uses `network_mode: host` and the default `HTTP_HOST=127.0.0.1`.
- Docker with a published port (bridge networking) needs `HTTP_HOST=0.0.0.0` inside the container; publish it on the host loopback (`127.0.0.1:3000:3000`) and set `API_TOKEN`.
- There is no login rate limit; the token should be long and random, and access stays on the tailnet.

## Environment Variables

Copy `.env.example` to `.env` and fill in your values. Never commit `.env` — it contains secrets.

| Variable | Description | Default |
|---|---|---|
| `GAGGIMATE_HOST` | GaggiMate IP/hostname reachable from the bridge container | `localhost` |
| `GAGGIMATE_PROTOCOL` | `ws` or `wss` | `ws` |
| `REQUEST_TIMEOUT` | GaggiMate request timeout (ms) | `5000` |
| `NOTION_API_KEY` | Notion integration token (starts with `ntn_`) | required |
| `NOTION_BREWS_DB_ID` | Notion Brews database ID | required |
| `NOTION_PROFILES_DB_ID` | Notion Profiles database ID | required |
| `NOTION_BEANS_DB_ID` | Notion Beans database ID | optional |
| `HTTP_HOST` | Interface to listen on. Loopback by default so the bridge is not reachable from the LAN; see "Network and access" | `127.0.0.1` |
| `HTTP_PORT` | HTTP port | `3000` |
| `API_TOKEN` | Secret required on every route except `GET /health`. Unset means those routes answer 401 and a non-loopback `HTTP_HOST` refuses to start | required in practice |
| `WEBHOOK_SECRET` | Notion webhook verification token (raw token, not `sha256=...`). `POST /webhook/notion` exists only when this is set; every request must carry a valid HMAC signature | optional |
| `SYNC_INTERVAL_MS` | Shot polling interval (ms) | `30000` |
| `RECENT_SHOT_LOOKBACK_COUNT` | Recent shots to re-check each poll | `5` |
| `BREW_REPAIR_INTERVAL_MS` | How often to scan for stale/missing brew data (ms) | `3600000` (1h) |
| `PROFILE_RECONCILE_ENABLED` | Enable profile reconciler | `true` |
| `PROFILE_RECONCILE_INTERVAL_MS` | Reconciler interval (ms) | `60000` |
| `PROFILE_RECONCILE_DELETE_ENABLED` | Allow deleting Archived profiles from device | `true` |
| `PROFILE_RECONCILE_DELETE_LIMIT_PER_RUN` | Max device deletes per reconcile cycle | `3` |
| `PROFILE_RECONCILE_SAVE_LIMIT_PER_RUN` | Max device saves per reconcile cycle | `5` |
| `PROFILE_SYNC_SELECTED_TO_DEVICE` | When false (default), bridge does not overwrite device selection with Notion — lets you change profiles on the GaggiMate | `false` |
| `PROFILE_SYNC_FAVORITE_TO_DEVICE` | When false (default), bridge does not overwrite device favorite state with Notion | `false` |
| `PROFILE_IMPORT_UNMATCHED_DEVICE_PROFILES` | When true, reconciler imports unmatched device profiles as Notion Draft rows | `false` |
| `IMPORT_MISSING_PROFILES_FROM_SHOTS` | When true, shot sync fetches profiles from device to auto-import missing Notion profiles | `false` |
| `BREW_TITLE_TIMEZONE` | Timezone for brew title date/AM/PM labels | `America/Los_Angeles` |
| `HTTP_PORT` | HTTP server port | `3000` |
| `DATA_DIR` | Persistent data directory (sync state) | `./data` |

Deprecated and ignored:
- `POLLING_FALLBACK`
- `PROFILE_POLL_INTERVAL_MS`

## Security

- **Never commit API keys.** Use `.env` (gitignored) or environment variables. See [Notion's API key best practices](https://developers.notion.com/guides/resources/best-practices-for-handling-api-keys).
- The webhook is off unless `WEBHOOK_SECRET` is set to Notion's **raw verification token** (not `sha256=...`). Signatures are verified against the raw body (`X-Notion-Signature: sha256=<hex>`, constant-time); malformed or non-ASCII headers get 401. The bridge no longer adopts a token sent in a verification request, so copy the token into `WEBHOOK_SECRET` and restart. Profile reconcile keeps working without the webhook. Without Tailscale Funnel (or another public URL) Notion cannot reach the webhook at all, and the reconcile loop covers profiles. A new Notion webhook subscription sends a verification token once; put it in `WEBHOOK_SECRET` by hand and restart.
- If a key is compromised: revoke it in [Notion integrations](https://www.notion.so/my-integrations), generate a new one, and rotate in all environments.

## API

- `GET /health` — Public, no token. Status, version, uptime, GaggiMate and Notion reachability, and `auth.tokenSet` / `webhook.secretSet` as booleans. No hosts, IDs or secrets.
- `POST /webhook/notion` — Receives Notion webhooks for profile push (only exists when `WEBHOOK_SECRET` is set; signature auth, no bearer token)
- `GET /login`, `POST /login` — Trade the API token for the control-panel cookie
- `GET /control` — **Device control panel** — switch profiles and manage favorites when the GaggiMate web portal isn't accessible (e.g. remote via Tailscale)
- `GET /api/device/profiles` — List device profiles (or Notion fallback profiles if device is offline). Response includes `source`: `device`, `device+notion`, or `notion-fallback`.
- `POST /api/device/profiles/:id/select` — Select a profile (make it active)
- `POST /api/device/profiles/:id/favorite` — Set favorite state (body: `{ "favorite": true|false }`)
- `POST /api/device/profiles/:id/unfavorite` — Convenience endpoint for favorite false

Profile JSON validation rules: [`docs/mcp-json-validation.md`](docs/mcp-json-validation.md)

## Notion Databases

Three databases, fully interlinked:
- **Beans** — Each bag of beans you buy
- **Brews** — Every shot, auto-populated by the bridge
- **Profiles** — Pressure profiles with push-to-machine capability

Important for Profiles DB: add `Favorite` (checkbox) and `Selected` (checkbox) properties so device state sync works.

See [CLAUDE.md](CLAUDE.md) for comprehensive architecture documentation, API reference, and Notion schema details.

See [`docs/SETUP.md`](docs/SETUP.md) for complete setup instructions including Notion database schemas, environment configuration, and deployment options.
For a Notion-only copy/paste guide (database schema, relationship model, and AI instructions), see [`docs/NOTION-WORKSPACE-SETUP.md`](docs/NOTION-WORKSPACE-SETUP.md).

See [`docs/PRD.md`](docs/PRD.md) for the full product requirements document.

## Development

```bash
npm install
npm run dev          # Start with tsx (hot reload)
npm test             # Run tests
npm run typecheck    # Type check without emitting
npm run build        # Compile TypeScript
```

Tests run automatically on push and PR via GitHub Actions (Node 18, 20, 22).
