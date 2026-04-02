# GaggiMate Notion Bridge v2 — Rearchitecture Design

**Date:** 2026-04-02
**Status:** Approved
**Approach:** Evolve current architecture (Approach A — single Docker container on TrueNAS)

## Problem Statement

The bridge works correctly but has three operational problems:
1. **Shot sync latency** — 60+ seconds from pulling a shot to seeing it in Notion, caused by 30s polling interval + incomplete-shot retry delays
2. **Deployment friction** — manual SSH + docker pull + restart to update; sometimes images don't update; no CI/CD
3. **Limited interactivity** — no way to query brews, analyze shots, or manage profiles from Claude; Notion is the only interface

## Constraints

- GaggiMate is an ESP32 on the local WiFi — LAN access only, no cloud connectivity
- Must be free (no paid cloud services)
- Claude access is terminal-only (Claude Code CLI), not Claude Desktop or claude.ai
- Language: TypeScript (binary parsers are the hardest code and are already done + tested)
- TrueNAS SCALE is the always-on host for Docker

## Architecture Overview

Single Docker container on TrueNAS running:
- **Express HTTP server** (port 3000) — health, status, logs, debug endpoints
- **MCP server** (Streamable HTTP at `/mcp`) — Claude Code connects over LAN
- **WebSocket event listener** — persistent connection to GaggiMate for real-time shot detection
- **Background sync** — shot sync (event-driven + slow fallback poll), profile reconciliation (unchanged)
- **DDSA analysis engine** — ported from GaggiMate web UI, runs server-side on each shot

## Section 1: Event-Driven Shot Sync

**Replace 30s polling with WebSocket event subscription.**

The GaggiMate pushes `evt:status` messages over WebSocket that include brew state (the `process` object with brew progress). The new flow:

1. Bridge maintains persistent WebSocket connection (already does this for profiles)
2. Bridge subscribes to `evt:status` events and watches for brew completion
3. On completion: immediately fetches `.slog` via HTTP + shot notes via WebSocket
4. Creates/updates Notion page with brew data, shot notes, DDSA analysis, chart

**Fallback:** Slow poll every 5 minutes via `index.bin` as safety net for missed events.

**Expected latency:** 3-8 seconds (event → fetch → Notion write).

**What changes:**
- `shotPoller.ts` — refactor from interval-based polling to event-driven with fallback poll
- `client.ts` — add event subscription capability (listen for `evt:status` messages without a request ID)
- Keep the lookback/rehydration logic for shots that were mid-write when detected

## Section 2: MCP Server

Add Streamable HTTP MCP endpoint at `/mcp` on the existing Express server.

**Claude Code config** (`~/.claude.json` or project config):
```json
{
  "mcpServers": {
    "gaggimate": {
      "type": "url",
      "url": "http://truenas-ip:3000/mcp"
    }
  }
}
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `get_recent_brews` | Query last N brews from Notion with all metrics |
| `get_brew_detail` | Full brew data + shot analysis + curve for a specific brew |
| `analyze_shot` | Run DDSA analysis on a shot — per-phase metrics, puck resistance, exit reasons |
| `compare_shots` | Compare two shots side-by-side |
| `get_brew_trends` | Trends over time — extraction times, weights, temperatures |
| `list_profiles` | List all profiles (Notion or device) |
| `push_profile` | Create/update a profile and push to device |
| `archive_profile` | Archive a profile (removes from device) |
| `get_device_status` | Machine state — selected profile, brew status, connectivity |
| `get_shot_notes` | Fetch dose/grind/rating/taste from device |
| `save_shot_notes` | Write notes back to device |

### MCP Resources

| Resource | Description |
|----------|-------------|
| `gaggimate://brews/recent` | Last 10 brews as context |
| `gaggimate://profiles/active` | Currently active profiles |
| `gaggimate://device/status` | Machine state |

### Dependencies

- `@modelcontextprotocol/sdk` — MCP server SDK
- Streamable HTTP transport (built into SDK)

## Section 3: DDSA Analysis Engine

