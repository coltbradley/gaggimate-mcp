import { Client } from "@notionhq/client";
import type { NotionConfig, BrewData, PushStatus, BrewFilters, BeanFilters } from "./types.js";
import { brewDataToNotionProperties } from "./mappers.js";
import { renderProfileChartSvg } from "../visualization/profileChart.js";
import { renderBrewChartSvg } from "../visualization/brewChart.js";
import type { ShotData } from "../parsers/binaryShot.js";
import { repairMojibake, normalizeProfileName as normalizeProfileNameUtil } from "../utils/text.js";

export interface ExistingProfileRecord {
  pageId: string;
  normalizedName: string;
  profileId: string | null;
  profileJson: string;
  pushStatus: string | null;
  activeOnMachine: boolean | null;
  hasProfileImage: boolean;
  source: string | null;
  favorite: boolean;
  selected: boolean;
}

export interface ExistingProfilesIndex {
  byName: Map<string, ExistingProfileRecord>;
  byId: Map<string, ExistingProfileRecord>;
  all: ExistingProfileRecord[];
}

export class NotionClient {
  private client: Client;
  private config: NotionConfig;
  private imageUploadDisabledReason: string | null = null;
  // Cache positive profile name→pageId lookups. Only positive results are cached so
  // newly-created profiles are always found without explicit invalidation.
  private profilePageIdCache = new Map<string, { pageId: string; expiresAt: number }>();
  private readonly PROFILE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(notionConfig: NotionConfig) {
    this.config = notionConfig;
    this.client = new Client({ auth: notionConfig.apiKey });
  }

  /** Returns the reason image uploads are disabled, or null if they are enabled. */
  get imageUploadDisabled(): string | null {
    return this.imageUploadDisabledReason;
  }

  /** Check if the Notion API connection is working */
  async isConnected(): Promise<boolean> {
    try {
      await this.client.users.me({});
      return true;
    } catch {
      return false;
    }
  }

  // ─── Brews ────────────────────────────────────────────────

  /** Create a brew entry in Notion from shot data */
  async createBrew(brew: BrewData): Promise<string> {
    const properties = await this.buildBrewProperties(brew);

    const response = await this.client.pages.create({
      parent: { database_id: this.config.brewsDbId },
      properties,
    });
    return response.id;
  }

  /** Update an existing brew page from shot-derived data */
  async updateBrewFromData(pageId: string, brew: BrewData): Promise<void> {
    const properties = await this.buildBrewProperties(brew);
    await this.updateBrew(pageId, properties);
  }

  /** Find an existing brew by GaggiMate shot ID (dedup check) */
  async findBrewByShotId(shotId: string): Promise<string | null> {
    const response = await this.client.databases.query({
      database_id: this.config.brewsDbId,
      filter: {
        property: "Activity ID",
        rich_text: { equals: shotId },
      },
      page_size: 1,
    });
    return response.results.length > 0 ? response.results[0].id : null;
  }

  /** List brews with optional filters */
  async listBrews(filters?: BrewFilters): Promise<any[]> {
    const filterConditions: any[] = [];

    if (filters?.startDate) {
      filterConditions.push({
        property: "Date",
        date: { on_or_after: filters.startDate },
      });
    }
    if (filters?.endDate) {
      filterConditions.push({
        property: "Date",
        date: { on_or_before: filters.endDate },
      });
    }

    const queryParams: any = {
      database_id: this.config.brewsDbId,
      sorts: [{ property: "Date", direction: "descending" }],
    };

    if (filterConditions.length > 0) {
      queryParams.filter = filterConditions.length === 1
        ? filterConditions[0]
        : { and: filterConditions };
    }

    const response = await this.client.databases.query(queryParams);
    return response.results;
  }

  /** Update a brew entry */
  async updateBrew(pageId: string, properties: Record<string, any>): Promise<void> {
    await this.client.pages.update({
      page_id: pageId,
      properties,
    });
  }

