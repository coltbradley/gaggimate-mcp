# GaggiMate Bridge v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the GaggiMate Notion Bridge from a polling-based sync service into an event-driven bridge with MCP tools, DDSA shot analysis, and automated deployment.

**Architecture:** Single Docker container on TrueNAS. WebSocket event subscription replaces shot polling. MCP server (Streamable HTTP) mounted on existing Express app. DDSA analysis ported from GaggiMate web UI's AnalyzerService.js. Auto-deploy via GitHub Actions + Watchtower.

**Tech Stack:** TypeScript, Node 20, Express 4, `@modelcontextprotocol/sdk` v1.x, `zod`, `ws`, `@notionhq/client`, vitest

**Design doc:** `docs/plans/2026-04-02-v2-rearchitecture-design.md`

---

## Task 1: WebSocket Event Listener

Add the ability to listen for unsolicited device events (`evt:status`, etc.) on the shared WebSocket connection. Currently `handleSharedMessage()` only processes request-response pairs matched by `rid`.

**Files:**
- Modify: `src/gaggimate/client.ts:97-116` (handleSharedMessage)
- Modify: `src/gaggimate/client.ts:126-187` (getOrCreateWs)
- Create: `tests/gaggimate/events.test.ts`

**Step 1: Write failing test for event listener registration**

```typescript
// tests/gaggimate/events.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GaggiMateClient } from "../../src/gaggimate/client.js";

describe("WebSocket event listener", () => {
  let client: GaggiMateClient;

  beforeEach(() => {
    client = new GaggiMateClient("test-host", "ws", 5000);
  });

  it("registers and fires event callbacks for evt: messages", () => {
    const callback = vi.fn();
    client.on("evt:status", callback);

    const event = { tp: "evt:status", process: { state: "idle" } };
    // Simulate receiving an event message
    (client as any).handleEvent(event);

    expect(callback).toHaveBeenCalledWith(event);
  });

  it("does not fire event callbacks for response messages with rid", () => {
    const callback = vi.fn();
    client.on("evt:status", callback);

    const response = { tp: "res:profiles:list", rid: "123", profiles: [] };
    (client as any).handleEvent(response);

    expect(callback).not.toHaveBeenCalled();
  });

  it("supports multiple listeners for the same event", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    client.on("evt:status", cb1);
    client.on("evt:status", cb2);

    const event = { tp: "evt:status" };
    (client as any).handleEvent(event);

    expect(cb1).toHaveBeenCalled();
    expect(cb2).toHaveBeenCalled();
  });

  it("removes listeners with off()", () => {
    const callback = vi.fn();
    client.on("evt:status", callback);
    client.off("evt:status", callback);

    (client as any).handleEvent({ tp: "evt:status" });
    expect(callback).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/gaggimate/events.test.ts`
Expected: FAIL — `client.on` is not a function

**Step 3: Implement event listener in GaggiMateClient**

In `src/gaggimate/client.ts`:

1. Add event listener map as class property:
```typescript
private eventListeners: Map<string, Set<(data: any) => void>> = new Map();
```

2. Add `on()`, `off()`, and `handleEvent()` methods:
```typescript
on(eventType: string, callback: (data: any) => void): void {
  if (!this.eventListeners.has(eventType)) {
    this.eventListeners.set(eventType, new Set());
  }
  this.eventListeners.get(eventType)!.add(callback);
}

off(eventType: string, callback: (data: any) => void): void {
  this.eventListeners.get(eventType)?.delete(callback);
}

private handleEvent(message: any): void {
  if (!message.tp || message.rid) return; // Skip responses (have rid)
  const listeners = this.eventListeners.get(message.tp);
  if (listeners) {
    for (const cb of listeners) {
      try { cb(message); } catch (e) { console.error(`Event listener error for ${message.tp}:`, e); }
    }
  }
}
```

