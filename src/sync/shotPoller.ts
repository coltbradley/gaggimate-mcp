import type { GaggiMateClient } from "../gaggimate/client.js";
import type { ShotListItem } from "../parsers/binaryIndex.js";
import type { NotionClient } from "../notion/client.js";
import { SyncState } from "./state.js";
import { shotToBrewData } from "../notion/mappers.js";
import { transformShotForAI } from "../transformers/shotTransformer.js";
import { isConnectivityError, summarizeConnectivityError } from "../utils/connectivity.js";

interface ShotPollerOptions {
  intervalMs: number;
  dataDir: string;
  recentShotLookbackCount: number;
  brewTitleTimeZone: string;
  repairIntervalMs: number;
  importMissingProfilesFromShots?: boolean;
}

export class ShotPoller {
  private gaggimate: GaggiMateClient;
  private notion: NotionClient;
  private options: ShotPollerOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private connectivityWarningActive = false;
  // When set, poll() returns early until this timestamp passes (avoids hammering an
  // offline device every interval — resets as soon as the device responds again).
  private connectivityCooldownUntil = 0;
  private readonly CONNECTIVITY_COOLDOWN_MS = 3 * 60_000; // 3 minutes
  private state: SyncState;
  // Tracks shots confirmed fully synced (brew + chart + JSON) so lookback skips them.
  private fullySyncedShots = new Set<string>();
  // Timestamp anchor used by repair scheduling (0 = never run).
  private repairLastRun = 0;
  // How many past shots to scan for stale/missing data on each repair pass.
  private readonly REPAIR_WINDOW = 50;
  // Process stale-brew repairs in small chunks so one pass cannot starve shot ingest.
  private readonly REPAIR_BATCH_SIZE = 3;
  // When repair work remains, schedule the next chunk quickly instead of waiting full interval.
  private readonly REPAIR_CONTINUATION_DELAY_MS = 30_000;

  constructor(gaggimate: GaggiMateClient, notion: NotionClient, options: ShotPollerOptions) {
    this.gaggimate = gaggimate;
    this.notion = notion;
    this.options = options;
    this.state = SyncState.load(options.dataDir);
  }

  get syncState(): SyncState {
    return this.state;
  }

  start(): void {
    if (this.timer) return;
    console.log(`Shot poller started (every ${this.options.intervalMs}ms)`);
    this.timer = setInterval(() => this.poll(), this.options.intervalMs);
    // Run immediately on start
    this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("Shot poller stopped");
  }

  /**
   * Returns true when the Shot JSON stored in Notion was captured while the shot
   * had no samples yet (sample_count === 0), meaning both the JSON and the chart
   * SVG are essentially empty and need to be re-uploaded.
   */
  private isBrewJsonStale(jsonStr: string | null): boolean {
    if (!jsonStr || !jsonStr.trim()) return true;
    try {
      const parsed = JSON.parse(jsonStr);
      return (parsed?.metadata?.sample_count ?? 0) === 0;
    } catch {
      return true;
    }
  }