  /** Set the Profile relation on an existing brew page */
  async setBrewProfileRelation(brewPageId: string, profilePageId: string): Promise<void> {
    await this.client.pages.update({
      page_id: brewPageId,
      properties: {
        Profile: { relation: [{ id: profilePageId }] },
      },
    });
  }

  /** Check whether a brew page already has a Brew Profile image */
  async brewHasProfileImage(pageId: string): Promise<boolean> {
    try {
      const page = await this.client.pages.retrieve({ page_id: pageId }) as any;
      const prop = page.properties?.["Brew Profile"];
      return prop?.type === "files" && Array.isArray(prop.files) && prop.files.length > 0;
    } catch {
      return false;
    }
  }

  /** Set the Shot JSON rich_text property on a brew page */
  async setBrewShotJson(pageId: string, jsonString: string): Promise<void> {
    await this.client.pages.update({
      page_id: pageId,
      properties: {
        "Shot JSON": {
          rich_text: this.toRichText(jsonString),
        },
      },
    });
  }

  /** Render + upload a brew chart SVG to the Brew Profile files property */
  async uploadBrewChart(pageId: string, shotId: string, shot: ShotData): Promise<boolean> {
    if (this.imageUploadDisabledReason) {
      return false;
    }

    try {
      const svg = renderBrewChartSvg(shot);
      const filename = `brew-${shotId}.svg`;
      const fileUpload = await this.createNotionFileUpload(filename, "image/svg+xml");
      await this.sendFileUpload(fileUpload.uploadUrl, filename, "image/svg+xml", svg);
      await this.attachBrewProfileImage(pageId, fileUpload.id);
      return true;
    } catch (error) {
      console.warn(`Brew ${shotId}: failed to upload Brew Profile image`, error);
      if (error instanceof Error && error.message.includes("(401)")) {
        this.imageUploadDisabledReason = "notion-file-upload-auth-failed";
        console.warn("Disabling image uploads for this process after 401 from Notion file upload API.");
      }
      return false;
    }
  }

  /** List brews where Profile relation is empty, including Activity ID for lookup */
  async listBrewsMissingProfileRelation(limit = 100): Promise<Array<{ pageId: string; activityId: string | null }>> {
    const results: Array<{ pageId: string; activityId: string | null }> = [];
    let cursor: string | undefined;

    while (results.length < limit) {
      const pageSize = Math.min(100, limit - results.length);
      const response = await this.client.databases.query({
        database_id: this.config.brewsDbId,
        filter: {
          property: "Profile",
          relation: { is_empty: true },
        },
        start_cursor: cursor,
        page_size: pageSize,
      });

      for (const page of response.results as any[]) {
        const activityId = this.extractBrewActivityId(page);
        results.push({
          pageId: page.id,
          activityId,
        });
      }

      if (!response.has_more || !response.next_cursor) {
        break;
      }
      cursor = response.next_cursor;
    }

    return results;
  }

  // ─── Profiles ─────────────────────────────────────────────

  /** Update the Push Status of a profile page */
  async updatePushStatus(
    pageId: string,
    status: PushStatus,
    timestamp?: string,
    activeOnMachine?: boolean,
    profileJson?: string,
  ): Promise<void> {
    const properties: Record<string, any> = {
      "Push Status": { select: { name: status } },
    };
    if (timestamp) {
      properties["Last Pushed"] = { date: { start: timestamp } };
    }
    if (activeOnMachine !== undefined) {
      properties["Active on Machine"] = { checkbox: activeOnMachine };
    }
    if (profileJson !== undefined) {
      properties["Profile JSON"] = { rich_text: this.toRichText(profileJson) };
    }
    await this.client.pages.update({
      page_id: pageId,
      properties,
    });
  }

