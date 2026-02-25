import type { GaggiMateClient } from "../gaggimate/client.js";
import type { ExistingProfileRecord, NotionClient } from "../notion/client.js";
import { normalizeProfileForGaggiMate } from "../gaggimate/profileNormalization.js";
import { isConnectivityError, summarizeConnectivityError } from "../utils/connectivity.js";
import { repairMojibake } from "../utils/text.js";

interface ProfileReconcilerOptions {
  intervalMs: number;
  deleteEnabled: boolean;
  maxDeletesPerRun: number;
  maxSavesPerRun: number;
}

export class ProfileReconciler {
  private gaggimate: GaggiMateClient;
  private notion: NotionClient;
  private options: ProfileReconcilerOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private deletedThisRun = 0;
  private deleteLimitWarned = false;
  private savedThisRun = 0;
  private saveLimitWarned = false;
  private connectivityWarningActive = false;
  // When set, reconcile() returns early until this timestamp passes so we don't
  // hammer an offline device on every interval.
  private connectivityCooldownUntil = 0;
  private readonly CONNECTIVITY_COOLDOWN_MS = 3 * 60_000; // 3 minutes
  // Cooldown: skip backfill until this timestamp to avoid hammering Notion/GaggiMate
  // when there's nothing to link or brews are persistently unresolvable.
  private backfillSkipUntil = 0;

  constructor(gaggimate: GaggiMateClient, notion: NotionClient, options: ProfileReconcilerOptions) {
    this.gaggimate = gaggimate;
    this.notion = notion;
    this.options = options;
  }

  start(): void {
    if (this.timer) return;
    console.log(`Profile reconciler started (every ${this.options.intervalMs}ms)`);
    this.timer = setInterval(() => this.reconcile(), this.options.intervalMs);
    this.reconcile();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("Profile reconciler stopped");
  }