Port key computations from GaggiMate web UI's `AnalyzerService.js` (~1000 lines). Runs server-side on each synced shot using the `.slog` data we already parse.

### Computed Metrics

- **Per-phase stats:** min/max/avg for pressure, flow, temperature, puck resistance, weight
- **Weight flow rate:** Linear regression over 4s sliding window (g/s)
- **Exit/stop reason detection:** Why each phase ended (time, weight, pressure, flow, water drawn targets)
- **Puck resistance curve:** Derived from pressure/flow — indicates channeling or bed erosion
- **Scale delay estimation:** Auto-detected offset between pump flow and scale weight

### Shot Notes Integration

Fetched from device via `req:history:notes:get` WebSocket command:
- Dose In, Dose Out, Ratio
- Grind Setting, Bean Type
- Taste Balance (bitter/balanced/sour)
- Rating (0-5)
- Free-text notes

### Notion Properties Added

| Property | Source |
|----------|--------|
| Dose In / Dose Out / Ratio | Shot notes API |
| Grind Setting | Shot notes API |
| Bean Type | Shot notes API |
| Taste Balance | Shot notes API |
| Avg Puck Resistance | DDSA analysis |
| Peak Puck Resistance | DDSA analysis |
| Weight Flow Rate (g/s) | DDSA analysis |
| Phase Breakdown | DDSA analysis (text summary) |
| Exit Reason | DDSA analysis |

Full analysis JSON stored in the Shot JSON property (already exists) for MCP tool access.

### Chart Enhancements

Existing SVG brew charts enhanced with:
- Puck resistance overlay
- Phase transition markers
- Weight flow rate curve

## Section 4: Auto-Deploy

### CI/CD Pipeline

1. Push to GitHub (or merge PR)
2. GitHub Actions: `npm run build` → `npm test` → build Docker image → push to GHCR
3. Images tagged with `latest` + git SHA (for rollback)
4. Broken code never ships — tests must pass

### Auto-Pull on TrueNAS

[Watchtower](https://containrrr.dev/watchtower/) runs as a second Docker container:
- Polls GHCR every 5 minutes for new `latest` image
- Pulls new image, stops old container, starts new one with same config
- Bridge resumes from persisted sync state (`/app/data/sync-state.json`)

**End-to-end:** code push → ~5-7 minutes → TrueNAS running new version. Zero SSH.

### GitHub Actions Workflow

```yaml
on:
  push:
    branches: [main]

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci && npm run build && npm test
      - uses: docker/build-push-action@v5
        with:
          push: true
          tags: ghcr.io/graphite-productions/gaggimate-bridge:latest,${{ github.sha }}
```

## Section 5: SSH & Debugging

### TrueNAS SSH

- Enable SSH in TrueNAS UI (System Settings → Services → SSH)
- Add Mac's public key for passwordless login
- Used for initial setup and emergency debugging only

### Enhanced HTTP Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Existing + WebSocket event status, last event timestamp, DDSA stats |
| `GET /logs` | Last 100 log lines (no need for `docker logs` via SSH) |
| `GET /status` | Detailed sync state, pending ops, Notion API latency, WS connection age |

Most debugging via `curl truenas:3000/status` from Mac. SSH is the escape hatch.

## One-Time TrueNAS Setup

1. Enable SSH on TrueNAS
2. SSH in and deploy two containers:
   - `gaggimate-bridge` (the bridge, from GHCR)
   - `watchtower` (auto-update, from containrrr/watchtower)
3. Configure `.env` with GaggiMate IP, Notion tokens, DB IDs
4. Verify with `curl truenas:3000/health`
5. Configure Claude Code MCP on Mac

After this, no SSH needed for normal operations.

## What Stays the Same

- Binary parsers (`binaryIndex.ts`, `binaryShot.ts`) — unchanged, identical to upstream
- Profile reconciler — same logic, same intervals
- Notion client — same upsert logic, system-owned fields only
- Profile normalization — same `normalizeProfileForGaggiMate`
- Connectivity error handling — same cooldown logic
- Brew title format, dedup keys, state persistence — all unchanged
