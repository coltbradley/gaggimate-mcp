# Setup Guide

Step-by-step instructions to deploy the GaggiMate Notion Bridge on your TrueNAS SCALE NAS (or any Docker host on your LAN).

## Prerequisites

- **GaggiMate** espresso machine on your local network with a known IP address
- **Notion** account with a workspace (Notion AI optional but recommended for dial-in)
- **Docker host** on the same LAN as the GaggiMate (TrueNAS SCALE, Raspberry Pi, or any Linux box)
- **Node.js 18+** (only needed if running outside Docker)

---

## Step 1: Find the GaggiMate IP Address

The GaggiMate ESP32 advertises itself as `gaggimate.local` via mDNS, but Docker containers can't resolve mDNS hostnames. You need the actual IP address.

**Option A: Check your router's DHCP client list**
1. Log into your router admin page
2. Find the device named `gaggimate` or with manufacturer `Espressif`
3. Note the IP (e.g., `192.168.1.100`)

**Option B: Network scanner**
```bash
# macOS/Linux
nmap -sn 192.168.1.0/24 | grep -i espressif
# Or try mDNS
ping gaggimate.local
```

**Recommended:** Set a DHCP reservation in your router so the IP never changes.

**Verify:** Open `http://<gaggimate-ip>` in a browser — you should see the GaggiMate web UI.

---

## Step 2: Create Notion Databases

Create three databases in your Notion workspace. The names are flexible, but the property names must match exactly.

If you want a single copy/paste page specifically for Notion setup and AI instructions, use `docs/NOTION-WORKSPACE-SETUP.md`.

### Beans Database

| Property | Type | Notes |
|---|---|---|
| Bean Name | Title | Free-form name, e.g. "Ethiopia Yirgacheffe Natural" |
| Roaster | Select | Builds reusable list over time |
| Origin | Select | Country/region |
| Process | Select | Natural, Washed, Honey, Anaerobic, Wet-hulled |
| Roast Level | Select | Light, Medium-Light, Medium, Medium-Dark, Dark |
| Roast Date | Date | From the bag (when roasted) |
| Open Date | Date | When you opened the bag |
| Days Since Roast | Formula | `dateBetween(now(), prop("Roast Date"), "days")` |
| Bag Size | Number | Grams |
| Price | Number | Dollars |
| Tasting Notes | Text | Roaster notes or your impressions |
| Buy Again | Checkbox | Quick favorites/re-order filter |
| Purchase URL | URL | Re-order link |
| Brews | Relation → Brews | Two-way relation |
| Notes | Text | Anything else |

### Brews Database

| Property | Type | Notes |
|---|---|---|
| Brew | Title | Auto-generated, e.g. "#047 - Feb 14 AM" |
| Activity ID | Text | GaggiMate shot ID (dedup key) |
| Date | Date (with time) | When the shot was pulled |
| Beans | Relation → Beans | Two-way relation |
| Profile | Relation → Profiles | Two-way relation |
| Grind Setting | Number | User entry |
| Dose In | Number | Grams |
| Yield Out | Number | Grams (auto/manual) |
| Ratio | Formula | `prop("Yield Out") / prop("Dose In")` |
| Brew Time | Number | Seconds (auto) |
| Brew Temp | Number | Celsius (auto) |
| Pre-infusion Time | Number | Seconds (auto) |
| Peak Pressure | Number | Bar (auto) |
| Total Volume | Number | mL (auto) |
| Bean Age | Formula | Days between related Bean roast date and Brew date |
| Taste Notes | Text | Free-form tasting notes |
| Channeling | Checkbox | Visual channeling observed |
| Source | Select | `Auto` or `Manual` |
| Shot JSON | Text | Bridge-written — full transformed shot data |
| Brew Profile | Files | Bridge-written — brew chart SVG |
| Notes | Text | Anything else |

### Profiles Database

