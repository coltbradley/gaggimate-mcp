import { Router } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import type { GaggiMateClient } from "../../gaggimate/client.js";
import type { NotionClient } from "../../notion/client.js";
import { config } from "../../config.js";
import { pushProfileToGaggiMate } from "../../sync/profilePush.js";

type WebhookProfileAction = "push_queued" | "sync_pushed_preferences" | "ignore";

export function resolveWebhookProfileAction(pushStatus: string | null): WebhookProfileAction {
  // Push status dominates all other profile flags/properties.
  if (pushStatus === "Queued") {
    return "push_queued";
  }
  if (pushStatus === "Pushed") {
    return "sync_pushed_preferences";
  }
  return "ignore";
}

export function isWebhookSecretConfigured(secret: string): boolean {
  return secret.trim().length > 0;
}

function toHeaderString(value: string | string[] | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
    return value[0];
  }
  return null;
}

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function buildNotionWebhookSignature(payload: string, verificationToken: string): string {
  const digest = createHmac("sha256", verificationToken).update(payload).digest("hex");
  return `sha256=${digest}`;
}

export function isValidNotionWebhookSignature(
  payload: string,
  signatureHeader: string | string[] | undefined,
  verificationToken: string,
): boolean {
  const signature = toHeaderString(signatureHeader);
  if (!signature) {
    return false;
  }

  const expectedSignature = buildNotionWebhookSignature(payload, verificationToken);
  return secureEquals(signature, expectedSignature);
}

async function processWebhookEvent(
  gaggimate: GaggiMateClient,
  notion: NotionClient,
  pageId: string,
  _updatedProperties: string[],
): Promise<void> {
  // Single page fetch covers push status, profile JSON, and preference state.
  const { profileJson, pushStatus, favorite, selected } = await notion.getProfilePageData(pageId);
  const action = resolveWebhookProfileAction(pushStatus);

  if (action === "ignore") {
    return;
  }

  if (!profileJson) {
    console.log(`Webhook for page ${pageId}: no Profile JSON found, ignoring`);
    return;
  }

  if (action === "push_queued") {
    await pushProfileToGaggiMate(gaggimate, notion, pageId, profileJson, { favorite, selected });
    return;
  }

  const profileId = notion.extractProfileIdFromJson(profileJson);
  if (!profileId) {
    console.warn(`Webhook for page ${pageId}: Pushed profile has no JSON id, cannot sync favorite/selected`);
    return;
  }

  const tasks: Array<{ action: "favorite" | "select"; task: Promise<void> }> = [];
  if (config.sync.profileSyncFavoriteToDevice) {
    tasks.push({
      action: "favorite",
      task: gaggimate.favoriteProfile(profileId, favorite),
    });
  }
  if (config.sync.profileSyncSelectedToDevice && selected) {
    tasks.push({
      action: "select",
      task: gaggimate.selectProfile(profileId),
    });
  }
  if (tasks.length > 0) {
    const results = await Promise.allSettled(tasks.map((entry) => entry.task));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "rejected") {
        console.warn(`Webhook for page ${pageId}: ${tasks[index].action} sync failed`, result.reason);
      }
    }
  }
}