  /** Read all webhook-relevant fields from a profile page in a single API call */
  async getProfilePageData(pageId: string): Promise<{
    profileJson: string | null;
    pushStatus: string | null;
    favorite: boolean;
    selected: boolean;
  }> {
    const page = await this.client.pages.retrieve({ page_id: pageId }) as any;
    const profileJson = this.extractRichText(page, "Profile JSON") || null;
    const pushStatusProp = page.properties?.["Push Status"];
    const pushStatus = pushStatusProp?.type === "select" ? pushStatusProp.select?.name || null : null;
    const favoriteProp = page.properties?.Favorite;
    const selectedProp = page.properties?.Selected;
    return {
      profileJson,
      pushStatus,
      favorite: favoriteProp?.type === "checkbox" ? Boolean(favoriteProp.checkbox) : false,
      selected: selectedProp?.type === "checkbox" ? Boolean(selectedProp.checkbox) : false,
    };
  }

  /** Read the Profile JSON property from a profile page */
  async getProfileJSON(pageId: string): Promise<string | null> {
    const { profileJson } = await this.getProfilePageData(pageId);
    return profileJson;
  }

  /** @deprecated Use getProfilePageData for combined fetch */
  async getProfilePushData(pageId: string): Promise<{ profileJson: string | null; pushStatus: string | null }> {
    const { profileJson, pushStatus } = await this.getProfilePageData(pageId);
    return { profileJson, pushStatus };
  }

  /** @deprecated Use getProfilePageData for combined fetch */
  async getProfilePreferenceState(pageId: string): Promise<{ favorite: boolean; selected: boolean }> {
    const { favorite, selected } = await this.getProfilePageData(pageId);
    return { favorite, selected };
  }

  /** Create a Draft profile page from a device profile (auto-import) */
  async createDraftProfile(profile: any): Promise<string> {
    const profileName = typeof profile?.label === "string" ? profile.label.trim() : "";
    if (!profileName) {
      throw new Error("Cannot create draft profile without a profile label");
    }

    const description = typeof profile?.description === "string" ? profile.description : "";
    const mappedType = this.mapProfileType(profile?.type);
    const mappedSource = this.mapProfileSource(profile);
    const profileJson = JSON.stringify(profile);

    const createdPage = await this.client.pages.create({
      parent: { database_id: this.config.profilesDbId },
      properties: {
        "Profile Name": {
          title: [{ text: { content: profileName } }],
        },
        Description: {
          rich_text: this.toRichText(description),
        },
        "Profile Type": {
          select: { name: mappedType },
        },
        Source: {
          select: { name: mappedSource },
        },
        "Active on Machine": {
          checkbox: true,
        },
        "Profile JSON": {
          rich_text: this.toRichText(profileJson),
        },
        "Push Status": {
          select: { name: "Draft" },
        },
        Favorite: {
          checkbox: Boolean(profile?.favorite),
        },
        Selected: {
          checkbox: Boolean(profile?.selected),
        },
      },
    });

    // Seed the profile name cache so the next findProfilePageByName call for this name is free.
    const normalizedCreatedName = this.normalizeProfileName(profileName);
    if (normalizedCreatedName) {
      this.profilePageIdCache.set(normalizedCreatedName, {
        pageId: createdPage.id,
        expiresAt: Date.now() + this.PROFILE_CACHE_TTL,
      });
    }
    return createdPage.id;
  }

  /** Update the Profile JSON rich_text property on a profile page */
  async updateProfileJson(pageId: string, jsonString: string): Promise<void> {
    await this.client.pages.update({
      page_id: pageId,
      properties: {
        "Profile JSON": {
          rich_text: this.toRichText(jsonString),
        },
      },
    });
  }

  /** Check whether a profile with this name already exists in Notion */
  async hasProfileByName(profileName: string): Promise<boolean> {
    const pageId = await this.findProfilePageByName(profileName);
    return pageId !== null;
  }