| Property | Type | Notes |
|---|---|---|
| Profile Name | Title | e.g. "Classic 9-bar Flat" |
| Description | Text | What the profile does |
| Profile Type | Select | Flat, Declining, Blooming, Lever, Turbo, Custom |
| Best For | Multi-select | Light Roast, Medium Roast, Dark Roast, etc. |
| Source | Select | Stock, Community, AI-Generated, Custom |
| Active on Machine | Checkbox | Tracking what's loaded |
| Favorite | Checkbox | Sync target to machine favorite state for managed profiles |
| Selected | Checkbox | When checked, bridge selects this profile on the machine |
| Profile Image | File | Screenshot/export of curve |
| Profile JSON | Text | Raw JSON the machine reads |
| Push Status | Select | `Draft`, `Queued`, `Pushed`, `Archived`, `Failed` |
| Last Pushed | Date (with time) | Auto-set by bridge |
| Brews | Relation → Brews | Two-way relation |
| Notes | Text | Anything else |

Required for reconciler/device state sync:
- `Favorite` must be a **Checkbox** property named exactly `Favorite`
- `Selected` must be a **Checkbox** property named exactly `Selected`

Relations map:
- Beans `<->` Brews (via `Brews` on Beans and `Beans` on Brews)
- Profiles `<->` Brews (via `Brews` on Profiles and `Profile` on Brews)

### What The Bridge Writes vs What Notion/User Owns

The bridge does not manage every field. Keep formulas/relations in Notion, and let the bridge populate only the machine-derived fields.

**Beans DB**
- Bridge writes: none
- Notion/user-managed: all properties (including formulas and relations)

**Brews DB**
- Bridge writes on create:
  - `Brew`
  - `Activity ID`
  - `Date`
  - `Brew Time`
  - `Brew Temp`
  - `Pre-infusion Time`
  - `Peak Pressure`
  - `Total Volume`
  - `Yield Out` (only when weight exists)
  - `Source` (`Auto`)
  - `Profile` relation (if a matching `Profile Name` is found in Profiles DB)
- Bridge backfills:
  - `Profile` relation for existing brews missing it (uses `Activity ID` + GaggiMate shot profile)
- Notion/user-managed:
  - `Beans` relation
  - `Grind Setting`
  - `Dose In`
  - `Ratio` (formula)
  - `Bean Age` (formula)
  - `Taste Notes`
  - `Channeling`
  - `Notes`

**Profiles DB**
- Bridge writes:
  - On device-only profile import (created on GaggiMate UI):
    - Creates Notion page with `Push Status = Draft`
    - Sets `Profile Name`, `Description`, `Profile Type`, `Source`, `Profile JSON`
    - Sets `Active on Machine = true`
    - Copies `Favorite` and `Selected` from device state
    - Uploads `Profile Image` chart
  - On successful push/reconcile:
    - `Push Status` (`Pushed` or `Failed`)
    - `Last Pushed` (on success)
    - `Active on Machine` (true when on device, false when archived/removed)
  - For newly pushed profiles:
    - Writes back machine-assigned profile `id` into `Profile JSON`
  - For `Archived` profiles:
    - Deletes non-utility profiles from machine
    - Never deletes utility profiles (`flush`, `descale`)
- Bridge reads:
  - `Profile JSON`
  - `Push Status`
  - `Favorite`
  - `Selected`
  - `Profile Name` / `Source` (for matching and profile metadata)
- Notion/user-managed:
  - `Best For`
  - `Profile Image` (optional manual override)
  - `Brews` relation
  - `Notes`
  - You may still edit `Description`, `Profile Type`, `Source`, and `Profile JSON`; for `Pushed` records, Notion JSON is authoritative and will be re-applied to device

**After creating databases:** Share each one with your Notion integration (Step 3).

---

## Step 3: Create Notion Integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **"New integration"**
3. Name: `GaggiMate Bridge`
4. Capabilities: **Read content**, **Update content**, **Insert content** — all enabled
5. Copy the **Internal Integration Token** (starts with `ntn_`)
6. **Share each database** with the integration:
   - Open each database in Notion
   - Click **Share** → Invite → search for your integration name → **Invite**

**Get database IDs:** Open each database in Notion as a full page. The URL looks like:
```
https://www.notion.so/yourworkspace/abc123def456...?v=...
                                    ^^^^^^^^^^^^^^^^
                                    This is the database ID
```