export function createWebhookRouter(gaggimate: GaggiMateClient, notion: NotionClient): Router {
  const router = Router();
  let warnedMissingSecret = false;
  let signatureMismatchLogMutedUntil = 0;
  let suppressedSignatureMismatchCount = 0;
  const SIGNATURE_MISMATCH_LOG_INTERVAL_MS = 60_000;
  const inFlightPageProcessing = new Set<string>();
  const rerunRequestedForPage = new Set<string>();

  const logSignatureMismatch = () => {
    const now = Date.now();
    if (now < signatureMismatchLogMutedUntil) {
      suppressedSignatureMismatchCount += 1;
      return;
    }

    const suppressedSummary = suppressedSignatureMismatchCount > 0
      ? ` (${suppressedSignatureMismatchCount} additional mismatches suppressed in the last ${Math.round(SIGNATURE_MISMATCH_LOG_INTERVAL_MS / 1000)}s)`
      : "";
    console.warn(
      `Webhook signature mismatch — rejecting${suppressedSummary}. ` +
      "Check WEBHOOK_SECRET matches Notion's raw verification token (not a sha256=... signature value).",
    );
    suppressedSignatureMismatchCount = 0;
    signatureMismatchLogMutedUntil = now + SIGNATURE_MISMATCH_LOG_INTERVAL_MS;
  };

  const enqueuePageProcessing = (pageId: string, updatedProps: string[]) => {
    if (inFlightPageProcessing.has(pageId)) {
      rerunRequestedForPage.add(pageId);
      return;
    }

    const run = async () => {
      inFlightPageProcessing.add(pageId);
      try {
        do {
          rerunRequestedForPage.delete(pageId);
          try {
            await processWebhookEvent(gaggimate, notion, pageId, updatedProps);
          } catch (error) {
            console.error(`Webhook background processing failed for page ${pageId}:`, error);
          }
        } while (rerunRequestedForPage.has(pageId));
      } finally {
        inFlightPageProcessing.delete(pageId);
      }
    };

    run().catch((error) => {
      console.error(`Webhook queue failed for page ${pageId}:`, error);
    });
  };

  router.post("/notion", async (req, res) => {
    try {
      if (typeof req.body?.verification_token === "string") {
        console.log("Notion webhook verification token received. Save this token to WEBHOOK_SECRET.");
        res.json({ ok: true, action: "verification_token_received" });
        return;
      }

      // Handle Notion's verification challenge (initial webhook setup)
      if (req.body?.type === "url_verification") {
        console.log("Notion webhook verification challenge received");
        res.json({ challenge: req.body.challenge });
        return;
      }

      const rawBody = typeof (req as any).rawBody === "string"
        ? (req as any).rawBody
        : JSON.stringify(req.body ?? {});
      if (isWebhookSecretConfigured(config.webhook.secret)) {
        const signature = req.headers["x-notion-signature"];
        const trusted = isValidNotionWebhookSignature(rawBody, signature, config.webhook.secret);
        if (!trusted) {
          logSignatureMismatch();
          res.status(401).json({ error: "Invalid webhook signature" });
          return;
        }
      } else if (!warnedMissingSecret) {
        console.warn(
          "WEBHOOK_SECRET is not configured. Accepting unsigned webhook events. Configure WEBHOOK_SECRET when endpoint is public.",
        );
        warnedMissingSecret = true;
      }

      const payload = req.body;
      const eventType = payload?.type;

      // Only process page property changes
      if (
        eventType !== "page.property_changed" &&
        eventType !== "page.changed" &&
        eventType !== "page.properties_updated"
      ) {
        res.json({ ok: true, action: "ignored" });
        return;
      }

      // Early filter: if Notion includes the parent database ID in the payload,
      // skip pages from other databases without a Notion API call.
      const parentDbId: string | undefined = payload?.data?.parent?.database_id;
      if (parentDbId) {
        const normalize = (id: string) => id.replace(/-/g, "").toLowerCase();
        if (normalize(parentDbId) !== normalize(config.notion.profilesDbId)) {
          res.json({ ok: true, action: "ignored", reason: "not profiles db" });
          return;
        }
      }

      const updatedProps: string[] = Array.isArray(payload?.data?.updated_properties)
        ? payload.data.updated_properties
        : [];
      console.log(
        `Webhook received: type=${eventType}, entity=${payload?.entity?.type}` +
          (updatedProps.length > 0 ? `, changed=[${updatedProps.join(", ")}]` : ""),
      );

      const pageId = payload?.entity?.id || payload?.data?.page_id;
      if (!pageId) {
        res.json({ ok: true, action: "ignored", reason: "no page id" });
        return;
      }

      // Respond immediately so Notion doesn't timeout waiting for device/API calls.
      res.json({ ok: true, action: "accepted" });

      // Process in the background with per-page coalescing to avoid event storms
      // generating concurrent device writes.
      enqueuePageProcessing(pageId, updatedProps);
    } catch (error) {
      console.error("Webhook processing error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Webhook processing failed",
      });
    }
  });

  return router;
}