  private async reconcile(): Promise<void> {
    if (this.running) return;
    if (Date.now() < this.connectivityCooldownUntil) return;
    this.running = true;
    this.deletedThisRun = 0;
    this.deleteLimitWarned = false;
    this.savedThisRun = 0;
    this.saveLimitWarned = false;

    try {
      // Fetch device profiles and Notion profiles in parallel — they hit different services.
      const [profilesResult, notionResult] = await Promise.allSettled([
        this.gaggimate.fetchProfiles(),
        this.notion.listExistingProfiles(),
      ]);

      if (profilesResult.status === "rejected") {
        const error = profilesResult.reason;
        if (isConnectivityError(error)) {
          const summary = summarizeConnectivityError(error);
          if (!this.connectivityWarningActive) {
            console.warn(`Profile reconciler: GaggiMate unreachable (${summary}), will retry next interval`);
            this.connectivityWarningActive = true;
          }
          this.connectivityCooldownUntil = Date.now() + this.CONNECTIVITY_COOLDOWN_MS;
        } else {
          console.error("Profile reconciler: failed to fetch device profiles:", error);
        }
        return;
      }

      const deviceProfiles: any[] = profilesResult.value;
      if (this.connectivityWarningActive) {
        console.log("Profile reconciler: GaggiMate connectivity restored");
        this.connectivityWarningActive = false;
        this.connectivityCooldownUntil = 0;
      }

      if (notionResult.status === "rejected") {
        throw notionResult.reason;
      }
      const notionIndex = notionResult.value;
      const deviceById = new Map<string, any>();
      for (const deviceProfile of deviceProfiles) {
        const profileId = this.notion.extractProfileId(deviceProfile);
        if (profileId) {
          deviceById.set(profileId, deviceProfile);
        }
      }

      const knownNotionNames = new Set<string>(
        notionIndex.all
          .map((record) => record.normalizedName)
          .filter((name) => name.length > 0),
      );

      const matchedDeviceIds = new Set<string>();
      const matchedDeviceNames = new Set<string>();
      const conflictingManagedIds = this.findConflictingManagedIds(notionIndex.all);
      const warnedConflictingIds = new Set<string>();

      for (const notionProfile of notionIndex.all) {
        if (notionProfile.profileId) {
          matchedDeviceIds.add(notionProfile.profileId);
        }
        if (notionProfile.normalizedName) {
          matchedDeviceNames.add(notionProfile.normalizedName);
        }

        if (
          notionProfile.profileId &&
          conflictingManagedIds.has(notionProfile.profileId) &&
          this.isManagedStatus(notionProfile.pushStatus)
        ) {
          if (!warnedConflictingIds.has(notionProfile.profileId)) {
            console.warn(
              `Profile reconciler: conflicting managed records share device id ${notionProfile.profileId}; skipping device operations until resolved in Notion`,
            );
            warnedConflictingIds.add(notionProfile.profileId);
          }
          continue;
        }

        try {
          await this.processNotionProfile(notionProfile, deviceById, matchedDeviceIds, matchedDeviceNames);
        } catch (error) {
          console.error(`Profile reconciler: failed to process page ${notionProfile.pageId}:`, error);
        }
      }

      for (const deviceProfile of deviceProfiles) {
        const deviceId = this.notion.extractProfileId(deviceProfile);
        const normalizedName = this.normalizeDeviceProfileName(deviceProfile);

        if (deviceId && matchedDeviceIds.has(deviceId)) {
          continue;
        }
        if (normalizedName && (matchedDeviceNames.has(normalizedName) || knownNotionNames.has(normalizedName))) {
          continue;
        }
        if (!normalizedName) {
          continue;
        }

        const profileName = this.profileLabel(deviceProfile);
        if (!profileName) {
          continue;
        }

        try {
          const pageId = await this.notion.createDraftProfile(deviceProfile);
          if (deviceId) {
            matchedDeviceIds.add(deviceId);
          }
          matchedDeviceNames.add(normalizedName);
          knownNotionNames.add(normalizedName);

          await this.notion.uploadProfileImage(pageId, profileName, deviceProfile, JSON.stringify(deviceProfile));
          console.log(`Profile reconciler: imported device profile "${profileName}" as Draft`);
        } catch (error) {
          console.error(`Profile reconciler: failed to import profile "${profileName}" as Draft:`, error);
        }
      }

      // Build a normalized-name → pageId map from the already-fetched profile index
      // so backfill can resolve profile names without making additional Notion queries.
      const profileNameToPageId = new Map<string, string>();
      for (const record of notionIndex.all) {
        if (record.normalizedName) {
          profileNameToPageId.set(record.normalizedName, record.pageId);
        }
      }
      const backfillResult = await this.backfillBrewProfileRelations(profileNameToPageId);
      if (backfillResult.linked > 0) {
        console.log(
          `Profile reconciler: linked ${backfillResult.linked} brew(s) to profiles (scanned ${backfillResult.scanned})`,
        );
      }

      // Log a brief cycle summary so it is easy to confirm the reconciler is working.
      if (this.savedThisRun > 0 || this.deletedThisRun > 0) {
        const parts: string[] = [];
        if (this.savedThisRun > 0) parts.push(`${this.savedThisRun} saved/re-pushed`);
        if (this.deletedThisRun > 0) parts.push(`${this.deletedThisRun} deleted`);
        console.log(`Profile reconciler: cycle complete — ${parts.join(", ")}`);
      }
    } catch (error) {
      const isRateLimit =
        error instanceof Error &&
        ((error as any).status === 429 ||
          error.message.includes("429") ||
          error.message.toLowerCase().includes("rate limit") ||
          error.message.toLowerCase().includes("throttled"));
      if (isRateLimit) {
        console.warn("Profile reconciler: Notion rate limit hit, will retry next interval");
      } else {
        console.error("Profile reconciler error:", error);
      }
    } finally {
      this.running = false;
    }
  }

  private async processNotionProfile(
    notionProfile: ExistingProfileRecord,
    deviceById: Map<string, any>,
    matchedDeviceIds: Set<string>,
    matchedDeviceNames: Set<string>,
  ): Promise<void> {
    switch (notionProfile.pushStatus) {
      case "Queued":
        await this.handleQueuedProfile(notionProfile, matchedDeviceIds, matchedDeviceNames);
        break;
      case "Pushed":
        await this.handlePushedProfile(notionProfile, deviceById);
        break;
      case "Archived":
        await this.handleArchivedProfile(notionProfile, deviceById);
        break;
      case "Draft":
      case "Failed":
      default:
        break;
    }
  }