**Verify:**
```bash
curl -H "Authorization: Bearer ntn_YOUR_TOKEN" \
     -H "Notion-Version: 2022-06-28" \
     https://api.notion.com/v1/users/me
```

Should return your user info without errors. Never share your token — use environment variables only. See [Notion API key best practices](https://developers.notion.com/guides/resources/best-practices-for-handling-api-keys).

---

## Step 4: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# GaggiMate IP from Step 1
GAGGIMATE_HOST=192.168.1.100
GAGGIMATE_PROTOCOL=ws
REQUEST_TIMEOUT=5000

# Notion token from Step 3
NOTION_API_KEY=ntn_XXXXXXXXXXXX

# Database IDs from Step 3
NOTION_BEANS_DB_ID=abc123...
NOTION_BREWS_DB_ID=def456...
NOTION_PROFILES_DB_ID=ghi789...

# Leave empty if not using webhooks yet
WEBHOOK_SECRET=

# Defaults are fine for most setups
SYNC_INTERVAL_MS=30000
PROFILE_RECONCILE_ENABLED=true
PROFILE_RECONCILE_INTERVAL_MS=60000
PROFILE_RECONCILE_DELETE_ENABLED=true
PROFILE_RECONCILE_DELETE_LIMIT_PER_RUN=3
PROFILE_RECONCILE_SAVE_LIMIT_PER_RUN=5
PROFILE_SYNC_SELECTED_TO_DEVICE=false
PROFILE_SYNC_FAVORITE_TO_DEVICE=false
PROFILE_IMPORT_UNMATCHED_DEVICE_PROFILES=false
IMPORT_MISSING_PROFILES_FROM_SHOTS=false
RECENT_SHOT_LOOKBACK_COUNT=5
# How often to scan for brews with stale JSON or missing chart images (ms, default 1 hour)
BREW_REPAIR_INTERVAL_MS=3600000
HTTP_PORT=3000
BREW_TITLE_TIMEZONE=America/Los_Angeles
```

---

## Step 5: Deploy

### Option A: Docker Compose (recommended)

```bash
# Build and start
docker compose up --build -d

# Check logs
docker compose logs -f

# Verify health
curl http://localhost:3000/health
```

### Option B: TrueNAS SCALE "Install via YAML"

TrueNAS can't build images from source — it pulls pre-built images from a registry. Every push to `main` automatically builds and publishes the image to GitHub Container Registry.

1. Go to **Apps** → **Discover** → three-dot menu → **Install via YAML**
2. Paste the contents of `docker-compose.truenas.yml` (not `docker-compose.yml`)
3. Set the environment variables (GAGGIMATE_HOST, NOTION_API_KEY, database IDs) in the TrueNAS UI
4. The data volume is created automatically as a Docker named volume

### Option C: Run directly (development)

```bash
npm install
npm run dev
```

---

## Step 6: Verify It Works

### 1. Health check
```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "gaggimate": {
    "host": "192.168.1.100",
    "reachable": true,
    "websocket": { "wsQueueDepth": 0, "wsPendingResponses": 0, "wsState": "none" }
  },
  "notion": { "connected": true },
  "webhook": { "signatureVerificationEnabled": false },
  "lastShotSync": null,
  "lastShotId": null,
  "totalShotsSynced": 0,
  "uptime": 5
}
```

Both `reachable` and `connected` should be `true`. If not:
- `reachable: false` → Check GaggiMate IP, make sure Docker can reach it (try `docker exec <container> curl http://192.168.1.100`)
- `connected: false` → Check `NOTION_API_KEY` in `.env`
- `signatureVerificationEnabled: false` while using public webhooks → Set `WEBHOOK_SECRET` and restart the service
- `wsQueueDepth` stays high (for example > 10) → too many overlapping profile actions/webhooks; check Notion automation loops and reduce profile churn

### 2. Device control panel (when web portal isn't accessible)
Open `http://<bridge-host>:3000/control` in a browser. Use this to switch profiles and manage favorites when you can't reach the GaggiMate's web UI directly (e.g. when remote via Tailscale). The bridge proxies requests to the device on your LAN.

