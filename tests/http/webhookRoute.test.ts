import { describe, expect, it, vi } from "vitest";
import { config } from "../../src/config.js";
import {
  buildNotionWebhookSignature,
  createWebhookRouter,
  isWebhookSecretConfigured,
  resolveWebhookProfileAction,
} from "../../src/http/routes/webhook.js";

function getNotionWebhookHandler(router: any): (req: any, res: any) => Promise<void> {
  const routeLayer = router.stack?.find(
    (layer: any) => layer.route?.path === "/notion" && layer.route?.methods?.post,
  );
  if (!routeLayer) {
    throw new Error("Could not find POST /notion route handler");
  }
  return routeLayer.route.stack[0].handle;
}

function createSignedRequest(body: any): any {
  const rawBody = JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (isWebhookSecretConfigured(config.webhook.secret)) {
    headers["x-notion-signature"] = buildNotionWebhookSignature(rawBody, config.webhook.secret);
  }

  return {
    body,
    headers,
    rawBody,
  };
}

function createResponse(): any {
  const res: any = {
    statusCode: 200,
    jsonBody: undefined,
  };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((payload: any) => {
    res.jsonBody = payload;
    return res;
  });
  return res;
}

function createMockGaggimate() {
  return {
    saveProfile: vi.fn().mockResolvedValue({ id: "device-queued" }),
    favoriteProfile: vi.fn().mockResolvedValue(undefined),
    selectProfile: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockNotion() {
  return {
    getProfilePageData: vi.fn(),
    extractProfileIdFromJson: vi.fn(),
    extractProfileId: vi.fn().mockImplementation((profile: any) => {
      if (typeof profile?.id === "string" && profile.id.trim()) {
        return profile.id;
      }
      return null;
    }),
    updateProfileJson: vi.fn().mockResolvedValue(undefined),
    updatePushStatus: vi.fn().mockResolvedValue(undefined),
  };
}

describe("webhook route status handling", () => {
  it("resolves status actions with status dominance", () => {
    expect(resolveWebhookProfileAction("Queued")).toBe("push_queued");
    expect(resolveWebhookProfileAction("Pushed")).toBe("sync_pushed_preferences");
    expect(resolveWebhookProfileAction("Archived")).toBe("ignore");
    expect(resolveWebhookProfileAction("Draft")).toBe("ignore");
    expect(resolveWebhookProfileAction("Failed")).toBe("ignore");
    expect(resolveWebhookProfileAction(null)).toBe("ignore");
  });

  it("syncs favorite in background for Pushed profiles", async () => {
    const gaggimate = createMockGaggimate();
    const notion = createMockNotion();
    notion.getProfilePageData.mockResolvedValue({
      profileJson: JSON.stringify({ id: "device-123", label: "Profile" }),
      pushStatus: "Pushed",
      favorite: true,
      selected: true,
    });
    notion.extractProfileIdFromJson.mockReturnValue("device-123");

    const router = createWebhookRouter(gaggimate as any, notion as any);
    const handler = getNotionWebhookHandler(router);
    const req = createSignedRequest({
      type: "page.properties_updated",
      entity: { type: "page", id: "page-1" },
    });
    const res = createResponse();

    await handler(req, res);

    // Handler responds immediately with "accepted"
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ ok: true, action: "accepted" });

    // Wait for background processing to complete (mocks resolve on microtask ticks)
    await vi.waitFor(() => {
      expect(gaggimate.favoriteProfile).toHaveBeenCalledWith("device-123", true);
    });
    expect(gaggimate.selectProfile).not.toHaveBeenCalled();
    expect(gaggimate.saveProfile).not.toHaveBeenCalled();
  });

  it("syncs selected when PROFILE_SYNC_SELECTED_TO_DEVICE is enabled", async () => {
    const originalSyncSelected = config.sync.profileSyncSelectedToDevice;
    (config as any).sync.profileSyncSelectedToDevice = true;
    try {
      const gaggimate = createMockGaggimate();
      const notion = createMockNotion();
      notion.getProfilePageData.mockResolvedValue({
        profileJson: JSON.stringify({ id: "device-select", label: "Profile" }),
        pushStatus: "Pushed",
        favorite: true,
        selected: true,
      });
      notion.extractProfileIdFromJson.mockReturnValue("device-select");

      const router = createWebhookRouter(gaggimate as any, notion as any);
      const handler = getNotionWebhookHandler(router);
      const req = createSignedRequest({
        type: "page.properties_updated",
        entity: { type: "page", id: "page-select" },
      });
      const res = createResponse();

      await handler(req, res);
      expect(res.jsonBody).toEqual({ ok: true, action: "accepted" });

      await vi.waitFor(() => {
        expect(gaggimate.selectProfile).toHaveBeenCalledWith("device-select");
      });
    } finally {
      (config as any).sync.profileSyncSelectedToDevice = originalSyncSelected;
    }
  });

  it("syncs preferences for Pushed profiles even when updated_properties contains only property IDs", async () => {
    // Notion webhooks send internal property IDs (e.g. "CqzA", "{_w?"), not display names.
    // Preference sync must run regardless of the updated_properties content.
    const gaggimate = createMockGaggimate();
    const notion = createMockNotion();
    notion.getProfilePageData.mockResolvedValue({
      profileJson: JSON.stringify({ id: "device-456", label: "Profile" }),
      pushStatus: "Pushed",
      favorite: false,
      selected: false,
    });
    notion.extractProfileIdFromJson.mockReturnValue("device-456");

    const router = createWebhookRouter(gaggimate as any, notion as any);
    const handler = getNotionWebhookHandler(router);
    const req = createSignedRequest({
      type: "page.properties_updated",
      entity: { type: "page", id: "page-2" },
      data: {
        // Notion property IDs — not human-readable names like "Favorite" or "Selected"
        updated_properties: ["%7B_w%3F", "CqzA"],
      },
    });
    const res = createResponse();

    await handler(req, res);
    expect(res.jsonBody).toEqual({ ok: true, action: "accepted" });

    // Preference sync must still fire even though the property IDs don't match "Favorite"/"Selected"
    await vi.waitFor(() => {
      expect(gaggimate.favoriteProfile).toHaveBeenCalledWith("device-456", false);
    });
    expect(gaggimate.selectProfile).not.toHaveBeenCalled();
    expect(gaggimate.saveProfile).not.toHaveBeenCalled();
  });

  it("ignores Archived status even if profile is selected/favorited", async () => {
    const gaggimate = createMockGaggimate();
    const notion = createMockNotion();
    notion.getProfilePageData.mockResolvedValue({
      profileJson: JSON.stringify({ id: "device-archived", label: "Archived" }),
      pushStatus: "Archived",
      favorite: true,
      selected: true,
    });

    const router = createWebhookRouter(gaggimate as any, notion as any);
    const handler = getNotionWebhookHandler(router);
    const req = createSignedRequest({
      type: "page.properties_updated",
      entity: { type: "page", id: "page-archived" },
    });
    const res = createResponse();

    await handler(req, res);

    // Responds immediately; background processing fetches push data then ignores
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ ok: true, action: "accepted" });

    // Wait for background to complete, then verify no device calls were made
    await vi.waitFor(() => {
      expect(notion.getProfilePageData).toHaveBeenCalledTimes(1);
    });
    expect(notion.extractProfileIdFromJson).not.toHaveBeenCalled();
    expect(gaggimate.favoriteProfile).not.toHaveBeenCalled();
    expect(gaggimate.selectProfile).not.toHaveBeenCalled();
    expect(gaggimate.saveProfile).not.toHaveBeenCalled();
  });

  it("still pushes queued profiles in background", async () => {
    const gaggimate = createMockGaggimate();
    const notion = createMockNotion();
    notion.getProfilePageData.mockResolvedValue({
      profileJson: JSON.stringify({
        label: "Queued Profile",
        temperature: 93,
        phases: [{ name: "Extraction", phase: "brew", duration: 30 }],
      }),
      pushStatus: "Queued",
      favorite: false,
      selected: false,
    });

    const router = createWebhookRouter(gaggimate as any, notion as any);
    const handler = getNotionWebhookHandler(router);
    const req = createSignedRequest({
      type: "page.properties_updated",
      entity: { type: "page", id: "page-queued" },
    });
    const res = createResponse();

    await handler(req, res);

    // Responds immediately
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ ok: true, action: "accepted" });

    // Wait for background push to complete
    await vi.waitFor(() => {
      expect(notion.updatePushStatus).toHaveBeenCalledWith("page-queued", "Pushed", expect.any(String), true, expect.any(String));
    });
    expect(gaggimate.saveProfile).toHaveBeenCalledTimes(1);
  });
});