3. Modify `handleSharedMessage()` (~line 97) to dispatch events before checking `rid`:
```typescript
private handleSharedMessage(data: Buffer | string): void {
  try {
    const message = JSON.parse(typeof data === "string" ? data : data.toString());

    // Dispatch unsolicited events (no rid)
    if (message.tp && !message.rid) {
      this.handleEvent(message);
      return;
    }

    // Existing rid-based response handling...
    const { rid, tp } = message;
    // ... rest unchanged
  } catch (e) { /* ... */ }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/gaggimate/events.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All 153+ tests pass (existing behavior unchanged)

**Step 6: Commit**

```bash
git add src/gaggimate/client.ts tests/gaggimate/events.test.ts
git commit -m "feat: add WebSocket event listener support for unsolicited device events"
```

---

## Task 2: Event-Driven Shot Detection

Refactor the shot poller to detect new shots via `evt:status` WebSocket events instead of polling `index.bin` every 30s. Keep a slow fallback poll (5 minutes).

**Files:**
- Modify: `src/sync/shotPoller.ts:56-62` (start method), `src/sync/shotPoller.ts:236-567` (poll method)
- Modify: `src/config.ts` (add FALLBACK_POLL_INTERVAL_MS)
- Create: `tests/sync/eventDrivenShot.test.ts`

**Step 1: Write failing test for event-driven shot trigger**

```typescript
// tests/sync/eventDrivenShot.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("event-driven shot detection", () => {
  it("triggers poll when evt:status indicates shot completion", async () => {
    const mockGaggimate = {
      on: vi.fn(),
      off: vi.fn(),
      fetchShotHistory: vi.fn().mockResolvedValue([]),
      isReachable: vi.fn().mockResolvedValue(true),
    };
    const mockNotion = {
      queryBrewByActivityId: vi.fn().mockResolvedValue(null),
    };

    // ShotPoller should register an evt:status listener on start
    // and call poll() when a shot completes
    const { ShotPoller } = await import("../../src/sync/shotPoller.js");
    const poller = new ShotPoller(mockGaggimate as any, mockNotion as any, {
      syncIntervalMs: 300000, // 5 min fallback
      recentShotLookbackCount: 5,
      repairIntervalMs: 3600000,
      importMissingProfilesFromShots: false,
      dataDir: "/tmp/test-data",
    });

    poller.start();

    // Verify it registered an event listener
    expect(mockGaggimate.on).toHaveBeenCalledWith(
      "evt:status",
      expect.any(Function)
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/sync/eventDrivenShot.test.ts`
Expected: FAIL

**Step 3: Implement event-driven detection in ShotPoller**

Modify `src/sync/shotPoller.ts`:

1. In `start()`, register event listener and increase fallback poll interval:
```typescript
start(): void {
  // Register for real-time shot events
  this.gaggimate.on("evt:status", this.handleStatusEvent.bind(this));

  // Fallback poll at longer interval (5 min instead of 30s)
  this.pollInterval = setInterval(() => this.poll(), this.syncIntervalMs);

  // Initial poll
  this.poll();
}
```

2. Add status event handler:
```typescript
private lastSeenBrewState: string | null = null;

private handleStatusEvent(event: any): void {
  // Detect brew completion: state transitions from brewing to idle
  const brewState = event?.process?.state ?? event?.s;
  if (this.lastSeenBrewState === "brewing" && brewState !== "brewing") {
    console.log("Shot completion detected via evt:status, triggering sync");
    // Small delay to let .slog file finish writing
    setTimeout(() => this.poll(), 2000);
  }
  this.lastSeenBrewState = brewState ?? this.lastSeenBrewState;
}
```

3. In `stop()`, unregister the listener:
```typescript
stop(): void {
  if (this.pollInterval) clearInterval(this.pollInterval);
  this.gaggimate.off("evt:status", this.handleStatusEvent.bind(this));
}
```

**Step 4: Update config default**

In `src/config.ts`, change the `SYNC_INTERVAL_MS` default from 30000 to 300000 (5 min fallback):
```typescript
syncIntervalMs: parseEnvNumber("SYNC_INTERVAL_MS", 300000),
```

**Step 5: Run tests**

Run: `npm test`
Expected: All tests pass. Some existing shotPoller tests may need interval adjustments.

**Step 6: Commit**

```bash
git add src/sync/shotPoller.ts src/config.ts tests/sync/eventDrivenShot.test.ts
git commit -m "feat: event-driven shot detection via WebSocket evt:status"
```

---

## Task 3: Shot Notes Integration

Fetch shot notes (dose in/out, grind, rating, taste) from the device via WebSocket when syncing each shot.

**Files:**
- Modify: `src/gaggimate/client.ts` (add fetchShotNotes method)
- Modify: `src/gaggimate/types.ts` (add ShotNotes type)
- Create: `tests/gaggimate/shotNotes.test.ts`

**Step 1: Write failing test**

```typescript
// tests/gaggimate/shotNotes.test.ts
import { describe, it, expect } from "vitest";
import { ShotNotes } from "../../src/gaggimate/types.js";

describe("ShotNotes type", () => {
  it("has expected fields", () => {
    const notes: ShotNotes = {
      id: 47,
      rating: 4,
      beanType: "Ethiopian Yirgacheffe",
      doseIn: 18.0,
      doseOut: 36.2,
      ratio: "1:2.0",
      grindSetting: "14",
      balanceTaste: "balanced",
      notes: "Great shot, slightly acidic",
      timestamp: 1711987200,
    };
    expect(notes.rating).toBe(4);
    expect(notes.balanceTaste).toBe("balanced");
  });
});
```

**Step 2: Run test — FAIL**

Run: `npm test -- tests/gaggimate/shotNotes.test.ts`

**Step 3: Add ShotNotes type**

In `src/gaggimate/types.ts`:
```typescript
export interface ShotNotes {
  id: number;
  rating?: number;
  beanType?: string;
  doseIn?: number;
  doseOut?: number;
  ratio?: string;
  grindSetting?: string;
  balanceTaste?: "bitter" | "balanced" | "sour";
  notes?: string;
  timestamp?: number;
}
```

**Step 4: Add fetchShotNotes to client**

In `src/gaggimate/client.ts`:
```typescript
async fetchShotNotes(shotId: number): Promise<ShotNotes | null> {
  try {
    const response = await this.sendWsRequest<any>(
      "req:history:notes:get",
      "res:history:notes:get",
      { id: shotId }
    );
    return response ?? null;
  } catch (e) {
    // Notes may not exist for every shot
    return null;
  }
}
```

**Step 5: Run tests — PASS**

Run: `npm test`

**Step 6: Commit**

```bash
git add src/gaggimate/types.ts src/gaggimate/client.ts tests/gaggimate/shotNotes.test.ts
git commit -m "feat: add shot notes fetching via WebSocket API"
```

---

## Task 4: DDSA Analysis Engine

Port the core analysis logic from GaggiMate's `AnalyzerService.js` into a TypeScript module. Focus on the most useful metrics: per-phase stats, weight flow rate, exit reason detection, puck resistance analysis.

**Files:**
- Create: `src/analysis/shotAnalysis.ts`
- Create: `src/analysis/types.ts`
- Create: `tests/analysis/shotAnalysis.test.ts`

**Step 1: Define analysis output types**

```typescript
// src/analysis/types.ts
export interface MetricStats {
  min: number;
  max: number;
  avg: number;
  start: number;
  end: number;
}

export interface PhaseAnalysis {
  name: string;
  phaseNumber: number;
  startTimeMs: number;
  durationMs: number;
  sampleCount: number;
  pressure: MetricStats;
  flow: MetricStats;
  temperature: MetricStats;
  puckResistance: MetricStats;
  weightFlowRate: number | null;  // g/s via linear regression
  exitReason: string | null;      // "Time Stop", "Weight Stop", etc.
}

export interface ShotAnalysis {
  phases: PhaseAnalysis[];
  totalDurationMs: number;
  isBrewByWeight: boolean;
  finalWeight: number | null;
  avgPuckResistance: number | null;
  peakPuckResistance: number | null;
  avgWeightFlowRate: number | null;
  exitReason: string | null;        // Overall shot exit reason
  phaseSummary: string;             // Human readable: "Preinfusion: 8s @ 3 bar → Brew: 24s @ 9 bar"
}
```

**Step 2: Write failing tests for core analysis functions**

```typescript
// tests/analysis/shotAnalysis.test.ts
import { describe, it, expect } from "vitest";
import { analyzeShotData } from "../../src/analysis/shotAnalysis.js";
import type { ShotData } from "../../src/parsers/binaryShot.js";

describe("DDSA shot analysis", () => {
  const makeSample = (overrides: Partial<any> = {}) => ({
    time: 0, targetTemp: 93, currentTemp: 92, targetPressure: 9,
    currentPressure: 8.5, flow: 2.0, targetFlow: 2.0, puckFlow: 1.8,
    volumetricFlow: 1.8, weight: 0, estimatedWeight: 0,
    puckResistance: 4.5, systemInfo: 0, ...overrides,
  });

  const makeShot = (overrides: Partial<ShotData> = {}): ShotData => ({
    header: {
      magic: 0x544f4853, version: 5, headerSize: 512,
      sampleInterval: 250, fieldsMask: 0x1fff,
      sampleCount: 10, duration: 2500, timestamp: 1711987200,
      profileId: "test-profile", profileName: "Test Profile",
      finalWeight: 36, phaseTransitions: [
        { sampleIndex: 0, phaseNumber: 0, phaseName: "Preinfusion" },
        { sampleIndex: 4, phaseNumber: 1, phaseName: "Brew" },
      ],
    },
    samples: [
      // Preinfusion: 4 samples (1s) at low pressure
      makeSample({ time: 0, currentPressure: 3, weight: 0 }),
      makeSample({ time: 250, currentPressure: 3.2, weight: 0 }),
      makeSample({ time: 500, currentPressure: 3.1, weight: 0.5 }),
      makeSample({ time: 750, currentPressure: 3.0, weight: 1.0 }),
      // Brew: 6 samples (1.5s) at high pressure
      makeSample({ time: 1000, currentPressure: 9.0, weight: 2 }),
      makeSample({ time: 1250, currentPressure: 9.1, weight: 8 }),
      makeSample({ time: 1500, currentPressure: 9.0, weight: 15 }),
      makeSample({ time: 1750, currentPressure: 8.9, weight: 22 }),
      makeSample({ time: 2000, currentPressure: 8.8, weight: 29 }),
      makeSample({ time: 2250, currentPressure: 8.7, weight: 36 }),
    ],
    ...overrides,
  });

  it("returns per-phase analysis with pressure stats", () => {
    const result = analyzeShotData(makeShot());
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0].name).toBe("Preinfusion");
    expect(result.phases[1].name).toBe("Brew");
    expect(result.phases[0].pressure.avg).toBeCloseTo(3.075, 1);
    expect(result.phases[1].pressure.avg).toBeGreaterThan(8.5);
  });

  it("computes puck resistance stats", () => {
    const result = analyzeShotData(makeShot());
    expect(result.avgPuckResistance).toBeGreaterThan(0);
    expect(result.peakPuckResistance).toBeGreaterThanOrEqual(result.avgPuckResistance!);
  });

  it("generates human-readable phase summary", () => {
    const result = analyzeShotData(makeShot());
    expect(result.phaseSummary).toContain("Preinfusion");
    expect(result.phaseSummary).toContain("Brew");
    expect(result.phaseSummary).toContain("→");
  });

  it("handles shots with no phase transitions", () => {
    const shot = makeShot();
    shot.header.phaseTransitions = [];
    const result = analyzeShotData(shot);
    expect(result.phases).toHaveLength(1); // Single unnamed phase
  });

  it("detects brew-by-weight mode from system info", () => {
    const shot = makeShot();
    // Set volumetric flag (bit 0 of systemInfo)
    shot.samples.forEach(s => (s as any).systemInfo = 1);
    const result = analyzeShotData(shot);
    expect(result.isBrewByWeight).toBe(true);
  });
});
```

**Step 3: Run tests — FAIL**

Run: `npm test -- tests/analysis/shotAnalysis.test.ts`

**Step 4: Implement shot analysis**

Create `src/analysis/shotAnalysis.ts`. Port the core logic from GaggiMate's `AnalyzerService.js` (~1007 lines of JS). Key functions to port:

- `getMetricStats(samples, key)` — time-weighted min/max/avg
- `getRegressionWeightRate(samples)` — linear regression over 4s window for g/s flow rate
- `detectExitReason(phase, nextPhaseSamples)` — why phase ended
- `analyzeShotData(shot)` — main entry point, splits by phase transitions, computes per-phase + global stats

The GaggiMate source uses sample field keys `cp` (current pressure), `fl` (flow), `ct` (current temp), `v` (weight), `pf` (puck flow), `vf` (volumetric flow), `pr` (puck resistance). Our `ShotData.samples` uses full names (`currentPressure`, `flow`, `currentTemp`, `weight`, `puckFlow`, `volumetricFlow`, `puckResistance`). Map between them.

Reference: `AnalyzerService.js` from `jniebuhr/gaggimate` repo, branch `master`, path `web/src/pages/ShotAnalyzer/services/AnalyzerService.js`.

Constants from upstream:
```typescript
const PREDICTIVE_WINDOW_MS = 4000;
const LAST_PHASE_UNDERSHOOT_MIN_G = 2;
const LAST_PHASE_UNDERSHOOT_MAX_G = 6;
const LAST_PHASE_OVERSHOOT_MAX_G = 4;
```

**Step 5: Run tests — PASS**

Run: `npm test -- tests/analysis/shotAnalysis.test.ts`

**Step 6: Run full suite**

Run: `npm test`

**Step 7: Commit**

```bash
git add src/analysis/ tests/analysis/
git commit -m "feat: port DDSA shot analysis engine from GaggiMate web UI"
```

---

## Task 5: Enhanced Notion Properties

Add DDSA analysis fields and shot notes fields to the Notion brew mapper.

**Files:**
- Modify: `src/notion/types.ts` (add new BrewData fields)
- Modify: `src/notion/mappers.ts` (map analysis + notes to properties)
- Modify: `src/notion/client.ts` (include new properties in create/update)
- Modify: `tests/notion/mappers.test.ts` (test new mappings)

**Step 1: Write failing test**

```typescript
// Add to tests/notion/mappers.test.ts
describe("DDSA and shot notes mapping", () => {
  it("maps shot notes to Notion properties", () => {
    const brewData = {
      // ... existing fields ...
      doseIn: 18.0,
      doseOut: 36.2,
      ratio: "1:2.0",
      grindSetting: "14",
      beanType: "Ethiopian",
      tasteBal: "balanced",
      avgPuckResistance: 4.5,
      peakPuckResistance: 6.2,
      weightFlowRate: 2.1,
      phaseSummary: "Preinfusion: 8s @ 3 bar → Brew: 24s @ 9 bar",
      exitReason: "Weight Stop at 36g",
    };
    const props = brewDataToNotionProperties(brewData as any);
    expect(props["Dose In"]).toEqual({ number: 18.0 });
    expect(props["Dose Out"]).toEqual({ number: 36.2 });
    expect(props["Grind Setting"]).toBeDefined();
    expect(props["Avg Puck Resistance"]).toEqual({ number: 4.5 });
    expect(props["Exit Reason"]).toBeDefined();
  });
});
```

**Step 2: Run test — FAIL**

**Step 3: Extend BrewData interface and mapper**

In `src/notion/types.ts`, add to `BrewData`:
```typescript
doseIn?: number;
doseOut?: number;
ratio?: string;
grindSetting?: string;
beanType?: string;
tasteBal?: string;
avgPuckResistance?: number;
peakPuckResistance?: number;
weightFlowRate?: number;
phaseSummary?: string;
exitReason?: string;
```

In `src/notion/mappers.ts`, add property mappings in `brewDataToNotionProperties()`:
```typescript
if (data.doseIn != null) props["Dose In"] = { number: data.doseIn };
if (data.doseOut != null) props["Dose Out"] = { number: data.doseOut };
if (data.ratio) props["Ratio"] = { rich_text: [{ text: { content: data.ratio } }] };
if (data.grindSetting) props["Grind Setting"] = { rich_text: [{ text: { content: data.grindSetting } }] };
if (data.beanType) props["Bean Type"] = { rich_text: [{ text: { content: data.beanType } }] };
if (data.tasteBal) props["Taste Balance"] = { select: { name: data.tasteBal } };
if (data.avgPuckResistance != null) props["Avg Puck Resistance"] = { number: round(data.avgPuckResistance, 1) };
if (data.peakPuckResistance != null) props["Peak Puck Resistance"] = { number: round(data.peakPuckResistance, 1) };
if (data.weightFlowRate != null) props["Weight Flow Rate"] = { number: round(data.weightFlowRate, 1) };
if (data.phaseSummary) props["Phase Summary"] = { rich_text: [{ text: { content: data.phaseSummary } }] };
if (data.exitReason) props["Exit Reason"] = { rich_text: [{ text: { content: data.exitReason } }] };
```

**Step 4: Run tests — PASS**

Run: `npm test`

**Step 5: Commit**

```bash
git add src/notion/types.ts src/notion/mappers.ts tests/notion/mappers.test.ts
git commit -m "feat: add DDSA analysis and shot notes properties to Notion mapper"
```

---

## Task 6: Wire Analysis + Notes Into Shot Poller

Connect the DDSA analysis engine and shot notes fetching into the shot sync flow.

**Files:**
- Modify: `src/sync/shotPoller.ts:363-525` (per-shot processing)
- Modify: `src/notion/mappers.ts` (extend shotToBrewData to accept analysis + notes)
- Modify: `tests/sync/shotPoller.test.ts`

**Step 1: Write failing test**

```typescript
// Add to tests/sync/shotPoller.test.ts
it("fetches shot notes and runs DDSA analysis during sync", async () => {
  // Mock fetchShotNotes to return notes
  mockGaggimate.fetchShotNotes = vi.fn().mockResolvedValue({
    doseIn: 18.0, doseOut: 36.0, grindSetting: "14",
  });

  // Trigger sync and verify notes were fetched
  await poller.poll();

  expect(mockGaggimate.fetchShotNotes).toHaveBeenCalled();
});
```

**Step 2: Run test — FAIL**

**Step 3: Integrate into shot poller**

In `src/sync/shotPoller.ts`, modify the per-shot handler (~line 396):

```typescript
// Existing: fetch shot data + check Notion (parallel)
const [shotData, existingBrew] = await Promise.all([...]);

// NEW: fetch shot notes in parallel with transform
const [transformed, shotNotes] = await Promise.all([
  transformShotForAI(shotData, true),
  this.gaggimate.fetchShotNotes(numericId).catch(() => null),
]);

// NEW: run DDSA analysis
const analysis = analyzeShotData(shotData);

// Map to brew data with analysis + notes
const brewData = shotToBrewData(shotData, transformed, { analysis, shotNotes });
```

**Step 4: Run tests — PASS**

Run: `npm test`

**Step 5: Commit**

```bash
git add src/sync/shotPoller.ts src/notion/mappers.ts tests/sync/shotPoller.test.ts
git commit -m "feat: integrate DDSA analysis and shot notes into shot sync flow"
```

---

## Task 7: MCP Server Foundation

Add MCP server with Streamable HTTP transport mounted on the existing Express app.

**Files:**
- Create: `src/mcp/server.ts`
- Modify: `src/http/server.ts` (mount MCP routes)
- Modify: `src/index.ts` (pass dependencies to MCP)
- Modify: `package.json` (add @modelcontextprotocol/sdk, zod)
- Create: `tests/mcp/server.test.ts`

**Step 1: Install dependencies**

```bash
npm install @modelcontextprotocol/sdk zod
```

**Step 2: Write failing test for MCP endpoint**

```typescript
// tests/mcp/server.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import { mountMcpRoutes } from "../../src/mcp/server.js";

describe("MCP server", () => {
  it("responds to POST /mcp with initialize", async () => {
    const app = express();
    app.use(express.json());

    const mockGaggimate = {} as any;
    const mockNotion = {} as any;
    mountMcpRoutes(app, mockGaggimate, mockNotion);

    // The /mcp endpoint should exist
    const routes = app._router.stack
      .filter((r: any) => r.route)
      .map((r: any) => ({ path: r.route.path, methods: r.route.methods }));

    const mcpPost = routes.find(
      (r: any) => r.path === "/mcp" && r.methods.post
    );
    expect(mcpPost).toBeDefined();
  });
});
```

**Step 3: Run test — FAIL**

**Step 4: Create MCP server module**

```typescript
// src/mcp/server.ts
import { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { GaggiMateClient } from "../gaggimate/client.js";
import type { NotionClient } from "../notion/client.js";
import { registerTools } from "./tools.js";

const transports: Record<string, StreamableHTTPServerTransport> = {};

function createMcpServer(
  gaggimate: GaggiMateClient,
  notion: NotionClient
): McpServer {
  const server = new McpServer(
    { name: "gaggimate-bridge", version: "2.0.0" },
    { capabilities: { logging: {} } }
  );
  registerTools(server, gaggimate, notion);
  return server;
}

export function mountMcpRoutes(
  app: Express,
  gaggimate: GaggiMateClient,
  notion: NotionClient
): void {
  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    try {
      if (sessionId && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res, req.body);
        return;
      }
      if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => { transports[sid] = transport; },
        });
        transport.onclose = () => {
          if (transport.sessionId) delete transports[transport.sessionId];
        };
        const server = createMcpServer(gaggimate, notion);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session" },
        id: null,
      });
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Missing or invalid session");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Missing or invalid session");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });
}
```

**Step 5: Create stub tools module**

```typescript
// src/mcp/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GaggiMateClient } from "../gaggimate/client.js";
import type { NotionClient } from "../notion/client.js";