  /** Resolve a profile page ID by profile name */
  async getProfilePageIdByName(profileName: string): Promise<string | null> {
    return this.findProfilePageByName(profileName);
  }

  // ─── Beans ────────────────────────────────────────────────

  /** List beans with optional filters */
  async listBeans(filters?: BeanFilters): Promise<any[]> {
    const filterConditions: any[] = [];

    if (filters?.roaster) {
      filterConditions.push({
        property: "Roaster",
        select: { equals: filters.roaster },
      });
    }
    if (filters?.buyAgain !== undefined) {
      filterConditions.push({
        property: "Buy Again",
        checkbox: { equals: filters.buyAgain },
      });
    }

    const queryParams: any = {
      database_id: this.config.beansDbId,
    };

    if (filterConditions.length > 0) {
      queryParams.filter = filterConditions.length === 1
        ? filterConditions[0]
        : { and: filterConditions };
    }

    const response = await this.client.databases.query(queryParams);
    return response.results;
  }

  /** Get a specific bean page */
  async getBean(pageId: string): Promise<any> {
    return this.client.pages.retrieve({ page_id: pageId });
  }

  // ─── Helpers ──────────────────────────────────────────────

  private extractTitle(page: any): string {
    const titleProp = Object.values(page.properties).find(
      (p: any) => p.type === "title"
    ) as any;
    return titleProp?.title?.[0]?.plain_text || "";
  }

  private extractRichText(page: any, propertyName: string): string {
    const prop = page.properties?.[propertyName];
    if (!prop || prop.type !== "rich_text") return "";
    return prop.rich_text?.map((t: any) => t.plain_text).join("") || "";
  }

  private async findProfilePageByName(profileName: string): Promise<string | null> {
    if (!profileName) return null;
    const requestedName = this.normalizeProfileName(profileName);
    if (!requestedName) return null;

    // Cache hit — only positive results are stored so newly-created profiles are
    // always discovered on the next query without any explicit invalidation.
    const cached = this.profilePageIdCache.get(requestedName);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.pageId;
    }

    // Fast path: exact title match.
    const exactMatch = await this.client.databases.query({
      database_id: this.config.profilesDbId,
      filter: {
        property: "Profile Name",
        title: { equals: profileName.trim() },
      },
      page_size: 1,
    });
    if (exactMatch.results.length > 0) {
      const pageId = exactMatch.results[0].id;
      this.profilePageIdCache.set(requestedName, { pageId, expiresAt: Date.now() + this.PROFILE_CACHE_TTL });
      return pageId;
    }

    // Fallback: scan profile names to allow case/spacing/encoding variations.
    let cursor: string | undefined;
    do {
      const response = await this.client.databases.query({
        database_id: this.config.profilesDbId,
        start_cursor: cursor,
        page_size: 100,
      });

      for (const page of response.results as any[]) {
        const candidateName = this.normalizeProfileName(this.extractTitle(page));
        if (candidateName === requestedName) {
          const pageId = page.id;
          this.profilePageIdCache.set(requestedName, { pageId, expiresAt: Date.now() + this.PROFILE_CACHE_TTL });
          return pageId;
        }
      }

      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);

