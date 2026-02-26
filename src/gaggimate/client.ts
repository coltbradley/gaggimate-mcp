import WebSocket from "ws";
import { parseBinaryIndex, indexToShotList } from "../parsers/binaryIndex.js";
import type { ShotListItem } from "../parsers/binaryIndex.js";
import { parseBinaryShot } from "../parsers/binaryShot.js";
import type { ShotData } from "../parsers/binaryShot.js";
import type { GaggiMateConfig, ProfileData } from "./types.js";
import { normalizeProfileForGaggiMate } from "./profileNormalization.js";

function generateRequestId(): string {
  return `bridge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const message = error.message.toLowerCase();
    return name.includes("timeout") || name.includes("abort") || message.includes("timeout") || message.includes("aborted");
  }
  return false;
}

interface WsRequestOptions {
  /** Message type to send (e.g. "req:profiles:list") */
  reqType: string;
  /** Expected response type (e.g. "res:profiles:list") */
  resType: string;
  /** Additional fields to include in the outgoing message */
  payload?: Record<string, any>;
  /** Extract the result value from the response object */
  extractResult: (response: any) => any;
  /** Error prefix for readable error messages */
  errorPrefix: string;
}

interface PendingRequest {
  resType: string;
  extractResult: (res: any) => any;
  errorPrefix: string;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

export class GaggiMateClient {
  private config: GaggiMateConfig;

  // Shared WebSocket connection — reused across sequential requests to avoid
  // per-request TCP + WS handshake overhead. Closed after WS_IDLE_TTL ms of inactivity.
  private sharedWs: WebSocket | null = null;
  // Tracks an in-flight connection attempt so concurrent callers can share it
  // instead of creating competing CONNECTING sockets.
  private sharedWsConnectPromise: Promise<WebSocket> | null = null;
  private sharedWsIdleTimer: NodeJS.Timeout | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private readonly WS_IDLE_TTL = 8000;
  // Serializes request/response cycles to keep ESP32 WebSocket load predictable.
  private wsRequestQueue: Promise<void> = Promise.resolve();
  // Number of queued + active serialized WS requests.
  private wsQueuedRequestCount = 0;
  private wsQueueOverloadWarned = false;
  private readonly WS_QUEUE_WARN_THRESHOLD = 12;

  constructor(config: GaggiMateConfig) {
    this.config = config;
  }

  get host(): string {
    return this.config.host;
  }

  private get wsUrl(): string {
    return `${this.config.protocol}://${this.config.host}/ws`;
  }

  private get httpProtocol(): string {
    return this.config.protocol === "wss" ? "https" : "http";
  }

  private scheduleWsClose(): void {
    if (this.sharedWsIdleTimer) clearTimeout(this.sharedWsIdleTimer);
    this.sharedWsIdleTimer = setTimeout(() => {
      this.sharedWsIdleTimer = null;
      const ws = this.sharedWs;
      this.sharedWs = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    }, this.WS_IDLE_TTL);
  }

  private handleSharedMessage(data: WebSocket.Data): void {
    let response: any;
    try {
      response = JSON.parse(data.toString());
    } catch {
      return;
    }
    const pending = this.pendingRequests.get(response.rid);
    if (!pending || response.tp !== pending.resType) return;

    this.pendingRequests.delete(response.rid);
    clearTimeout(pending.timeoutHandle);
    this.scheduleWsClose();

    if (response.error) {
      pending.reject(new Error(`${pending.errorPrefix}: ${response.error}`));
    } else {
      pending.resolve(pending.extractResult(response));
    }
  }

  private rejectAllPending(reason: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  private getOrCreateWs(): Promise<WebSocket> {
    if (this.sharedWs?.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.sharedWs);
    }

    if (this.sharedWsConnectPromise) {
      return this.sharedWsConnectPromise;
    }

    // Close any stale connecting/closing socket before opening a new one.
    if (this.sharedWs) {
      const stale = this.sharedWs;
      this.sharedWs = null;
      stale.removeAllListeners();
      if (stale.readyState === WebSocket.CONNECTING || stale.readyState === WebSocket.OPEN) {
        stale.close();
      }
    }

    const connectPromise = new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.wsUrl);
      this.sharedWs = ws;

      const settleResolve = (value: WebSocket) => {
        if (settled) return;
        settled = true;
        if (this.sharedWsConnectPromise === connectPromise) {
          this.sharedWsConnectPromise = null;
        }
        resolve(value);
      };

      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        if (this.sharedWsConnectPromise === connectPromise) {
          this.sharedWsConnectPromise = null;
        }
        reject(error);
      };

      ws.on("open", () => settleResolve(ws));

      ws.on("message", (data: WebSocket.Data) => this.handleSharedMessage(data));

      ws.on("error", (err) => {
        if (this.sharedWs === ws) this.sharedWs = null;
        this.rejectAllPending(`WebSocket error: ${err.message}`);
        settleReject(new Error(`WebSocket error: ${err.message}`));
      });

      ws.on("close", () => {
        if (this.sharedWs === ws) this.sharedWs = null;
        this.rejectAllPending("WebSocket closed unexpectedly");
        settleReject(new Error("WebSocket closed unexpectedly"));
      });
    });

    this.sharedWsConnectPromise = connectPromise;
    return connectPromise;
  }

  private resetStuckConnectingSocket(reason: string): void {
    const ws = this.sharedWs;
    if (!ws || ws.readyState !== WebSocket.CONNECTING) {
      return;
    }

    this.sharedWs = null;
    this.sharedWsConnectPromise = null;

    try {
      ws.removeAllListeners();
    } catch {
      // best effort
    }

    try {
      ws.terminate();
    } catch {
      try {
        ws.close();
      } catch {
        // best effort
      }
    }

    console.warn(`GaggiMate WS connect stalled (${reason}); resetting socket`);
  }

  /**
   * Send a request over the shared WebSocket connection.
   * The connection is kept alive for WS_IDLE_TTL ms after the last response
   * to amortise TCP + handshake cost across sequential calls.
   */
  private sendWsRequest<T>(options: WsRequestOptions): Promise<T> {
    const runRequest = () => new Promise<T>((resolve, reject) => {
      const requestId = generateRequestId();

      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        if (this.pendingRequests.size === 0) {
          this.resetStuckConnectingSocket("request timeout");
        }
        reject(new Error(`Request timeout: No response from GaggiMate at ${this.wsUrl}`));
      }, this.config.requestTimeout);

      this.pendingRequests.set(requestId, {
        resType: options.resType,
        extractResult: options.extractResult,
        errorPrefix: options.errorPrefix,
        resolve,
        reject,
        timeoutHandle,
      });

      this.getOrCreateWs().then((ws) => {
        const payload = JSON.stringify({ tp: options.reqType, rid: requestId, ...options.payload });
        try {
          ws.send(payload, (sendError) => {
            if (!sendError) {
              return;
            }
            this.pendingRequests.delete(requestId);
            clearTimeout(timeoutHandle);
            reject(new Error(`WebSocket send failed: ${sendError.message}`));
          });
        } catch (sendError: any) {
          this.pendingRequests.delete(requestId);
          clearTimeout(timeoutHandle);
          reject(new Error(`WebSocket send failed: ${sendError?.message || "unknown error"}`));
        }
      }).catch((err) => {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeoutHandle);
        reject(err);
      });
    });

    this.wsQueuedRequestCount += 1;
    if (!this.wsQueueOverloadWarned && this.wsQueuedRequestCount >= this.WS_QUEUE_WARN_THRESHOLD) {
      this.wsQueueOverloadWarned = true;
      console.warn(
        `GaggiMate WS queue depth is high (${this.wsQueuedRequestCount}); requests are being throttled to protect the device`,
      );
    }

    // Chain each request to ensure only one in-flight WS round-trip at a time.
    const chained = this.wsRequestQueue.catch(() => undefined).then(runRequest);
    this.wsRequestQueue = chained.then(() => undefined, () => undefined);
    return chained.finally(() => {
      this.wsQueuedRequestCount = Math.max(0, this.wsQueuedRequestCount - 1);
      if (this.wsQueueOverloadWarned && this.wsQueuedRequestCount <= Math.floor(this.WS_QUEUE_WARN_THRESHOLD / 2)) {
        this.wsQueueOverloadWarned = false;
      }
    });
  }

  getConnectionDiagnostics(): {
    wsQueueDepth: number;
    wsPendingResponses: number;
    wsState: "none" | "connecting" | "open" | "closing" | "closed" | "unknown";
  } {
    let wsState: "none" | "connecting" | "open" | "closing" | "closed" | "unknown" = "none";
    if (this.sharedWs) {
      switch (this.sharedWs.readyState) {
        case WebSocket.CONNECTING:
          wsState = "connecting";
          break;
        case WebSocket.OPEN:
          wsState = "open";
          break;
        case WebSocket.CLOSING:
          wsState = "closing";
          break;
        case WebSocket.CLOSED:
          wsState = "closed";
          break;
        default:
          wsState = "unknown";
          break;
      }
    } else if (this.sharedWsConnectPromise) {
      wsState = "connecting";
    }

    return {
      wsQueueDepth: this.wsQueuedRequestCount,
      wsPendingResponses: this.pendingRequests.size,
      wsState,
    };
  }

  /** Check if GaggiMate is reachable via HTTP */
  async isReachable(): Promise<boolean> {
    try {
      const url = `${this.httpProtocol}://${this.config.host}/api/history/index.bin`;
      const response = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(3000),
      });
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  }

  /** Fetch all profiles from GaggiMate via WebSocket */
  async fetchProfiles(): Promise<any[]> {
    return this.sendWsRequest({
      reqType: "req:profiles:list",
      resType: "res:profiles:list",
      extractResult: (res) => res.profiles || [],
      errorPrefix: "GaggiMate API error",
    });
  }

  /** Fetch a specific profile by ID via WebSocket */
  async fetchProfile(profileId: string): Promise<any> {
    return this.sendWsRequest({
      reqType: "req:profiles:load",
      resType: "res:profiles:load",
      payload: { id: profileId },
      extractResult: (res) => res.profile || null,
      errorPrefix: "GaggiMate API error",
    });
  }

  /** Save a full profile to the device. Normalizes phase defaults before sending. */
  async saveProfile(profile: ProfileData): Promise<any> {
    const normalizedProfile = normalizeProfileForGaggiMate(profile);
    return this.sendWsRequest({
      reqType: "req:profiles:save",
      resType: "res:profiles:save",
      payload: { profile: normalizedProfile },
      extractResult: (res) => res.profile || { success: true },
      errorPrefix: "Failed to save profile",
    });
  }

  /** Delete a profile by ID via WebSocket */
  async deleteProfile(profileId: string): Promise<void> {
    return this.sendWsRequest({
      reqType: "req:profiles:delete",
      resType: "res:profiles:delete",
      payload: { id: profileId },
      extractResult: () => undefined,
      errorPrefix: "Failed to delete profile",
    });
  }

  /** Select a profile by ID via WebSocket */
  async selectProfile(profileId: string): Promise<void> {
    return this.sendWsRequest({
      reqType: "req:profiles:select",
      resType: "res:profiles:select",
      payload: { id: profileId },
      extractResult: () => undefined,
      errorPrefix: "Failed to select profile",
    });
  }

  /** Favorite or unfavorite a profile by ID via WebSocket */
  async favoriteProfile(profileId: string, favorite: boolean): Promise<void> {
    const action = favorite ? "favorite" : "unfavorite";
    return this.sendWsRequest({
      reqType: `req:profiles:${action}`,
      resType: `res:profiles:${action}`,
      payload: { id: profileId },
      extractResult: () => undefined,
      errorPrefix: `Failed to ${action} profile`,
    });
  }

  /** Fetch shot history index from GaggiMate HTTP API */
  async fetchShotHistory(limit?: number, offset?: number): Promise<ShotListItem[]> {
    try {
      const url = `${this.httpProtocol}://${this.config.host}/api/history/index.bin`;
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/octet-stream" },
        signal: AbortSignal.timeout(this.config.requestTimeout),
      });

      if (!response.ok) {
        if (response.status === 404) {
          return [];
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const indexData = parseBinaryIndex(buffer);
      let shotList = indexToShotList(indexData);

      if (offset !== undefined && offset > 0) {
        shotList = shotList.slice(offset);
      }
      if (limit !== undefined && limit > 0) {
        shotList = shotList.slice(0, limit);
      }

      return shotList;
    } catch (error: any) {
      if (isTimeoutError(error)) {
        throw new Error(`Request timeout: No response from GaggiMate at ${this.config.host}`);
      }
      throw error;
    }
  }

  /** Fetch a specific shot by ID from GaggiMate HTTP API */
  async fetchShot(shotId: string): Promise<ShotData | null> {
    try {
      const paddedId = shotId.padStart(6, "0");
      const url = `${this.httpProtocol}://${this.config.host}/api/history/${paddedId}.slog`;
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/octet-stream" },
        signal: AbortSignal.timeout(this.config.requestTimeout),
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return parseBinaryShot(buffer, shotId);
    } catch (error: any) {
      if (isTimeoutError(error)) {
        throw new Error(`Request timeout: No response from GaggiMate at ${this.config.host}`);
      }
      throw error;
    }
  }
}
