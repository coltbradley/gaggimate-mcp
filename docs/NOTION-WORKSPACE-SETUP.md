# Notion Workspace Setup and AI Operating Guide

Use this as a single source of truth for your Notion workspace. You can paste this document into a Notion page as-is.

For deployment steps (Docker/TrueNAS, environment variables, health checks), use `docs/SETUP.md`.

## 1. How to Create the Databases

Create three databases in Notion:
- `Beans`
- `Brews`
- `Profiles`

The database titles can vary, but property names and types below should match exactly.

### Beans Database

| Property | Type | Required | Notes |
|---|---|---|---|
| Bean Name | Title | Yes | Free-form bean name |
| Roaster | Select | No | Roaster name |
| Origin | Select | No | Country/region |
| Process | Select | No | Natural, Washed, Honey, etc. |
| Roast Level | Select | No | Light, Medium, Dark, etc. |
| Roast Date | Date | No | Roast date |
| Open Date | Date | No | Bag open date |
| Days Since Roast | Formula | No | `dateBetween(now(), prop("Roast Date"), "days")` |
| Bag Size | Number | No | grams |
| Price | Number | No | currency |
| Tasting Notes | Text | No | free-form |
| Buy Again | Checkbox | No | favorite/reorder flag |
| Purchase URL | URL | No | optional |
| Brews | Relation -> Brews | No | two-way relation |
| Notes | Text | No | optional |

### Brews Database

| Property | Type | Required | Notes |
|---|---|---|---|
| Brew | Title | Yes | Auto title, e.g. `#047 - Feb 14 AM` |
| Activity ID | Text | Yes | GaggiMate shot ID (dedup key) |
| Date | Date (with time) | Yes | Shot timestamp |
| Beans | Relation -> Beans | No | two-way relation |
| Profile | Relation -> Profiles | No | two-way relation |
| Grind Setting | Number | No | user-managed |
| Dose In | Number | No | user-managed (grams in) |
| Yield Out | Number | No | bridge-written (grams out from scale) |
| Ratio | Formula | No | `prop("Yield Out") / prop("Dose In")` |
| Brew Time | Number | No | bridge-written (seconds) |
| Brew Temp | Number | No | bridge-written (°C average) |
| Pre-infusion Time | Number | No | bridge-written (seconds) |
| Peak Pressure | Number | No | bridge-written (bar) |
| Total Volume | Number | No | bridge-written (mL) |
| Bean Age | Formula | No | depends on Bean relation |
| Taste Notes | Text | No | user-managed |
| Channeling | Checkbox | No | user-managed |
| Source | Select | No | bridge-written (`Auto` or `Manual`) |
| Shot JSON | Text | No | bridge-written (full transformed shot data) |
| Brew Profile | Files | No | bridge-written (brew chart SVG) |
| Notes | Text | No | user-managed |

### Profiles Database

| Property | Type | Required | Notes |
|---|---|---|---|
| Profile Name | Title | Yes | human-readable name |
| Description | Text | No | user/AI description |
| Profile Type | Select | No | Flat, Declining, Blooming, Lever, Turbo, Custom |
| Best For | Multi-select | No | roast/use tags |
| Source | Select | No | Stock, Community, AI-Generated, Custom |
| Active on Machine | Checkbox | Yes | bridge-maintained state |
| Favorite | Checkbox | Yes | sync target for favorite state (`PROFILE_SYNC_FAVORITE_TO_DEVICE=true`) |
| Selected | Checkbox | Yes | sync target for selected profile (`PROFILE_SYNC_SELECTED_TO_DEVICE=true`, select-on-check behavior) |
| Profile Image | Files | No | chart image |
| Profile JSON | Text | Yes | canonical machine profile JSON |
| Push Status | Select | Yes | `Draft`, `Queued`, `Pushed`, `Archived`, `Failed` |
| Last Pushed | Date (with time) | No | bridge writeback |
| Brews | Relation -> Brews | No | two-way relation |
| Notes | Text | No | optional |

Required exact checkbox names:
- `Favorite`
- `Selected`

### Name and Character Rules (Important)

These rules reduce encoding/matching issues between Notion and GaggiMate:

- Prefer plain ASCII in `Profile Name` and JSON `label` when possible.
- Use `-` (hyphen-minus) instead of smart punctuation (`—`, `–`) if you want maximum compatibility with device UI.
- Avoid emojis and unusual symbols in profile labels.
- Keep labels consistent between Notion `Profile Name` and JSON `label`.
- Keep one managed Notion row per device profile `id` (avoid duplicate `Queued`/`Pushed`/`Archived` rows with the same `id`).