    return null;
  }

  private async buildBrewProperties(brew: BrewData): Promise<Record<string, any>> {
    const properties = brewDataToNotionProperties(brew);

    // If a profile with matching title exists, link it via the Profile relation.
    const profilePageId = await this.findProfilePageByName(brew.profileName);
    if (profilePageId) {
      properties.Profile = { relation: [{ id: profilePageId }] };
    } else if (brew.profileName) {
      console.warn(`No Profiles DB match found for profile name "${brew.profileName}"`);
    }

    return properties;
  }

  normalizeProfileName(name: string): string {
    return normalizeProfileNameUtil(name);
  }

  async listExistingProfiles(): Promise<ExistingProfilesIndex> {
    const byName = new Map<string, ExistingProfileRecord>();
    const byId = new Map<string, ExistingProfileRecord>();
    const all: ExistingProfileRecord[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.databases.query({
        database_id: this.config.profilesDbId,
        start_cursor: cursor,
        page_size: 100,
      });

      for (const page of response.results as any[]) {
        const normalized = this.normalizeProfileName(this.extractTitle(page));
        if (!normalized) continue;
        const profileJson = this.extractRichText(page, "Profile JSON");
        const profileId = this.extractProfileIdFromJson(profileJson);
        const pushStatusProp = page.properties?.["Push Status"];
        const activeOnMachineProp = page.properties?.["Active on Machine"];
        const profileImageProp = page.properties?.["Profile Image"];
        const sourceProp = page.properties?.["Source"];
        const favoriteProp = page.properties?.Favorite;
        const selectedProp = page.properties?.Selected;

        const record: ExistingProfileRecord = {
          pageId: page.id,
          normalizedName: normalized,
          profileId,
          profileJson,
          pushStatus: pushStatusProp?.type === "select" ? pushStatusProp.select?.name || null : null,
          activeOnMachine: activeOnMachineProp?.type === "checkbox" ? Boolean(activeOnMachineProp.checkbox) : null,
          hasProfileImage: profileImageProp?.type === "files" ? Array.isArray(profileImageProp.files) && profileImageProp.files.length > 0 : false,
          source: sourceProp?.type === "select" ? sourceProp.select?.name || null : null,
          favorite: favoriteProp?.type === "checkbox" ? Boolean(favoriteProp.checkbox) : false,
          selected: selectedProp?.type === "checkbox" ? Boolean(selectedProp.checkbox) : false,
        };

        all.push(record);
        // Archived profiles stay in `all` but are excluded from lookup maps
        // so import sync won't overwrite them.
        if (record.pushStatus !== "Archived") {
          byName.set(normalized, record);
          if (profileId) {
            byId.set(profileId, record);
          }
        }
      }

      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);

    return { byName, byId, all };
  }

  private extractBrewActivityId(page: any): string | null {
    const activityIdProp = page.properties?.["Activity ID"];
    if (activityIdProp?.type === "rich_text") {
      const value = activityIdProp.rich_text?.map((t: any) => t.plain_text).join("") || "";
      if (value.trim()) return value.trim();
    }

    // Fallback for legacy rows without Activity ID:
    // infer shot ID from Brew title like "#027 - Feb 14 PM".
    const brewTitleProp = page.properties?.Brew;
    if (brewTitleProp?.type === "title") {
      const title = brewTitleProp.title?.map((t: any) => t.plain_text).join("") || "";
      const match = title.match(/^#0*([0-9]+)/);
      if (match?.[1]) return match[1];
    }

    return null;
  }

  extractProfileId(profile: any): string | null {
    if (typeof profile?.id !== "string") return null;
    const id = profile.id.trim();
    return id.length > 0 ? id : null;
  }

  extractProfileIdFromJson(profileJson: string): string | null {
    if (!profileJson.trim()) return null;
    try {
      const parsed = JSON.parse(profileJson);
      return this.extractProfileId(parsed);
    } catch {
      return null;
    }
  }

  toRichText(value: string): Array<{ text: { content: string } }> {
    // Notion rich_text content has a per-segment limit; split long JSON safely.
    const chunkSize = 1900;
    if (!value) {
      return [{ text: { content: "" } }];
    }

    const chunks: Array<{ text: { content: string } }> = [];
    for (let i = 0; i < value.length; i += chunkSize) {
      chunks.push({ text: { content: value.slice(i, i + chunkSize) } });
    }
    return chunks;
  }

  mapProfileType(type: unknown): string {
    const normalized = typeof type === "string" ? type.trim().toLowerCase() : "";
    if (normalized.includes("flat")) return "Flat";
    if (normalized.includes("declin")) return "Declining";
    if (normalized.includes("bloom")) return "Blooming";
    if (normalized.includes("lever")) return "Lever";
    if (normalized.includes("turbo")) return "Turbo";
    return "Custom";
  }

  mapProfileSource(profile: any): string {
    const label = typeof profile?.label === "string" ? profile.label.toLowerCase() : "";
    if (label === "ai profile") return "AI-Generated";
    if (profile?.utility === true) return "Stock";
    return "Custom";
  }

  /**
   * Prefer profileJsonForChart when it has transition data (e.g. from Notion AI or manual edit).
   * GaggiMate API may return profiles without transitions; Notion's stored JSON can be more complete.
   */
  async uploadProfileImage(pageId: string, profileName: string, profile: any, profileJsonForChart?: string | null): Promise<boolean> {
    if (this.imageUploadDisabledReason) {
      return false;
    }

    let chartProfile = profile;
    if (profileJsonForChart?.trim()) {
      try {
        const parsed = JSON.parse(profileJsonForChart) as any;
        if (parsed && Array.isArray(parsed.phases) && parsed.phases.length > 0) {
          chartProfile = parsed;
        }
      } catch {
        /* use GaggiMate profile */
      }
    }

    try {
      const svg = renderProfileChartSvg(chartProfile);
      const fileUpload = await this.createNotionFileUpload(`${this.sanitizeFileName(profileName)}.svg`, "image/svg+xml");
      await this.sendFileUpload(fileUpload.uploadUrl, `${this.sanitizeFileName(profileName)}.svg`, "image/svg+xml", svg);
      await this.attachProfileImage(pageId, fileUpload.id);
      return true;
    } catch (error) {
      console.warn(`Profile "${profileName}": failed to upload Profile Image`, error);
      if (error instanceof Error && error.message.includes("(401)")) {
        this.imageUploadDisabledReason = "notion-file-upload-auth-failed";
        console.warn("Disabling Profile Image uploads for this process after 401 responses from Notion file upload API.");
      }
      return false;
    }
  }

  private async createNotionFileUpload(filename: string, contentType: string): Promise<{ id: string; uploadUrl: string }> {
    const response = await this.client.request<any>({
      path: "file_uploads",
      method: "post",
      body: {
        mode: "single_part",
        filename,
        content_type: contentType,
      },
    });

    const id = typeof response?.id === "string" ? response.id : "";
    const uploadUrl = typeof response?.upload_url === "string" ? response.upload_url : "";

    if (!id || !uploadUrl) {
      throw new Error("Notion file upload init failed: missing id or upload_url");
    }

    return { id, uploadUrl };
  }

  private async sendFileUpload(uploadUrl: string, filename: string, contentType: string, content: string): Promise<void> {
    const formData = new FormData();
    formData.append("file", new Blob([content], { type: contentType }), filename);

    const response = await fetch(uploadUrl, {
      method: "POST",
      body: formData,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Notion-Version": "2022-06-28",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Notion file upload send failed (${response.status}): ${body}`);
    }
  }

  private async attachBrewProfileImage(pageId: string, fileUploadId: string): Promise<void> {
    await this.client.request({
      path: `pages/${pageId}`,
      method: "patch",
      body: {
        properties: {
          "Brew Profile": {
            files: [
              {
                type: "file_upload",
                file_upload: { id: fileUploadId },
              },
            ],
          },
        },
      },
    });
  }

  private async attachProfileImage(pageId: string, fileUploadId: string): Promise<void> {
    await this.client.request({
      path: `pages/${pageId}`,
      method: "patch",
      body: {
        properties: {
          "Profile Image": {
            files: [
              {
                type: "file_upload",
                file_upload: { id: fileUploadId },
              },
            ],
          },
        },
      },
    });
  }

  private sanitizeFileName(value: string): string {
    const normalized = value.trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9\-_]/g, "").toLowerCase();
    return normalized || "profile";
  }
}