### 3. Pull a shot
Pull an espresso shot on your machine. Within 30 seconds, a new entry should appear in your Notion Brews database with the title format `#001 - Feb 14 AM`.

### 4. Test profile push
1. In your Notion Profiles database, create a new entry
2. Set the **Profile JSON** to:
   ```json
   {"temperature":93,"phases":[{"name":"Preinfusion","phase":"preinfusion","duration":10,"pump":{"target":"pressure","pressure":3}},{"name":"Extraction","phase":"brew","duration":30,"pump":{"target":"pressure","pressure":9}}]}
   ```
3. Set **Push Status** to `Queued`
4. Within the next reconcile cycle (default 60s), or immediately via webhook, the status should change to `Pushed`
5. Check the GaggiMate — the profile should appear or update on device

### 5. Test device profile import (GaggiMate → Notion)
Prerequisite: enable at least one of:
- `PROFILE_IMPORT_UNMATCHED_DEVICE_PROFILES=true` (periodic reconciler import)
- `IMPORT_MISSING_PROFILES_FROM_SHOTS=true` (shot-driven import when profile is missing)

1. Create a new profile on the GaggiMate UI
2. Wait up to 60 seconds (default reconcile interval), or pull a shot with that profile
3. Confirm a new page appears in the Notion Profiles DB
4. Confirm imported profile starts with `Push Status = Draft`
5. Confirm the brew's `Profile` relation links to that profile

### 6. Test authoritative Notion reconcile
1. Edit `Profile JSON` for an existing `Pushed` profile in Notion
2. Wait one reconcile interval
3. Confirm profile remains edited in Notion and changes are pushed to machine (Notion wins)

### 7. Test archive behavior
1. Set a non-utility profile `Push Status` to `Archived`
2. Confirm it is removed from GaggiMate
3. Confirm `Active on Machine` is unchecked
4. Repeat with a utility profile (`flush`/`descale`) and confirm it is not deleted

### 8. Test Favorite/Selected sync (optional)
1. Set `PROFILE_SYNC_FAVORITE_TO_DEVICE=true` and/or `PROFILE_SYNC_SELECTED_TO_DEVICE=true` in `.env`
2. Restart the bridge
3. For a `Pushed` profile, toggle `Favorite` and/or `Selected` in Notion
4. Confirm the corresponding state changes on GaggiMate

---

## Step 7: Set Up Webhooks (Optional)

For real-time profile push (< 1 second instead of waiting for the next reconcile interval), set up Notion webhooks via Tailscale Funnel.

### Enable Tailscale Funnel

```bash
# On your TrueNAS (or Docker host)
tailscale funnel 3000
```

This gives you a public URL like `https://your-machine.tail12345.ts.net`.

### Create Notion Webhook