  /**
   * Periodic scan over the last REPAIR_WINDOW synced shots.
   * Re-uploads Shot JSON when it's stale (sample_count === 0) and re-uploads the
   * Brew Profile chart when it's missing from the Notion page.  Runs at most once
   * per repairIntervalMs (default 1 hour) so it won't interfere with normal polling.
   */
  private async repairStaleBrews(shots: ShotListItem[]): Promise<void> {
    const now = Date.now();
    if (this.options.repairIntervalMs <= 0 || now - this.repairLastRun < this.options.repairIntervalMs) return;

    const lastId = this.state.lastSyncedShotId ? parseInt(this.state.lastSyncedShotId, 10) : 0;
    if (lastId === 0) return;

    const lowerBound = Math.max(1, lastId - this.REPAIR_WINDOW + 1);
    const candidates = shots
      .filter((s) => {
        const id = parseInt(s.id, 10);
        return id >= lowerBound && id <= lastId && !s.incomplete && !this.fullySyncedShots.has(s.id);
      })
      .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));

    if (candidates.length === 0) {
      this.repairLastRun = now;
      return;
    }

    const batchCandidates = candidates.slice(0, this.REPAIR_BATCH_SIZE);
    const hasMoreCandidates = candidates.length > batchCandidates.length;

    let repairedCount = 0;
    let processedCount = 0;

    for (const shotListItem of batchCandidates) {
      processedCount += 1;
      try {
        const existing = await this.notion.findBrewByShotId(shotListItem.id);
        if (!existing) continue;

        // Check both JSON staleness and image presence in parallel.
        const [existingJson, imagePresent] = await Promise.all([
          this.notion.getBrewShotJson(existing),
          this.notion.imageUploadDisabled ? Promise.resolve(true) : this.notion.brewHasProfileImage(existing),
        ]);

        const shotJsonStale = this.isBrewJsonStale(existingJson);

        if (!shotJsonStale && imagePresent) {
          // Both are good — mark fully synced so lookback skips it.
          this.fullySyncedShots.add(shotListItem.id);
          continue;
        }

        const shotData = await this.gaggimate.fetchShot(shotListItem.id);
        if (!shotData || shotData.samples.length === 0) continue;

        const parts: string[] = [];

        if (shotJsonStale) {
          const transformed = transformShotForAI(shotData, true);
          const shotJsonStr = JSON.stringify(transformed);
          const brewData = shotToBrewData(shotData, transformed, {
            timeZone: this.options.brewTitleTimeZone,
          });
          await this.notion.updateBrewFromData(existing, brewData, shotJsonStr);
          parts.push("JSON");
        }

        if (!imagePresent && !this.notion.imageUploadDisabled) {
          const uploaded = await this.notion.uploadBrewChart(existing, shotListItem.id, shotData);
          if (uploaded) {
            parts.push("chart");
          }
        }

        if (parts.length > 0) {
          // Only mark fully synced when the image is confirmed present after this pass.
          const imageNowPresent = imagePresent || parts.includes("chart");
          if (imageNowPresent || this.notion.imageUploadDisabled) {
            this.fullySyncedShots.add(shotListItem.id);
          }
          repairedCount++;
          console.log(`Shot ${shotListItem.id}: repaired brew (${parts.join(" + ")} re-synced)`);
        }
      } catch (err) {
        console.warn(`Shot ${shotListItem.id}: repair failed`, err);
      }
    }

    if (hasMoreCandidates) {
      // Keep the normal large repair interval, but fast-forward the next chunk.
      this.repairLastRun = now - this.options.repairIntervalMs + this.REPAIR_CONTINUATION_DELAY_MS;
      console.log(
        `Repair scan: processed ${processedCount}/${candidates.length} shot(s); continuing in ${this.REPAIR_CONTINUATION_DELAY_MS}ms`,
      );
    } else {
      this.repairLastRun = now;
    }

    if (repairedCount > 0) {
      console.log(`Repair scan complete: fixed ${repairedCount} shot(s) with missing/stale data`);
    }
  }

  private warnConnectivityIssue(error: unknown): void {
    const summary = summarizeConnectivityError(error);
    if (!this.connectivityWarningActive) {
      console.warn(`Shot poller: GaggiMate unreachable (${summary}), will retry next interval`);
      this.connectivityWarningActive = true;
    }
    this.connectivityCooldownUntil = Date.now() + this.CONNECTIVITY_COOLDOWN_MS;
  }

  private clearConnectivityWarning(): void {
    if (this.connectivityWarningActive) {
      console.log("Shot poller: GaggiMate connectivity restored");
      this.connectivityWarningActive = false;
    }
    this.connectivityCooldownUntil = 0;
  }

  private async poll(): Promise<void> {
    // Prevent overlapping polls — log once per overlap event so slow polls are visible.
    if (this.running) {
      console.log("Shot poller: previous poll still in progress, skipping interval");
      return;
    }
    // Skip the poll body entirely while the device is in connectivity cooldown.
    if (Date.now() < this.connectivityCooldownUntil) {
      return;
    }
    const pollStartedAt = Date.now();
    let candidateCount = 0;
    let newShotCount = 0;
    let syncedCount = 0;
    let failedCount = 0;
    let skippedIncompleteCount = 0;
    let skippedFullySyncedCount = 0;
    this.running = true;

    try {
      const state = this.state;

      // Fetch shot history (sorted most recent first by indexToShotList)
      const shots = await this.gaggimate.fetchShotHistory();
      this.clearConnectivityWarning();
      if (shots.length === 0) {
        return;
      }

      // Parse IDs once for efficient filtering and sorting
      const lastId = state.lastSyncedShotId ? parseInt(state.lastSyncedShotId, 10) : 0;

      // Prune fullySyncedShots entries well outside the lookback window — they'll
      // never be revisited and there's no point holding them in memory indefinitely.
      const pruneBelow = lastId - this.options.recentShotLookbackCount * 3;
      if (pruneBelow > 0) {
        for (const id of this.fullySyncedShots) {
          if (parseInt(id, 10) < pruneBelow) {
            this.fullySyncedShots.delete(id);
          }
        }
      }

      const shotNumericIds = new Map<string, number>();
      for (const s of shots) {
        shotNumericIds.set(s.id, parseInt(s.id, 10));
      }
      const numId = (s: { id: string }) => shotNumericIds.get(s.id)!;

      // Find new shots: shots with ID > lastSyncedShotId
      const newShots = shots
        .filter((s) => numId(s) > lastId)
        .sort((a, b) => numId(a) - numId(b)); // Process oldest first

      // Revisit a small lookback window to hydrate/fix already-synced brews
      // that were first seen while the shot file was still settling.
      const recentLowerBound = Math.max(1, lastId - this.options.recentShotLookbackCount + 1);
      const recentShots = shots
        .filter((s) => {
          const id = numId(s);
          return id >= recentLowerBound && id <= lastId;
        })
        .sort((a, b) => numId(a) - numId(b));

      const candidateById = new Map<string, (typeof shots)[number]>();
      for (const shot of [...recentShots, ...newShots]) {
        candidateById.set(shot.id, shot);
      }
      const candidateShots = Array.from(candidateById.values())
        .sort((a, b) => numId(a) - numId(b));
      candidateCount = candidateShots.length;
      newShotCount = newShots.length;
      let connectivityInterrupted = false;

      if (candidateShots.length === 0) {
        await this.repairStaleBrews(shots);
        return;
      }
      const newestCandidateId = numId(candidateShots[candidateShots.length - 1]);

      if (newShots.length > 0) {
        console.log(`Found ${newShots.length} new shot(s) to sync`);
      }
      const syncedIds: string[] = [];
      let contiguousLastSyncedId = lastId;
      const syncedButBlockedByGap = new Set<number>();
      const skippedButBlockedByGap = new Set<number>();
      const tryAdvanceContiguousCursor = () => {
        while (true) {
          const nextId = contiguousLastSyncedId + 1;
          if (syncedButBlockedByGap.has(nextId)) {
            syncedButBlockedByGap.delete(nextId);
            contiguousLastSyncedId = nextId;
            const advancedId = String(nextId);
            state.recordSync(advancedId);
            syncedIds.push(advancedId);
            continue;
          }

          if (skippedButBlockedByGap.has(nextId)) {
            skippedButBlockedByGap.delete(nextId);
            contiguousLastSyncedId = nextId;
            state.lastSyncedShotId = String(nextId);
            state.lastSyncTime = new Date().toISOString();
            state.save();
            continue;
          }

          break;
        }
      };

      for (const shotListItem of candidateShots) {
        try {
          const isNewShot = numId(shotListItem) > lastId;

          // Skip lookback shots already confirmed fully synced — avoids ~6 API calls per shot
          // per poll once there's nothing left to do.
          if (!isNewShot && this.fullySyncedShots.has(shotListItem.id)) {
            skippedFullySyncedCount += 1;
            continue;
          }

          // The index entry carries an authoritative SHOT_FLAG_COMPLETED flag set by the
          // device only after the .slog file is fully written.  Check this first so we
          // never fetch the shot file (or create a Notion brew) for an in-progress shot.
          // This is more reliable than inspecting sampleCount in the binary header, which
          // can read as 0 (i.e. "complete") if the device initialises the header before
          // any samples have been flushed.
          if (isNewShot && shotListItem.incomplete) {
            if (numId(shotListItem) === newestCandidateId) {
              console.log(`Shot ${shotListItem.id}: still recording, waiting for next poll`);
              break;
            }
            // If a non-newest shot stays incomplete forever (e.g. aborted write), don't
            // block newer completed shots behind it.
            console.warn(`Shot ${shotListItem.id}: stale incomplete index entry, skipping`);
            skippedIncompleteCount += 1;
            skippedButBlockedByGap.add(numId(shotListItem));
            tryAdvanceContiguousCursor();
            continue;
          }

          // Fetch shot data and check for existing Notion brew in parallel —
          // they hit different services (GaggiMate HTTP vs Notion API).
          const [shotData, existing] = await Promise.all([
            this.gaggimate.fetchShot(shotListItem.id),
            this.notion.findBrewByShotId(shotListItem.id),
          ]);

          if (!shotData) {
            console.warn(`Shot ${shotListItem.id}: not found on GaggiMate, skipping`);
            continue;
          }

          // Secondary guard: catch file-level truncation even if the index flag has
          // not yet updated (rare, but possible with concurrent writes).
          if (isNewShot && shotData.incomplete) {
            if (numId(shotListItem) === newestCandidateId) {
              console.log(`Shot ${shotListItem.id}: file incomplete, waiting for next poll before syncing`);
              break;
            }
            console.warn(`Shot ${shotListItem.id}: stale incomplete shot file, skipping`);
            skippedIncompleteCount += 1;
            skippedButBlockedByGap.add(numId(shotListItem));
            tryAdvanceContiguousCursor();
            continue;
          }

          // Transform to AI-friendly format (full_curve for Shot JSON)
          const transformed = transformShotForAI(shotData, true);
          const shotJsonStr = JSON.stringify(transformed);

          // Map to brew data and create in Notion
          const brewData = shotToBrewData(shotData, transformed, {
            timeZone: this.options.brewTitleTimeZone,
          });

          // If the shot references a profile that doesn't exist in Notion yet,
          // import only the matching device profile as Draft so the brew relation can link.
          if (this.options.importMissingProfilesFromShots === true && brewData.profileName) {
            const profileExists = await this.notion.hasProfileByName(brewData.profileName);
            if (!profileExists) {
              const machineProfiles = await this.gaggimate.fetchProfiles();
              const requestedName = this.notion.normalizeProfileName(brewData.profileName);
              const matchingProfile = machineProfiles.find((machineProfile: any) => {
                if (typeof machineProfile?.label !== "string") return false;
                return this.notion.normalizeProfileName(machineProfile.label) === requestedName;
              });

              if (matchingProfile) {
                const profileStillMissing = !(await this.notion.hasProfileByName(brewData.profileName));
                if (profileStillMissing) {
                  const importedPageId = await this.notion.createDraftProfile(matchingProfile);
                  // Non-blocking: image upload (SVG render + 3 API calls) should not delay brew sync.
                  // The profile reconciler will also restore missing images on its next cycle.
                  this.notion.uploadProfileImage(
                    importedPageId,
                    matchingProfile.label,
                    matchingProfile,
                    JSON.stringify(matchingProfile),
                  ).catch((err) => console.warn(`Shot ${shotListItem.id}: profile image upload failed`, err));
                  console.log(`Shot ${shotListItem.id}: imported profile "${brewData.profileName}" as Draft`);
                }
              }
            }
          }

          // Shot JSON is folded into create/update to save a separate API round-trip.
          let pageId: string;
          let hasImageResult: PromiseSettledResult<boolean>;

          if (existing) {
            // Run brew update (including Shot JSON) and image-presence check in parallel —
            // they write/read different page properties so they are safe to interleave.
            // Skip the image check entirely when uploads are disabled to avoid a wasted read.
            const imageCheckPromise = this.notion.imageUploadDisabled
              ? Promise.resolve(false)
              : this.notion.brewHasProfileImage(existing);
            const [updateResult, imageResult] = await Promise.allSettled([
              this.notion.updateBrewFromData(existing, brewData, shotJsonStr),
              imageCheckPromise,
            ]);
            if (updateResult.status === "rejected") {
              throw updateResult.reason;
            }
            pageId = existing;
            hasImageResult = imageResult;
            if (isNewShot) {
              console.log(`Shot ${shotListItem.id}: updated existing Notion brew as "${brewData.title}"`);
            }
          } else {
            // Shot JSON included in the create call — no separate update needed.
            // Brand-new pages have no chart image, so skip the image-presence read.
            pageId = await this.notion.createBrew(brewData, shotJsonStr);
            console.log(`Shot ${shotListItem.id}: synced to Notion as "${brewData.title}"`);
            hasImageResult = { status: "fulfilled", value: false };
          }

          if (isNewShot) {
            syncedButBlockedByGap.add(numId(shotListItem));
            tryAdvanceContiguousCursor();
          }

          const imagePresent = hasImageResult.status === "fulfilled" && hasImageResult.value;
          if (!imagePresent) {
            if (this.notion.imageUploadDisabled) {
              // Uploads permanently disabled — mark fully synced to avoid repeated lookback retries.
              this.fullySyncedShots.add(shotListItem.id);
            } else {
              try {
                const uploaded = await this.notion.uploadBrewChart(pageId, shotListItem.id, shotData);
                if (uploaded) {
                  console.log(`Shot ${shotListItem.id}: uploaded Brew Profile chart`);
                  this.fullySyncedShots.add(shotListItem.id);
                }
              } catch (error) {
                console.warn(`Shot ${shotListItem.id}: failed to upload Brew Profile chart`, error);
              }
            }
          } else {
            // Chart already present — this shot is fully synced, skip it in future lookback passes.
            this.fullySyncedShots.add(shotListItem.id);
          }
        } catch (error) {
          if (isConnectivityError(error)) {
            this.warnConnectivityIssue(error);
            connectivityInterrupted = true;
            break;
          }
          // Per-shot failure isolation — log and continue
          console.error(`Shot ${shotListItem.id}: sync failed:`, error);
          failedCount += 1;
        }
      }

      syncedCount = syncedIds.length;
      if (syncedIds.length > 0) {
        console.log(`Synced ${syncedIds.length} new shot(s) (IDs: ${syncedIds.join(", ")})`);
      }

      // Run stale-brew repairs after ingest work so new shots are never blocked by
      // large repair windows. Repair itself is batched in repairStaleBrews().
      if (!connectivityInterrupted) {
        await this.repairStaleBrews(shots);
      }
    } catch (error) {
      // Top-level failure — GaggiMate unreachable or other fatal error
      if (isConnectivityError(error)) {
        this.warnConnectivityIssue(error);
      } else {
        console.error("Shot poller error:", error);
      }
    } finally {
      if (
        candidateCount > 0 ||
        newShotCount > 0 ||
        syncedCount > 0 ||
        failedCount > 0 ||
        skippedIncompleteCount > 0 ||
        skippedFullySyncedCount > 0
      ) {
        const durationMs = Date.now() - pollStartedAt;
        console.log(
          `Shot poller: cycle summary candidates=${candidateCount} new=${newShotCount} synced=${syncedCount} ` +
            `failed=${failedCount} skippedIncomplete=${skippedIncompleteCount} skippedLookback=${skippedFullySyncedCount} ` +
            `durationMs=${durationMs}`,
        );
      }
      this.running = false;
    }
  }
}
