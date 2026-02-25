import type { GaggiMateClient } from "../gaggimate/client.js";
import { normalizeProfileForGaggiMate } from "../gaggimate/profileNormalization.js";
import type { NotionClient } from "../notion/client.js";
import { syncFavoriteAndSelectedFromNotion, type ProfilePreferenceState } from "./profilePreferenceSync.js";

/**
 * Parse and validate Profile JSON, push to GaggiMate, update Notion status.
 * Used by webhook-driven profile pushes.
 */
export async function pushProfileToGaggiMate(
  gaggimate: GaggiMateClient,
  notion: NotionClient,
  pageId: string,
  profileJsonStr: string,
  preferenceState?: ProfilePreferenceState,
): Promise<void> {
  let profile: any;
  try {
    profile = JSON.parse(profileJsonStr);
  } catch {
    console.error(`Profile ${pageId}: invalid JSON`);
    await notion.updatePushStatus(pageId, "Failed");
    return;
  }

  // Validate required fields
  if (typeof profile.temperature !== "number" || !Number.isFinite(profile.temperature) || !Array.isArray(profile.phases) || profile.phases.length === 0) {
    console.error(`Profile ${pageId}: missing temperature or phases`);
    await notion.updatePushStatus(pageId, "Failed");
    return;
  }

  // Validate temperature range
  if (profile.temperature < 60 || profile.temperature > 100) {
    console.error(`Profile ${pageId}: temperature ${profile.temperature} out of range (60-100)`);
    await notion.updatePushStatus(pageId, "Failed");
    return;
  }

  // Reject obviously malformed profiles with an unreasonable number of phases.
  // GaggiMate's binary recorder caps phase transitions at 12; 20 is a generous upper bound.
  if (profile.phases.length > 20) {
    console.error(`Profile ${pageId}: too many phases (${profile.phases.length}, max 20)`);
    await notion.updatePushStatus(pageId, "Failed");
    return;
  }

  try {
    // saveProfile handles normalization internally.
    const savedResult = await gaggimate.saveProfile(profile);
    const savedId = notion.extractProfileId(savedResult);
    if (savedId) {
      profile.id = savedId;
    }
    const effectiveProfileId = savedId || notion.extractProfileId(profile);
    if (effectiveProfileId) {
      try {
        await syncFavoriteAndSelectedFromNotion(gaggimate, notion, pageId, effectiveProfileId, preferenceState);
      } catch (error) {
        // Keep push success independent from preference sync; reconciler will retry.
        console.warn(`Profile ${pageId}: favorite/selected sync failed after push:`, error);
      }
    }

    // Write normalized JSON + status together — one Notion API call instead of two.
    const normalizedProfile = normalizeProfileForGaggiMate(profile as any);
    const now = new Date().toISOString();
    await notion.updatePushStatus(pageId, "Pushed", now, true, JSON.stringify(normalizedProfile));
    console.log(`Profile ${pageId}: pushed to GaggiMate`);
  } catch (error) {
    console.error(`Profile ${pageId}: push failed:`, error);
    await notion.updatePushStatus(pageId, "Failed");
  }
}
