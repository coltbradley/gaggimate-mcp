# Profile Reconciliation Implementation Plan

> **Completed.** All steps in this plan have been implemented. This document is a historical record. The live behavior is described in `mcp-json-validation.md` and `NOTION-WORKSPACE-SETUP.md`.
>
> **Post-implementation fix (Feb 2026):** A persistent re-push loop was discovered where all profiles were re-pushed every 30s reconcile cycle. Root cause: Notion JSON stored `targets: []` (empty array) in phases, but the GaggiMate device omits empty arrays entirely, so `areProfilesEquivalent` always returned false. Fixed in `normalizeProfileForGaggiMate`: empty `targets` arrays are now stripped before any comparison or device write. The equivalence check also logs the first mismatching field path when a drift is detected, to aid future diagnosis.

## Verification Summary

The overall direction is correct and should resolve the current overwrite race:

- Replace `ProfilePoller` + `ProfileImportPoller` with one reconciler loop.
- Treat Notion as source of truth for bridge-managed profiles.
- Keep device UI usable by importing device-only profiles as Notion `Draft`.

The plan is valid with four required adjustments:

1. Avoid string-equality JSON compare (`JSON.stringify`) for drift detection; use semantic compare to prevent constant re-push loops from key ordering.
2. In `Pushed` handling, apply JSON reconciliation before `favorite/selected` sync so save operations do not undo checkbox intent.
3. Track matched device profiles by both `id` and normalized `label` to prevent duplicate Draft imports when ID is missing in Notion JSON.
4. Add automated tests for status transitions and id write-back behavior; manual checks alone are not enough for this refactor.

## Target Behavior

Push Status semantics:

- `Draft`: exists in Notion only; no device action.
- `Queued`: push Notion JSON to device; set `Pushed`.
- `Pushed`: ensure profile exists on device; Notion JSON wins on drift.
- `Archived`: ensure profile is removed from device (except utility profiles).
- `Failed`: no automated action.

Property sync:

- Notion `Favorite` checkbox -> device favorite state.
- Notion `Selected` checkbox -> active device profile.
- `Active on Machine` is maintained by bridge operations.

## Implementation Steps

### 1) Extend GaggiMate Client API

File: `src/gaggimate/client.ts`

- Add `deleteProfile(profileId: string): Promise<void>`
- Add `selectProfile(profileId: string): Promise<void>`
- Add `favoriteProfile(profileId: string, favorite: boolean): Promise<void>`

Implementation pattern:

- Reuse `saveProfile()` websocket request/timeout/cleanup structure.
- Match on response type and reject on `response.error`.
- Resolve `void` for success.

### 2) Update Notion Client Surface

File: `src/notion/client.ts`

- Extend `ExistingProfileRecord` with:
  - `favorite: boolean`
  - `selected: boolean`
- Make `listExistingProfiles()` callable by reconciler and include checkbox extraction.
- Extend `updatePushStatus(pageId, status, timestamp?, activeOnMachine?)`.
- Add `createDraftProfile(profile): Promise<string>`.
- Add `updateProfileJson(pageId, jsonString): Promise<void>`.
- Remove `importProfilesFromGaggiMate()` after reconciler is wired.

Implementation notes:

- `createDraftProfile` should set `Push Status = Draft`, `Active on Machine = true`, `Favorite`, `Selected`.
- Keep utility helpers private where possible; only expose helpers that are truly needed cross-class.

### 3) Add `ProfileReconciler`

New file: `src/sync/profileReconciler.ts`

Runtime model:

- Same poller skeleton as `ShotPoller`: interval + immediate run + overlap guard.
- Exit gracefully on GaggiMate timeout/unreachable; retry next interval.

Loop phases:

1. Fetch device profiles and Notion profile index.
2. Process every Notion profile by status:
   - `Queued`: validate JSON, save to device, write back assigned ID if missing, set `Pushed` + `Active on Machine = true`.
   - `Pushed`: if missing on device, re-push from Notion; if present and drifted, re-push Notion JSON; then sync favorite/selected.
   - `Archived`: delete from device if present and not utility; set `Active on Machine = false`.
   - `Draft`/`Failed`: no device action.
3. Import unmatched device profiles as `Draft`.
4. Backfill brew-profile relations (carry forward existing logic).

Required guardrails:

- Match tracking by both ID and normalized name.
- Drift detection via semantic compare (deep-equal on parsed JSON), not raw string compare.
- Per-profile error isolation so one failure does not stop the cycle.

### 4) Align Webhook Push Path

File: `src/sync/profilePush.ts`

- Remove `AI Profile` special handling; always call `saveProfile()`.
- Capture returned profile and write back assigned ID when missing.
- Set `Active on Machine = true` on success via updated `updatePushStatus`.

### 5) Update Shot Poller Import Behavior

File: `src/sync/shotPoller.ts`

- Replace bulk `importProfilesFromGaggiMate()` call with targeted single-profile Draft import.
- Match by normalized label, not exact case/whitespace.
- After create, optionally upload profile image for parity.

### 6) Config and Bootstrap

File: `src/config.ts`

- Remove:
  - `pollingFallback`
  - `profilePollIntervalMs`
  - `profileImportEnabled`
  - `profileImportIntervalMs`
- Add:
  - `profileReconcileEnabled` (default `true`)
  - `profileReconcileIntervalMs` (default `30000`)

File: `src/index.ts`

- Replace `ProfilePoller` + `ProfileImportPoller` with `ProfileReconciler`.
- Update startup logging and shutdown cleanup.

### 7) Delete Legacy Pollers

- Delete `src/sync/profilePoller.ts`
- Delete `src/sync/profileImportPoller.ts`

### 8) Environment Template

File: `.env.example`

- Replace old profile polling vars with:
  - `PROFILE_RECONCILE_ENABLED=true`
  - `PROFILE_RECONCILE_INTERVAL_MS=30000`
  - `PROFILE_RECONCILE_DELETE_ENABLED=true`
  - `PROFILE_RECONCILE_DELETE_LIMIT_PER_RUN=3`
  - `PROFILE_RECONCILE_SAVE_LIMIT_PER_RUN=5`

## Test Plan

### Automated

1. `npm run build`
2. Add/extend tests:
   - `profilePush` writes back assigned ID.
   - `ProfileReconciler` transitions:
     - `Queued -> Pushed`
     - `Pushed` missing on device -> re-push
     - `Archived` -> delete (non-utility) / skip (utility)
     - unmatched device profile -> Draft import
   - favorite/selected sync direction (Notion -> device).

### Manual

1. Add `Favorite` and `Selected` properties to Notion Profiles DB.
2. Start service and verify `GET /health`.
3. Validate scenarios:
   - Notion JSON edits are not overwritten by device import loop.
   - `Queued` pushes to device.
   - `Archived` removes profile from device.
   - Device-created profile appears as Notion `Draft`.
   - `Favorite` and `Selected` checkboxes drive device state.

## Rollout Order

1. Land API/client and Notion client changes.
2. Land reconciler behind `PROFILE_RECONCILE_ENABLED`.
3. Run both compile + tests.
4. Enable reconciler in non-prod first.
5. Remove legacy pollers in final cleanup commit.