  private async handleQueuedProfile(
    notionProfile: ExistingProfileRecord,
    matchedDeviceIds: Set<string>,
    matchedDeviceNames: Set<string>,
  ): Promise<void> {
    const parsedProfile = this.parseProfileJson(notionProfile.profileJson);
    if (!parsedProfile) {
      console.error(`Profile ${notionProfile.pageId}: invalid JSON`);
      await this.notion.updatePushStatus(notionProfile.pageId, "Failed");
      return;
    }

    if (!this.isValidPushProfile(parsedProfile)) {
      console.error(`Profile ${notionProfile.pageId}: missing or invalid temperature/phases`);
      await this.notion.updatePushStatus(notionProfile.pageId, "Failed");
      return;
    }

    if (!parsedProfile.id && notionProfile.profileId) {
      parsedProfile.id = notionProfile.profileId;
    }

    try {
      if (!this.canPerformSaveOperation()) {
        return;
      }

      const savedResult = await this.gaggimate.saveProfile(parsedProfile);
      this.savedThisRun += 1;
      const savedId = this.notion.extractProfileId(savedResult) || this.notion.extractProfileId(parsedProfile);
      if (savedId) {
        parsedProfile.id = savedId;
      }
      if (savedId) {
        matchedDeviceIds.add(savedId);
      }
      const normalizedSavedName = this.normalizeDeviceProfileName(parsedProfile);
      if (normalizedSavedName) {
        matchedDeviceNames.add(normalizedSavedName);
      }

      // Sync favorite/selected immediately after push without waiting for the next cycle.
      await this.applyFavoriteAndSelectedSync(notionProfile, savedResult, { forceSelect: notionProfile.selected });

      // Write normalized JSON + status together — one Notion API call instead of two.
      const normalizedSaved = normalizeProfileForGaggiMate(parsedProfile as any);
      const now = new Date().toISOString();
      await this.notion.updatePushStatus(notionProfile.pageId, "Pushed", now, true, JSON.stringify(normalizedSaved));
      console.log(`Profile ${notionProfile.pageId}: pushed to device`);

      // Restore profile chart image if it was deleted (best-effort, non-blocking on failure).
      if (!notionProfile.hasProfileImage) {
        this.notion.uploadProfileImage(
          notionProfile.pageId,
          parsedProfile.label || notionProfile.normalizedName,
          parsedProfile,
          notionProfile.profileJson,
        ).catch((error) => console.warn(`Profile ${notionProfile.pageId}: failed to restore profile image:`, error));
      }
    } catch (error) {
      console.error(`Profile ${notionProfile.pageId}: push failed:`, error);
      await this.notion.updatePushStatus(notionProfile.pageId, "Failed");
    }
  }

