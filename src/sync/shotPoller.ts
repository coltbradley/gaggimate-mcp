import type { GaggiMateClient } from "../gaggimate/client.js";
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
}

export class ShotPoller {
  private gaggimate: GaggiMateClient;
  private notion: NotionClient;
  private options: ShotPollerOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private connectivityWarningActive = false;
  private state: SyncState;
  // Tracks shots confirmed fully synced (brew + chart + JSON) so lookback skips them.
  private fullySyncedShots = new Set<string>();

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

  private warnConnectivityIssue(error: unknown): void {
    const summary = summarizeConnectivityError(error);
    if (!this.connectivityWarningActive) {
      console.warn(`Shot poller: GaggiMate unreachable (${summary}), will retry next interval`);
      this.connectivityWarningActive = true;
    }
  }

  private clearConnectivityWarning(): void {
    if (this.connectivityWarningActive) {
      console.log("Shot poller: GaggiMate connectivity restored");
      this.connectivityWarningActive = false;
    }
  }

  private async poll(): Promise<void> {
    // Prevent overlapping polls — log once per overlap event so slow polls are visible.
    if (this.running) {
      console.log("Shot poller: previous poll still in progress, skipping interval");
      return;
    }
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

      if (candidateShots.length === 0) {
        return;
      }

      if (newShots.length > 0) {
        console.log(`Found ${newShots.length} new shot(s) to sync`);
      }
      const syncedIds: string[] = [];

      for (const shotListItem of candidateShots) {
        try {
          const isNewShot = numId(shotListItem) > lastId;

          // Skip lookback shots already confirmed fully synced — avoids ~6 API calls per shot
          // per poll once there's nothing left to do.
          if (!isNewShot && this.fullySyncedShots.has(shotListItem.id)) {
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

          // If shot file is still being written, retry on next interval.
          // Do not advance sync state past this shot ID yet.
          if (isNewShot && shotData.incomplete) {
            console.log(`Shot ${shotListItem.id}: file incomplete, waiting for next poll before syncing`);
            break;
          }

          // Transform to AI-friendly format (full_curve for Shot JSON)
          const transformed = transformShotForAI(shotData, true);

          // Map to brew data and create in Notion
          const brewData = shotToBrewData(shotData, transformed, {
            timeZone: this.options.brewTitleTimeZone,
          });

          // If the shot references a profile that doesn't exist in Notion yet,
          // import only the matching device profile as Draft so the brew relation can link.
          if (brewData.profileName) {
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

          let pageId: string;
          if (existing) {
            await this.notion.updateBrewFromData(existing, brewData);
            pageId = existing;
            if (isNewShot) {
              state.recordSync(shotListItem.id);
              syncedIds.push(shotListItem.id);
              console.log(`Shot ${shotListItem.id}: updated existing Notion brew as "${brewData.title}"`);
            }
          } else {
            pageId = await this.notion.createBrew(brewData);
            if (isNewShot) {
              state.recordSync(shotListItem.id);
              syncedIds.push(shotListItem.id);
            }
            console.log(`Shot ${shotListItem.id}: synced to Notion as "${brewData.title}"`);
          }

          // Enrich brew: write Shot JSON and check/upload chart in parallel.
          // setBrewShotJson writes "Shot JSON" property; brewHasProfileImage reads
          // "Brew Profile" files — different properties, safe to run concurrently.
          const [shotJsonResult, hasImage] = await Promise.allSettled([
            this.notion.setBrewShotJson(pageId, JSON.stringify(transformed)),
            this.notion.brewHasProfileImage(pageId),
          ]);

          if (shotJsonResult.status === "rejected") {
            console.warn(`Shot ${shotListItem.id}: failed to set Shot JSON`, shotJsonResult.reason);
          }

          const imagePresent = hasImage.status === "fulfilled" && hasImage.value;
          if (!imagePresent) {
            try {
              const uploaded = await this.notion.uploadBrewChart(pageId, shotListItem.id, shotData);
              if (uploaded) {
                console.log(`Shot ${shotListItem.id}: uploaded Brew Profile chart`);
                this.fullySyncedShots.add(shotListItem.id);
              }
            } catch (error) {
              console.warn(`Shot ${shotListItem.id}: failed to upload Brew Profile chart`, error);
            }
          } else {
            // Chart already present — this shot is fully synced, skip it in future lookback passes.
            this.fullySyncedShots.add(shotListItem.id);
          }
        } catch (error) {
          if (isConnectivityError(error)) {
            this.warnConnectivityIssue(error);
            break;
          }
          // Per-shot failure isolation — log and continue
          console.error(`Shot ${shotListItem.id}: sync failed:`, error);
        }
      }

      if (syncedIds.length > 0) {
        console.log(`Synced ${syncedIds.length} new shot(s) (IDs: ${syncedIds.join(", ")})`);
      }
    } catch (error) {
      // Top-level failure — GaggiMate unreachable or other fatal error
      if (isConnectivityError(error)) {
        this.warnConnectivityIssue(error);
      } else {
        console.error("Shot poller error:", error);
      }
    } finally {
      this.running = false;
    }
  }
}