1. In [notion.so/my-integrations](https://www.notion.so/my-integrations), find your integration
2. Go to **Webhooks** → Create new webhook
3. Endpoint URL: `https://your-machine.tail12345.ts.net/webhook/notion`
4. Subscribe to page property changes on the Profiles database
5. Optional but recommended: copy the webhook **verification token** and add it to your `.env`:
   ```
   WEBHOOK_SECRET=your_webhook_verification_token_here
   ```
   - If set, webhook signatures are verified.
   - If unset, webhook events are accepted unsigned (safest only on trusted/private networks).
6. Restart the bridge service

**Verify:** Change a profile's Push Status to "Queued" — it should push within ~1 second.

---

## Updating

Every push to `main` automatically builds and publishes a new `:latest` image to GitHub Container Registry. You don't need to track SHA hashes — just pull `latest`.

### Check what version is running

```bash
# From logs at startup:
#   Version: 2026-02-25 15:13 UTC (abc1234)

# Or from the health endpoint anytime:
curl http://localhost:3000/health | grep -E 'version|commit'
```

### Update on TrueNAS

```bash
# Pull the new image and restart
docker pull ghcr.io/graphite-productions/gaggimate-bridge:latest
docker restart gaggimate-bridge
```

The startup log will immediately confirm the new version. The service resumes where it left off — sync state is preserved on the data volume.

### Pin to a specific date

If you need to roll back or pin to a specific build, date-based tags are published alongside `latest`:

```
ghcr.io/graphite-productions/gaggimate-bridge:2026-02-25
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `reachable: false` | GaggiMate not on network or wrong IP | Check IP, ensure DHCP reservation, try pinging from Docker host |
| `connected: false` | Bad Notion token | Re-copy from my-integrations, ensure no trailing whitespace |
| Shots not syncing | Database not shared with integration | Open each DB → Share → invite integration |
| Profile push "Failed" | Invalid Profile JSON | Check JSON format (see template above), temperature must be 60-100 |
| Brew title AM/PM appears wrong | Container timezone differs from your local timezone | Set `BREW_TITLE_TIMEZONE` (e.g. `America/Los_Angeles`) and restart |
| Frequent timeout warnings | GaggiMate slow/unreachable or timeout too low | Verify connectivity and increase `REQUEST_TIMEOUT` (e.g. `10000`) |
| Docker can't resolve hostname | mDNS doesn't work in Docker | Use IP address, not `gaggimate.local` |
| Old brews missing chart image or Shot JSON | Image was uploaded too early (blank) or shot was captured while initializing | The hourly repair scan will detect and re-sync these automatically; force sooner by restarting the service (repair runs on startup) |
| Profile reconciler logs "3 saved/re-pushed" every cycle | Persistent field mismatch between Notion JSON and device profile | Check logs for `Profile reconciler: mismatch at ...` to identify the differing field; `targets: []` (empty array) is now automatically stripped and should not recur |
| Control panel shows "Device offline" | Bridge can't reach GaggiMate (same as `reachable: false` in /health) | Fix GAGGIMATE_HOST, network, or Docker routing; control panel uses the bridge to talk to the device |
| Can't change profiles on the GaggiMate — selection keeps reverting | Bridge overwrites device selection with Notion's Selected checkbox every 30s | Set `PROFILE_SYNC_SELECTED_TO_DEVICE=false` (default) so the device is the source of truth. Use the control panel or device UI to switch profiles. |
| Favorite changes in Notion do not apply to device | Favorite sync is opt-in | Set `PROFILE_SYNC_FAVORITE_TO_DEVICE=true` and restart |
| Device-created profiles never appear in Notion | Device-profile auto-import is disabled by default to reduce WS load | Set `PROFILE_IMPORT_UNMATCHED_DEVICE_PROFILES=true` and/or `IMPORT_MISSING_PROFILES_FROM_SHOTS=true` |
| Shots sync but missing profiles are not auto-imported during shot polling | Shot-priority mode disables inline profile import by default | Set `IMPORT_MISSING_PROFILES_FROM_SHOTS=true` if you want shot polling to fetch/import profiles from device |

---

## Profile JSON Format

The GaggiMate expects profiles in this exact structure:

For full validation rules (required fields, enums, ranges, and queued-only push behavior), see [`docs/mcp-json-validation.md`](mcp-json-validation.md).

```json
{
  "label": "AI Profile",
  "type": "pro",
  "temperature": 93,
  "phases": [
    {
      "name": "Preinfusion",
      "phase": "preinfusion",
      "duration": 10,
      "pump": {
        "target": "pressure",
        "pressure": 3
      },
      "transition": {
        "type": "linear",
        "duration": 2
      },
      "targets": [
        {
          "type": "pressure",
          "operator": "gte",
          "value": 4
        }
      ]
    },
    {
      "name": "Extraction",
      "phase": "brew",
      "duration": 30,
      "pump": {
        "target": "pressure",
        "pressure": 9
      }
    }
  ]
}
```

**Key constraints:**
- `temperature`: 60-100 (Celsius)
- `phases`: at least one phase required
- Each phase needs: `name`, `phase` ("preinfusion" or "brew"), `duration` (seconds)
- `pump.target`: "pressure" (bar) or "flow" (ml/s)
- `transition.type`: "instant", "linear", "ease-in", "ease-out", or "ease-in-out"
- `targets`: optional stop conditions (phase ends when any condition is met)
