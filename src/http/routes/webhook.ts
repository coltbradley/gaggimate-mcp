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

function looksLikeSignatureDigest(value: string): boolean {
  return /^sha256=[a-f0-9]{64}$/i.test(value.trim());
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

export function buildNotionWebhookSignature(payload: string | Buffer, verificationToken: string): string {
  const digest = createHmac("sha256", verificationToken).update(payload).digest("hex");
  return `sha256=${digest}`;
}

export function isValidNotionWebhookSignature(
  payload: string | Buffer,
  signatureHeader: string | string[] | undefined,
  verificationToken: string,
): boolean {
  const signature = toHeaderString(signatureHeader);
  if (!signature) {
    return false;
  }

  // Notion sends "sha256=" plus 64 hex digits. Anything else, including
  // non-ASCII bytes or extra whitespace, is rejected before comparing.
  if (!/^sha256=[0-9a-fA-F]{64}$/.test(signature)) {
    return false;
  }
  const expected = createHmac("sha256", verificationToken).update(payload).digest();
  const provided = Buffer.from(signature.slice(7), "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
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
    await pushProfileToGaggiMate(
      gaggimate,
      notion,
      pageId,
      profileJson,
      { favorite, selected },
      {
        syncFavoriteToDevice: config.sync.profileSyncFavoriteToDevice,
        syncSelectedToDevice: config.sync.profileSyncSelectedToDevice,
      },
    );
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
  const webhookVerificationToken = config.webhook.secret;
  let signatureMismatchLogMutedUntil = 0;
  let suppressedSignatureMismatchCount = 0;
  const SIGNATURE_MISMATCH_LOG_INTERVAL_MS = 60_000;
  const WEBHOOK_EVENT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const WEBHOOK_EVENT_DEDUPE_MAX = 10_000;
  const inFlightPageProcessing = new Set<string>();
  const rerunRequestedForPage = new Set<string>();
  const processedEventIds = new Map<string, number>();
  const inFlightEventIds = new Set<string>();
  const queuedEventIds = new Set<string>();
  const queuedEventIdsByPage = new Map<string, Set<string>>();

  const pruneProcessedEventIds = (now: number) => {
    for (const [eventId, expiresAt] of processedEventIds.entries()) {
      if (expiresAt <= now) {
        processedEventIds.delete(eventId);
      }
    }
    if (processedEventIds.size <= WEBHOOK_EVENT_DEDUPE_MAX) {
      return;
    }
    const overflow = processedEventIds.size - WEBHOOK_EVENT_DEDUPE_MAX;
    let removed = 0;
    for (const eventId of processedEventIds.keys()) {
      processedEventIds.delete(eventId);
      removed += 1;
      if (removed >= overflow) {
        break;
      }
    }
  };

  const logSignatureMismatch = () => {
    const now = Date.now();
    if (now < signatureMismatchLogMutedUntil) {
      suppressedSignatureMismatchCount += 1;
      return;
    }

    const suppressedSummary = suppressedSignatureMismatchCount > 0
      ? ` (${suppressedSignatureMismatchCount} additional mismatches suppressed in the last ${Math.round(SIGNATURE_MISMATCH_LOG_INTERVAL_MS / 1000)}s)`
      : "";
    const misconfiguredDigestHint = looksLikeSignatureDigest(webhookVerificationToken)
      ? " WEBHOOK_SECRET currently looks like an X-Notion-Signature digest; use the raw verification_token value."
      : "";
    console.warn(
      `Webhook signature mismatch — rejecting${suppressedSummary}. ` +
      `Check WEBHOOK_SECRET matches Notion's raw verification token (not a sha256=... signature value).${misconfiguredDigestHint}`,
    );
    suppressedSignatureMismatchCount = 0;
    signatureMismatchLogMutedUntil = now + SIGNATURE_MISMATCH_LOG_INTERVAL_MS;
  };

  const enqueuePageProcessing = (pageId: string, updatedProps: string[], eventId: string | null) => {
    if (inFlightPageProcessing.has(pageId)) {
      rerunRequestedForPage.add(pageId);
      if (eventId) {
        let queuedForPage = queuedEventIdsByPage.get(pageId);
        if (!queuedForPage) {
          queuedForPage = new Set<string>();
          queuedEventIdsByPage.set(pageId, queuedForPage);
        }
        queuedForPage.add(eventId);
        queuedEventIds.add(eventId);
      }
      return;
    }

    const run = async () => {
      inFlightPageProcessing.add(pageId);
      if (eventId) {
        inFlightEventIds.add(eventId);
      }
      let completedWithoutUnhandledError = true;
      try {
        do {
          rerunRequestedForPage.delete(pageId);
          try {
            await processWebhookEvent(gaggimate, notion, pageId, updatedProps);
          } catch (error) {
            console.error(`Webhook background processing failed for page ${pageId}:`, error);
            completedWithoutUnhandledError = false;
          }
        } while (rerunRequestedForPage.has(pageId));
      } finally {
        inFlightPageProcessing.delete(pageId);
        const queuedForPage = queuedEventIdsByPage.get(pageId);
        queuedEventIdsByPage.delete(pageId);
        if (queuedForPage) {
          for (const queuedId of queuedForPage) {
            queuedEventIds.delete(queuedId);
          }
        }
        if (eventId) {
          inFlightEventIds.delete(eventId);
        }
        if (completedWithoutUnhandledError && (eventId || queuedForPage?.size)) {
          const now = Date.now();
          pruneProcessedEventIds(now);
          if (eventId) {
            processedEventIds.set(eventId, now + WEBHOOK_EVENT_DEDUPE_TTL_MS);
          }
          if (queuedForPage) {
            for (const queuedId of queuedForPage) {
              processedEventIds.set(queuedId, now + WEBHOOK_EVENT_DEDUPE_TTL_MS);
            }
          }
        }
      }
    };

    run().catch((error) => {
      console.error(`Webhook queue failed for page ${pageId}:`, error);
    });
  };

  router.post("/notion", async (req, res) => {
    // Fail closed: without a secret the route does not exist (server.ts also
    // declines to mount it).
    if (!isWebhookSecretConfigured(webhookVerificationToken)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    try {
      if (typeof req.body?.verification_token === "string") {
        // Never adopt a token from an unauthenticated request: the secret comes
        // from WEBHOOK_SECRET only.
        res.json({ ok: true, action: "verification_token_received" });
        return;
      }

      // Handle Notion's verification challenge (initial webhook setup)
      if (req.body?.type === "url_verification") {
        console.log("Notion webhook verification challenge received");
        res.json({ challenge: req.body.challenge });
        return;
      }

      const captured = (req as any).rawBody;
      const rawBody: string | Buffer = typeof captured === "string" || Buffer.isBuffer(captured)
        ? captured
        : JSON.stringify(req.body ?? {});
      const signature = req.headers["x-notion-signature"];
      if (!isValidNotionWebhookSignature(rawBody, signature, webhookVerificationToken)) {
        logSignatureMismatch();
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }

      const payload = req.body;
      const eventType = payload?.type;
      const eventId = typeof payload?.id === "string" ? payload.id : null;

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

      if (eventId) {
        const now = Date.now();
        pruneProcessedEventIds(now);
        const isInFlightDuplicate = inFlightEventIds.has(eventId) || queuedEventIds.has(eventId);
        const processedUntil = processedEventIds.get(eventId) ?? 0;
        const isProcessedDuplicate = processedUntil > now;
        if (isInFlightDuplicate || isProcessedDuplicate) {
          console.log(`Webhook duplicate event ${eventId}: skipping re-processing`);
          res.json({ ok: true, action: "accepted", deduped: true });
          return;
        }
      }

      // Respond immediately so Notion doesn't timeout waiting for device/API calls.
      res.json({ ok: true, action: "accepted" });

      // Process in the background with per-page coalescing to avoid event storms
      // generating concurrent device writes.
      enqueuePageProcessing(pageId, updatedProps, eventId);
    } catch (error) {
      console.error("Webhook processing error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Webhook processing failed",
      });
    }
  });

  return router;
}