export function registerTools(
  server: McpServer,
  gaggimate: GaggiMateClient,
  notion: NotionClient
): void {
  // Tools registered in subsequent tasks
}
```

**Step 6: Mount in Express app**

In `src/http/server.ts`, add:
```typescript
import { mountMcpRoutes } from "../mcp/server.js";
// ... in createServer():
mountMcpRoutes(app, gaggimate, notion);
```

**Step 7: Run tests — PASS**

Run: `npm test`

**Step 8: Commit**

```bash
git add src/mcp/ src/http/server.ts package.json package-lock.json
git commit -m "feat: add MCP server foundation with Streamable HTTP transport"
```

---

## Task 8: MCP Tools — Brew Queries

Implement the brew-related MCP tools: `get_recent_brews`, `get_brew_detail`, `compare_shots`, `get_brew_trends`.

**Files:**
- Modify: `src/mcp/tools.ts`
- Create: `tests/mcp/brewTools.test.ts`

**Step 1: Write failing tests**

```typescript
// tests/mcp/brewTools.test.ts
import { describe, it, expect, vi } from "vitest";
// Test that tool registration works and returns expected shapes

describe("brew MCP tools", () => {
  it("get_recent_brews returns formatted brew list", async () => {
    // Test the underlying query function, not the MCP wrapper
    // Verify it calls notion.queryRecentBrews and formats response
  });

  it("compare_shots returns side-by-side comparison", async () => {
    // Test with two shot IDs, verify diff format
  });
});
```

**Step 2: Implement brew tools**

In `src/mcp/tools.ts`, register tools using the v1.x SDK pattern:

```typescript
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function registerTools(server, gaggimate, notion) {
  server.registerTool("get_recent_brews", {
    description: "Get recent brews from the Notion database",
    inputSchema: {
      count: z.number().optional().describe("Number of brews to fetch (default 10)"),
    },
  }, async ({ count }): Promise<CallToolResult> => {
    const brews = await notion.queryRecentBrews(count ?? 10);
    return { content: [{ type: "text", text: JSON.stringify(brews, null, 2) }] };
  });

  server.registerTool("get_brew_detail", {
    description: "Get full details for a specific brew including shot analysis and curve data",
    inputSchema: {
      shotId: z.string().describe("The shot/activity ID"),
    },
  }, async ({ shotId }): Promise<CallToolResult> => {
    const brew = await notion.queryBrewByActivityId(shotId);
    if (!brew) return { content: [{ type: "text", text: "Brew not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(brew, null, 2) }] };
  });

  // ... compare_shots, get_brew_trends
}
```

Note: The `notion.queryRecentBrews()` method may need to be added to `src/notion/client.ts`. This should query the Brews database sorted by date descending with a limit.

**Step 3: Run tests — PASS**

**Step 4: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/brewTools.test.ts src/notion/client.ts
git commit -m "feat: add brew query MCP tools (get_recent_brews, get_brew_detail, compare_shots, get_brew_trends)"
```

---

## Task 9: MCP Tools — Profile Management

Implement profile MCP tools: `list_profiles`, `push_profile`, `archive_profile`.

**Files:**
- Modify: `src/mcp/tools.ts`
- Create: `tests/mcp/profileTools.test.ts`

**Step 1: Write failing tests**

**Step 2: Implement profile tools**

```typescript
server.registerTool("list_profiles", {
  description: "List all profiles from the device and Notion",
  inputSchema: {
    source: z.enum(["device", "notion", "both"]).optional().describe("Where to list from (default both)"),
  },
}, async ({ source }): Promise<CallToolResult> => {
  const results: any = {};
  if (source !== "notion") results.device = await gaggimate.fetchProfiles();
  if (source !== "device") results.notion = await notion.queryProfiles();
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
});

server.registerTool("push_profile", {
  description: "Create or update a profile and push it to the device. Provide the full profile JSON.",
  inputSchema: {
    profile: z.object({
      label: z.string(),
      temperature: z.number().min(60).max(100),
      phases: z.array(z.any()).min(1).max(20),
    }).passthrough().describe("Profile JSON to push"),
  },
}, async ({ profile }): Promise<CallToolResult> => {
  const result = await gaggimate.saveProfile(profile);
  return { content: [{ type: "text", text: `Profile "${profile.label}" pushed. ${JSON.stringify(result)}` }] };
});

server.registerTool("archive_profile", {
  description: "Archive a profile in Notion and delete it from the device",
  inputSchema: {
    profileId: z.string().describe("Profile ID to archive"),
  },
}, async ({ profileId }): Promise<CallToolResult> => {
  await gaggimate.deleteProfile(profileId);
  // Also update Notion status to Archived
  return { content: [{ type: "text", text: `Profile ${profileId} archived` }] };
});
```

**Step 3: Run tests — PASS**

**Step 4: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/profileTools.test.ts
git commit -m "feat: add profile management MCP tools"
```

---

## Task 10: MCP Tools — Device Status, Shot Analysis, Shot Notes

Implement remaining tools: `get_device_status`, `analyze_shot`, `get_shot_notes`, `save_shot_notes`.

**Files:**
- Modify: `src/mcp/tools.ts`
- Create: `tests/mcp/deviceTools.test.ts`

**Step 1: Implement tools**

```typescript
server.registerTool("get_device_status", {
  description: "Get current GaggiMate device status — connectivity, selected profile, brew state",
  inputSchema: {},
}, async (): Promise<CallToolResult> => {
  const reachable = await gaggimate.isReachable();
  const diag = gaggimate.getConnectionDiagnostics();
  return { content: [{ type: "text", text: JSON.stringify({ reachable, ...diag }, null, 2) }] };
});

server.registerTool("analyze_shot", {
  description: "Run DDSA analysis on a specific shot — per-phase metrics, puck resistance, exit reasons, weight flow rate",
  inputSchema: {
    shotId: z.number().describe("Shot ID to analyze"),
  },
}, async ({ shotId }): Promise<CallToolResult> => {
  const shotData = await gaggimate.fetchShot(shotId);
  if (!shotData) return { content: [{ type: "text", text: "Shot not found" }], isError: true };
  const analysis = analyzeShotData(shotData);
  return { content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }] };
});

server.registerTool("get_shot_notes", {
  description: "Get shot notes from device — dose in/out, grind setting, rating, taste balance",
  inputSchema: {
    shotId: z.number().describe("Shot ID"),
  },
}, async ({ shotId }): Promise<CallToolResult> => {
  const notes = await gaggimate.fetchShotNotes(shotId);
  if (!notes) return { content: [{ type: "text", text: "No notes for this shot" }] };
  return { content: [{ type: "text", text: JSON.stringify(notes, null, 2) }] };
});

server.registerTool("save_shot_notes", {
  description: "Save shot notes to device — dose in/out, grind setting, rating, taste balance, free text notes",
  inputSchema: {
    shotId: z.number().describe("Shot ID"),
    notes: z.object({
      rating: z.number().min(0).max(5).optional(),
      beanType: z.string().optional(),
      doseIn: z.number().optional(),
      doseOut: z.number().optional(),
      grindSetting: z.string().optional(),
      balanceTaste: z.enum(["bitter", "balanced", "sour"]).optional(),
      notes: z.string().optional(),
    }).describe("Notes to save"),
  },
}, async ({ shotId, notes }): Promise<CallToolResult> => {
  await gaggimate.saveShotNotes(shotId, notes);
  return { content: [{ type: "text", text: `Notes saved for shot ${shotId}` }] };
});
```

Note: `gaggimate.saveShotNotes()` needs to be added to `src/gaggimate/client.ts` — sends `req:history:notes:save` via WebSocket.

**Step 2: Run tests — PASS**

**Step 3: Commit**

```bash
git add src/mcp/tools.ts src/gaggimate/client.ts tests/mcp/deviceTools.test.ts
git commit -m "feat: add device status, shot analysis, and shot notes MCP tools"
```

---

## Task 11: MCP Resources

Add MCP resources for passive context Claude can pull in.

**Files:**
- Create: `src/mcp/resources.ts`
- Modify: `src/mcp/server.ts` (register resources)

**Step 1: Implement resources**

```typescript
// src/mcp/resources.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerResources(server: McpServer, gaggimate: any, notion: any): void {
  server.resource("recent-brews", "gaggimate://brews/recent", async (uri) => {
    const brews = await notion.queryRecentBrews(10);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(brews) }] };
  });

  server.resource("active-profiles", "gaggimate://profiles/active", async (uri) => {
    const profiles = await gaggimate.fetchProfiles();
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(profiles) }] };
  });

  server.resource("device-status", "gaggimate://device/status", async (uri) => {
    const reachable = await gaggimate.isReachable();
    const diag = gaggimate.getConnectionDiagnostics();
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ reachable, ...diag }) }] };
  });
}
```

**Step 2: Wire into server.ts**

Add `registerResources(server, gaggimate, notion)` call in `createMcpServer()`.

**Step 3: Run tests — PASS**

**Step 4: Commit**

```bash
git add src/mcp/resources.ts src/mcp/server.ts
git commit -m "feat: add MCP resources for brews, profiles, and device status"
```

---

## Task 12: Enhanced Debug Endpoints

Add `/logs` and `/status` endpoints for remote debugging without SSH.

**Files:**
- Create: `src/http/routes/logs.ts`
- Create: `src/http/routes/status.ts`
- Modify: `src/http/server.ts` (mount routes)
- Create: `tests/http/logsRoute.test.ts`
- Create: `tests/http/statusRoute.test.ts`

**Step 1: Implement in-memory log ring buffer**

```typescript
// src/utils/logBuffer.ts
const MAX_LOG_LINES = 500;
const logBuffer: string[] = [];

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function capture(level: string, args: any[]): void {
  const line = `${new Date().toISOString()} [${level}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}`;
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
}