  private async handlePushedProfile(
    notionProfile: ExistingProfileRecord,
    deviceById: Map<string, any>,
  ): Promise<void> {
    const deviceId = notionProfile.profileId;
    if (!deviceId) {
      return;
    }

    const deviceProfile = deviceById.get(deviceId);
    if (!deviceProfile) {
      const notionProfileJson = this.parseProfileJson(notionProfile.profileJson);
      if (!notionProfileJson) {
        console.error(`Profile ${notionProfile.pageId}: invalid JSON, cannot re-push missing profile`);
        await this.notion.updatePushStatus(notionProfile.pageId, "Failed");
        return;
      }

      notionProfileJson.id = deviceId;
      try {
        if (!this.canPerformSaveOperation()) {
          return;
        }

        await this.gaggimate.saveProfile(notionProfileJson);
        this.savedThisRun += 1;
        await this.applyFavoriteAndSelectedSync(notionProfile, notionProfileJson, { forceSelect: notionProfile.selected });
        // Write normalized JSON + status together — one Notion API call instead of two.
        const normalizedRepush = normalizeProfileForGaggiMate(notionProfileJson as any);
        const now = new Date().toISOString();
        await this.notion.updatePushStatus(notionProfile.pageId, "Pushed", now, true, JSON.stringify(normalizedRepush));
        console.log(`Profile ${notionProfile.pageId}: re-pushed missing device profile`);

        // Restore profile chart image if it was deleted (best-effort, non-blocking on failure).
        if (!notionProfile.hasProfileImage) {
          this.notion.uploadProfileImage(
            notionProfile.pageId,
            notionProfileJson.label || notionProfile.normalizedName,
            notionProfileJson,
            notionProfile.profileJson,
          ).catch((error) => console.warn(`Profile ${notionProfile.pageId}: failed to restore profile image:`, error));
        }
      } catch (error) {
        console.error(`Profile ${notionProfile.pageId}: failed to re-push missing profile:`, error);
        await this.notion.updatePushStatus(notionProfile.pageId, "Failed");
      }
      return;
    }

    const notionProfileJson = this.parseProfileJson(notionProfile.profileJson);
    if (!notionProfileJson) {
      console.error(`Profile ${notionProfile.pageId}: invalid JSON, cannot reconcile drift`);
      await this.notion.updatePushStatus(notionProfile.pageId, "Failed");
      return;
    }

    const needsRepush = !this.areProfilesEquivalent(notionProfileJson, deviceProfile);
    if (needsRepush) {
      notionProfileJson.id = deviceId;
      try {
        if (!this.canPerformSaveOperation()) {
          return;
        }

        await this.gaggimate.saveProfile(notionProfileJson);
        this.savedThisRun += 1;
        // Write normalized JSON + ensure activeOnMachine=true together — one Notion API call.
        const normalizedJson = normalizeProfileForGaggiMate(notionProfileJson as any);
        await this.notion.updatePushStatus(notionProfile.pageId, "Pushed", undefined, true, JSON.stringify(normalizedJson));
        console.log(`Profile ${notionProfile.pageId}: reconciled device profile from Notion JSON`);
      } catch (error) {
        console.error(`Profile ${notionProfile.pageId}: failed to reconcile profile drift:`, error);
        await this.notion.updatePushStatus(notionProfile.pageId, "Failed");
        return;
      }
    }

    await this.applyFavoriteAndSelectedSync(notionProfile, deviceProfile);

    if (!needsRepush && notionProfile.activeOnMachine !== true) {
      await this.notion.updatePushStatus(notionProfile.pageId, "Pushed", undefined, true);
    }

    // Restore profile chart image if it was deleted (best-effort, non-blocking on failure).
    if (!notionProfile.hasProfileImage) {
      this.notion.uploadProfileImage(
        notionProfile.pageId,
        notionProfileJson.label || notionProfile.normalizedName,
        notionProfileJson,
        notionProfile.profileJson,
      ).catch((error) => console.warn(`Profile ${notionProfile.pageId}: failed to restore profile image:`, error));
    }
  }

  private async handleArchivedProfile(
    notionProfile: ExistingProfileRecord,
    deviceById: Map<string, any>,
  ): Promise<void> {
    // Safety: archived rows that are already marked inactive are treated as
    // historical/unmanaged and should not trigger destructive device deletes.
    if (notionProfile.activeOnMachine === false) {
      return;
    }

    const deviceId = notionProfile.profileId;
    if (!deviceId) {
      await this.notion.updatePushStatus(notionProfile.pageId, "Archived", undefined, false);
      return;
    }

    const deviceProfile = deviceById.get(deviceId);
    if (!deviceProfile) {
      await this.notion.updatePushStatus(notionProfile.pageId, "Archived", undefined, false);
      return;
    }

    if (this.isUtilityProfile(deviceProfile)) {
      console.log(`Profile ${notionProfile.pageId}: skipping delete for utility profile`);
      return;
    }

    if (!this.options.deleteEnabled) {
      if (!this.deleteLimitWarned) {
        console.warn("Profile reconciler: delete operations are disabled by configuration");
        this.deleteLimitWarned = true;
      }
      return;
    }

    const maxDeletesPerRun = Math.max(0, Math.floor(this.options.maxDeletesPerRun));
    if (this.deletedThisRun >= maxDeletesPerRun) {
      if (!this.deleteLimitWarned) {
        console.error(
          `Profile reconciler: delete limit reached (${maxDeletesPerRun} per cycle), skipping additional archived deletes`,
        );
        this.deleteLimitWarned = true;
      }
      return;
    }

    try {
      await this.gaggimate.deleteProfile(deviceId);
      await this.notion.updatePushStatus(notionProfile.pageId, "Archived", undefined, false);
      this.deletedThisRun += 1;
      console.log(`Profile ${notionProfile.pageId}: deleted from device`);
    } catch (error) {
      console.error(`Profile ${notionProfile.pageId}: delete failed:`, error);
      await this.notion.updatePushStatus(notionProfile.pageId, "Failed");
    }
  }