Note: the bridge now includes mojibake repair for common corrupted UTF-8 sequences (for example `â`), but clean naming still works best.

## 2. How the Databases Should Work Together

### Relations

- `Beans` <-> `Brews`: what beans were used for a shot.
- `Profiles` <-> `Brews`: what pressure profile was used for a shot.

### Profile Lifecycle

- `Draft`: authoring state, no machine operation.
- `Queued`: ready to push now.
- `Pushed`: managed on device; Notion JSON is authoritative.
- `Archived`: should be removed from device (except utility profiles like `flush`/`descale`).
- `Failed`: last push/delete failed; needs attention.

### Ownership Model

Bridge-managed fields in `Profiles`:
- `Push Status`
- `Last Pushed`
- `Active on Machine`
- `Profile JSON` `id` writeback on first successful push
- `Favorite`/`Selected` sync execution to device (Notion -> device, opt-in via env flags)

User/AI-managed fields in `Profiles`:
- `Profile Name`
- `Description`
- `Profile Type`
- `Best For`
- `Source`
- `Profile JSON` content (except bridge writeback of `id`)
- `Notes`

### Reconcile Rules

- If a `Pushed` profile differs from device, bridge pushes Notion JSON to device.
- Device-only profiles can be imported as `Draft` when import flags are enabled (`PROFILE_IMPORT_UNMATCHED_DEVICE_PROFILES` and/or `IMPORT_MISSING_PROFILES_FROM_SHOTS`).
- Webhook updates for `Queued` push immediately.
- Webhook updates for `Pushed` apply `Favorite`/`Selected` only when `PROFILE_SYNC_FAVORITE_TO_DEVICE` / `PROFILE_SYNC_SELECTED_TO_DEVICE` are enabled.
- `Selected` behavior is "select when checked"; unchecking does not send a deselect command.
- Archived non-utility profiles are deleted from device.
- Destructive delete behavior can be disabled with `PROFILE_RECONCILE_DELETE_ENABLED=false`.
- Deletes are rate-limited per cycle by `PROFILE_RECONCILE_DELETE_LIMIT_PER_RUN` (default `3`) as a safety guard.
- Push/re-push operations are rate-limited per cycle by `PROFILE_RECONCILE_SAVE_LIMIT_PER_RUN` (default `5`) to avoid device overload.
- Utility profiles are never auto-deleted.

## 3. Basic Instructions for the Notion AI Agent

Paste this block into your Notion AI instructions or agent notes:

```text
You manage espresso profiles in the Profiles database.

Primary rules:
1) Never create duplicate managed profile rows for the same JSON id.
2) Only set Push Status to Queued when Profile JSON is complete and valid.
3) For existing profiles, preserve the existing JSON id field.
4) Keep Profile Name and JSON label aligned.
5) Prefer ASCII-safe punctuation in labels (use "-" instead of "—").

When creating or editing Profile JSON:
- temperature must be a number between 60 and 100
- phases must be a non-empty array with at most 20 entries
- each phase needs: name, phase ("preinfusion" or "brew"), duration
- omit targets entirely or provide real stop conditions — empty targets arrays (targets: []) are equivalent to omitting the field

Operational behavior:
- Use Draft while editing.
- Set Queued only when ready to push.
- If a profile should be removed from the machine, set Push Status to Archived.
- Use Favorite and Selected checkboxes to set machine favorite/active state for pushed profiles.

Do not:
- overwrite unrelated properties
- clear JSON id on an existing profile
- set multiple managed rows to the same JSON id
- repeatedly toggle `Push Status` between states in automation loops
```

### AI Agent Quick Workflow

1. Create/edit row in `Draft`.
2. Validate JSON shape and ranges.
3. Ensure name/label consistency.
4. Set `Push Status = Queued`.
5. Confirm bridge moves it to `Pushed`.

## 4. Operational Flags and Webhook Security

These `.env` flags control how Notion changes affect the machine:
- `PROFILE_SYNC_SELECTED_TO_DEVICE=false` (default): device/profile UI controls selection; Notion does not override.
- `PROFILE_SYNC_FAVORITE_TO_DEVICE=false` (default): Notion favorites do not override machine favorites.
- `PROFILE_IMPORT_UNMATCHED_DEVICE_PROFILES=false` (default): no periodic import of device-only profiles.
- `IMPORT_MISSING_PROFILES_FROM_SHOTS=false` (default): shot sync does not fetch profiles for inline import.

Webhook security:
- Set `WEBHOOK_SECRET` to Notion's raw webhook verification token.
- Do not use the `x-notion-signature` value (`sha256=...`) as `WEBHOOK_SECRET`.