console.log = (...args) => { capture("INFO", args); originalLog(...args); };
console.error = (...args) => { capture("ERROR", args); originalError(...args); };
console.warn = (...args) => { capture("WARN", args); originalWarn(...args); };

export function getRecentLogs(count: number = 100): string[] {
  return logBuffer.slice(-count);
}
```

**Step 2: Implement /logs endpoint**

```typescript
// src/http/routes/logs.ts
import { Router } from "express";
import { getRecentLogs } from "../../utils/logBuffer.js";

export function createLogsRouter(): Router {
  const router = Router();
  router.get("/", (req, res) => {
    const count = parseInt(req.query.count as string) || 100;
    const logs = getRecentLogs(count);
    res.type("text/plain").send(logs.join("\n"));
  });
  return router;
}
```

**Step 3: Implement /status endpoint**

```typescript
// src/http/routes/status.ts
import { Router } from "express";

export function createStatusRouter(gaggimate: any, notion: any, shotPoller: any): Router {
  const router = Router();
  router.get("/", async (req, res) => {
    const [reachable, notionOk] = await Promise.allSettled([
      gaggimate.isReachable(),
      notion.getMe(),
    ]);
    const state = shotPoller.getState();
    res.json({
      gaggimate: {
        reachable: reachable.status === "fulfilled" && reachable.value,
        diagnostics: gaggimate.getConnectionDiagnostics(),
      },
      notion: {
        connected: notionOk.status === "fulfilled",
      },
      sync: {
        lastShotId: state.lastSyncedShotId,
        lastSyncTime: state.lastSyncTime,
        totalSynced: state.totalShotsSynced,
        eventDriven: true,
        fallbackPollIntervalMs: state.syncIntervalMs,
      },
      uptime: process.uptime(),
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
  });
  return router;
}
```

**Step 4: Mount routes in server.ts**

**Step 5: Run tests — PASS**

**Step 6: Commit**

```bash
git add src/utils/logBuffer.ts src/http/routes/logs.ts src/http/routes/status.ts src/http/server.ts tests/http/
git commit -m "feat: add /logs and /status debug endpoints"
```

---

## Task 13: GitHub Actions CI/CD

Update the existing CI workflow to build and push Docker images on every push to main.

**Files:**
- Modify: `.github/workflows/ci.yml`

The existing CI already builds, tests, and pushes to GHCR. Verify it's working correctly and add any missing pieces (e.g., Watchtower-compatible tags).

**Step 1: Review existing workflow**

Read `.github/workflows/ci.yml` and verify:
- Build + test runs on push to main
- Docker image pushed to `ghcr.io/graphite-productions/gaggimate-bridge:latest`
- Image tagged with commit SHA for rollback

**Step 2: Add Watchtower compatibility**

Ensure the `latest` tag is always updated (Watchtower watches this tag). The existing workflow likely already does this.

**Step 3: Commit any changes**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: ensure Watchtower-compatible latest tag on Docker image"
```

---

## Task 14: TrueNAS Deployment Docs

Write setup documentation for one-time TrueNAS deployment with Watchtower.

**Files:**
- Modify: `docs/SETUP.md` (add TrueNAS + Watchtower section)

**Step 1: Add deployment section**

Include:
- Enable SSH on TrueNAS (UI path)
- Docker compose with bridge + Watchtower
- `.env` template
- Verify with `curl truenas:3000/health`
- Claude Code MCP config for Mac

**Step 2: Watchtower compose addition**

```yaml
services:
  gaggimate-bridge:
    image: ghcr.io/graphite-productions/gaggimate-bridge:latest
    ports:
      - "3000:3000"
    env_file: .env
    volumes:
      - ./data:/app/data
    restart: unless-stopped

  watchtower:
    image: containrrr/watchtower
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --interval 300 --cleanup gaggimate-bridge
    restart: unless-stopped
```

**Step 3: Commit**

```bash
git add docs/SETUP.md docker-compose.yml
git commit -m "docs: add TrueNAS deployment guide with Watchtower auto-updates"
```

---

## Task 15: Update CLAUDE.md

Update the project CLAUDE.md to reflect the v2 architecture.

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update sections**

- Add MCP server section (tools, resources, transport)
- Add DDSA analysis section
- Update shot sync description (event-driven)
- Add new env vars
- Add deployment section (Watchtower)
- Add debug endpoints

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for v2 architecture"
```

---

## Execution Order & Dependencies

```
Task 1 (WS events) ─────────► Task 2 (event-driven poller)
                                        │
Task 3 (shot notes) ────────────────────┤
                                        │
Task 4 (DDSA engine) ──► Task 5 (Notion props) ──► Task 6 (wire into poller)
                                        │
Task 7 (MCP foundation) ──► Task 8 (brew tools) ──► Task 9 (profile tools) ──► Task 10 (device tools) ──► Task 11 (resources)
                                        │
Task 12 (debug endpoints) ──────────────┘
                                        │
Task 13 (CI/CD) ────────────────────────┤
Task 14 (TrueNAS docs) ────────────────┤
Task 15 (CLAUDE.md) ───────────────────┘
```

**Parallelizable groups:**
- Tasks 1, 3, 4, 7 can all start independently
- Tasks 12, 13 can start anytime
- Tasks 2, 5, 6 depend on their predecessors
- Tasks 8-11 are sequential (building on MCP foundation)
- Tasks 14-15 should be last (document final state)