  private async applyFavoriteAndSelectedSync(
    notionProfile: ExistingProfileRecord,
    profileOnDevice: any,
    options?: { forceSelect?: boolean },
  ): Promise<void> {
    const deviceId = this.notion.extractProfileId(profileOnDevice) || notionProfile.profileId;
    if (!deviceId) {
      return;
    }

    const deviceFavorite = Boolean(profileOnDevice?.favorite);
    const deviceSelected = Boolean(profileOnDevice?.selected);

    // Both operations are independent — run in parallel to minimize device round-trips.
    const tasks: Promise<void>[] = [];
    if (deviceFavorite !== notionProfile.favorite) {
      tasks.push(
        this.gaggimate.favoriteProfile(deviceId, notionProfile.favorite).catch((error) => {
          console.warn(`Profile ${notionProfile.pageId}: favorite sync failed:`, error);
        }),
      );
    }
    if (notionProfile.selected && (options?.forceSelect || !deviceSelected)) {
      tasks.push(
        this.gaggimate.selectProfile(deviceId).catch((error) => {
          console.warn(`Profile ${notionProfile.pageId}: select sync failed:`, error);
        }),
      );
    }
    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  private async backfillBrewProfileRelations(
    profilesByName: Map<string, string>,
  ): Promise<{ scanned: number; linked: number }> {
    // Cooldown: skip entirely when we recently found nothing useful to do.
    if (Date.now() < this.backfillSkipUntil) {
      return { scanned: 0, linked: 0 };
    }

    let scanned = 0;
    let linked = 0;
    const maxRowsPerRun = 1000;

    while (scanned < maxRowsPerRun) {
      const remaining = maxRowsPerRun - scanned;
      const candidates = await this.notion.listBrewsMissingProfileRelation(Math.min(100, remaining));
      if (candidates.length === 0) {
        break;
      }

      scanned += candidates.length;
      for (const brew of candidates) {
        try {
          if (!brew.activityId) {
            continue;
          }

          const shot = await this.gaggimate.fetchShot(brew.activityId);
          if (!shot?.profileName) {
            continue;
          }

          // Use the already-fetched profile index — no extra Notion query per brew.
          const normalizedName = this.notion.normalizeProfileName(shot.profileName);
          const profilePageId = profilesByName.get(normalizedName) ?? null;
          if (!profilePageId) {
            continue;
          }

          await this.notion.setBrewProfileRelation(brew.pageId, profilePageId);
          linked += 1;
        } catch (error) {
          console.error(`Brew ${brew.pageId}: profile backfill failed:`, error);
        }
      }

      if (candidates.length < 100) {
        break;
      }
    }

    // Set cooldown based on outcome to avoid repeated expensive cycles:
    //   scanned=0  → nothing to do at all   → skip for 5 min
    //   linked=0   → found brews but none linkable (offline/no profile name) → skip for 2 min
    if (scanned === 0) {
      this.backfillSkipUntil = Date.now() + 5 * 60 * 1000;
    } else if (linked === 0) {
      this.backfillSkipUntil = Date.now() + 2 * 60 * 1000;
    }

    return { scanned, linked };
  }

  private isUtilityProfile(profile: any): boolean {
    if (profile?.utility === true) {
      return true;
    }

    const normalizedLabel = this.normalizeDeviceProfileName(profile);
    return normalizedLabel === "flush" || normalizedLabel === "descale";
  }

  private areProfilesEquivalent(first: any, second: any): boolean {
    // Normalize `first` (Notion JSON) the same way we normalize before saving to the device.
    // Without this, fields like null phase temperatures or missing valve/pump defaults will
    // never match the device's filled-in values, causing a re-push every reconcile cycle.
    const desired = this.normalizeForCompare(normalizeProfileForGaggiMate(first as any));
    const actual = this.normalizeForCompare(second);
    return this.isSubsetMatch(desired, actual);
  }

  private normalizeForCompare(value: any): any {
    if (Array.isArray(value)) {
      return value.map((entry) => this.normalizeForCompare(entry));
    }
    if (typeof value === "string") {
      return this.normalizeTextForCompare(value);
    }
    if (!value || typeof value !== "object") {
      return value;
    }

    const sorted: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      // Favorite/Selected are synced via Notion checkboxes, not Profile JSON.
      if (key === "favorite" || key === "selected") {
        continue;
      }
      const normalizedChild = this.normalizeForCompare(value[key]);
      if (normalizedChild !== undefined) {
        sorted[key] = normalizedChild;
      }
    }
    return sorted;
  }

  private isSubsetMatch(desired: any, actual: any): boolean {
    if (Array.isArray(desired)) {
      if (!Array.isArray(actual) || desired.length !== actual.length) {
        return false;
      }
      for (let i = 0; i < desired.length; i += 1) {
        if (!this.isSubsetMatch(desired[i], actual[i])) {
          return false;
        }
      }
      return true;
    }

    if (desired && typeof desired === "object") {
      if (!actual || typeof actual !== "object") {
        return false;
      }

      for (const [key, desiredValue] of Object.entries(desired)) {
        if (!this.isSubsetMatch(desiredValue, actual[key])) {
          return false;
        }
      }

      return true;
    }

    if (typeof desired === "number" && typeof actual === "string") {
      const parsed = Number(actual);
      if (Number.isFinite(parsed)) {
        return desired === parsed;
      }
    }

    if (typeof desired === "boolean" && typeof actual === "string") {
      const normalized = actual.trim().toLowerCase();
      if (normalized === "true" || normalized === "false") {
        return desired === (normalized === "true");
      }
    }

    return desired === actual;
  }

  private normalizeTextForCompare(value: string): string {
    const repaired = repairMojibake(value);
    return repaired
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .replace(/\u00A0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private findConflictingManagedIds(records: ExistingProfileRecord[]): Set<string> {
    const pagesByDeviceId = new Map<string, Set<string>>();

    for (const record of records) {
      if (!record.profileId || !this.isManagedStatus(record.pushStatus)) {
        continue;
      }

      if (!pagesByDeviceId.has(record.profileId)) {
        pagesByDeviceId.set(record.profileId, new Set<string>());
      }
      pagesByDeviceId.get(record.profileId)!.add(record.pageId);
    }

    const conflictingIds = new Set<string>();
    for (const [deviceId, pageIds] of pagesByDeviceId.entries()) {
      if (pageIds.size > 1) {
        conflictingIds.add(deviceId);
      }
    }
    return conflictingIds;
  }

  private isManagedStatus(status: string | null): boolean {
    return status === "Queued" || status === "Pushed" || status === "Archived";
  }

  private parseProfileJson(profileJson: string): any | null {
    if (!profileJson || !profileJson.trim()) {
      return null;
    }

    try {
      return JSON.parse(profileJson);
    } catch {
      return null;
    }
  }

  private isValidPushProfile(profile: any): boolean {
    if (typeof profile?.temperature !== "number" || !Number.isFinite(profile.temperature)) {
      return false;
    }
    if (profile.temperature < 60 || profile.temperature > 100) {
      return false;
    }
    if (!Array.isArray(profile?.phases) || profile.phases.length === 0) {
      return false;
    }
    return true;
  }

  private profileLabel(profile: any): string {
    if (typeof profile?.label !== "string") {
      return "";
    }
    return profile.label.trim();
  }

  private normalizeDeviceProfileName(profile: any): string {
    const profileLabel = this.profileLabel(profile);
    if (!profileLabel) {
      return "";
    }
    return this.notion.normalizeProfileName(profileLabel);
  }

  private canPerformSaveOperation(): boolean {
    const maxSavesPerRun = Math.max(0, Math.floor(this.options.maxSavesPerRun));
    if (this.savedThisRun >= maxSavesPerRun) {
      if (!this.saveLimitWarned) {
        console.error(
          `Profile reconciler: save limit reached (${maxSavesPerRun} per cycle), skipping additional pushes/re-pushes`,
        );
        this.saveLimitWarned = true;
      }
      return false;
    }
    return true;
  }
}
