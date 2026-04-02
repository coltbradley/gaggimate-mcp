import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GaggiMateClient } from "../gaggimate/client.js";
import type { NotionClient } from "../notion/client.js";
import { analyzeShotData } from "../analysis/shotAnalysis.js";

export function registerTools(
  server: McpServer,
  gaggimate: GaggiMateClient,
  notion: NotionClient,
): void {
  // ─── Brew Query Tools ─────────────────────────────────────

  server.registerTool(
    "get_recent_brews",
    {
      description: "Get recent brews from the Notion database with all metrics",
      inputSchema: {
        count: z.number().optional().describe("Number of brews to fetch (default 10, max 50)"),
      },
    },
    async ({ count }) => {
      const brews = await notion.queryRecentBrews(count ?? 10);
      return { content: [{ type: "text", text: JSON.stringify(brews, null, 2) }] };
    },
  );

  server.registerTool(
    "get_brew_detail",
    {
      description: "Get full details for a specific brew including shot analysis data",
      inputSchema: {
        shotId: z.string().describe("The shot/activity ID (e.g. '047')"),
      },
    },
    async ({ shotId }) => {
      const brew = await notion.queryBrewByActivityId(shotId);
      if (!brew) {
        return {
          content: [{ type: "text", text: `No brew found with shot ID ${shotId}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(brew, null, 2) }] };
    },
  );

  server.registerTool(
    "compare_shots",
    {
      description: "Compare two brews side-by-side for dialing in",
      inputSchema: {
        shotId1: z.string().describe("First shot ID"),
        shotId2: z.string().describe("Second shot ID"),
      },
    },
    async ({ shotId1, shotId2 }) => {
      const [brew1, brew2] = await Promise.all([
        notion.queryBrewByActivityId(shotId1),
        notion.queryBrewByActivityId(shotId2),
      ]);
      if (!brew1 || !brew2) {
        return {
          content: [{ type: "text", text: "One or both brews not found" }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ shot1: brew1, shot2: brew2 }, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_brew_trends",
    {
      description: "Get brew trends over recent shots — extraction times, weights, temperatures",
      inputSchema: {
        count: z.number().optional().describe("Number of recent brews to analyze (default 20)"),
      },
    },
    async ({ count }) => {
      const brews = await notion.queryRecentBrews(count ?? 20);
      return { content: [{ type: "text", text: JSON.stringify(brews, null, 2) }] };
    },
  );

  // ─── Profile Management Tools ─────────────────────────────

  server.registerTool(
    "list_profiles",
    {
      description: "List all profiles from the device and/or Notion",
      inputSchema: {
        source: z
          .enum(["device", "notion", "both"])
          .optional()
          .describe("Where to list from (default 'both')"),
      },
    },
    async ({ source }) => {
      const results: Record<string, unknown> = {};
      const src = source ?? "both";
      if (src !== "notion") results.device = await gaggimate.fetchProfiles();
      if (src !== "device") results.notion = await notion.queryProfiles();
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  );

  server.registerTool(
    "push_profile",
    {
      description: "Save a profile to the GaggiMate device",
      inputSchema: {
        profile: z
          .record(z.string(), z.any())
          .describe("Full profile JSON object with label, temperature, phases"),
      },
    },
    async ({ profile }) => {
      const result = await gaggimate.saveProfile(profile as any);
      return {
        content: [{ type: "text", text: `Profile saved. Response: ${JSON.stringify(result)}` }],
      };
    },
  );

  server.registerTool(
    "archive_profile",
    {
      description: "Delete a profile from the GaggiMate device",
      inputSchema: {
        profileId: z.string().describe("Profile ID to delete from device"),
      },
    },
    async ({ profileId }) => {
      await gaggimate.deleteProfile(profileId);
      return {
        content: [{ type: "text", text: `Profile ${profileId} deleted from device` }],
      };
    },
  );

  // ─── Device & Analysis Tools ──────────────────────────────

  server.registerTool(
    "get_device_status",
    {
      description: "Get GaggiMate device status — connectivity, WebSocket state",
      inputSchema: {},
    },
    async () => {
      const reachable = await gaggimate.isReachable();
      const diag = gaggimate.getConnectionDiagnostics();
      return {
        content: [{ type: "text", text: JSON.stringify({ reachable, ...diag }, null, 2) }],
      };
    },
  );

  server.registerTool(
    "analyze_shot",
    {
      description:
        "Run detailed DDSA analysis on a shot — per-phase metrics, puck resistance, exit reasons",
      inputSchema: {
        shotId: z.number().describe("Numeric shot ID to analyze"),
      },
    },
    async ({ shotId }) => {
      const shotData = await gaggimate.fetchShot(String(shotId));
      if (!shotData) {
        return {
          content: [{ type: "text", text: `Shot ${shotId} not found on device` }],
          isError: true,
        };
      }
      const analysis = analyzeShotData(shotData);
      return { content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }] };
    },
  );

  server.registerTool(
    "get_shot_notes",
    {
      description: "Get shot notes from device — dose, grind, rating, taste balance",
      inputSchema: {
        shotId: z.number().describe("Numeric shot ID"),
      },
    },
    async ({ shotId }) => {
      const notes = await gaggimate.fetchShotNotes(shotId);
      if (!notes) {
        return { content: [{ type: "text", text: `No notes for shot ${shotId}` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(notes, null, 2) }] };
    },
  );

  server.registerTool(
    "save_shot_notes",
    {
      description: "Save shot notes to device — dose, grind, rating, taste, free text",
      inputSchema: {
        shotId: z.number().describe("Numeric shot ID"),
        rating: z.number().min(0).max(5).optional().describe("Rating 0-5"),
        beanType: z.string().optional().describe("Bean type/name"),
        doseIn: z.number().optional().describe("Dose in grams"),
        doseOut: z.number().optional().describe("Yield/dose out grams"),
        grindSetting: z.string().optional().describe("Grind setting"),
        balanceTaste: z
          .enum(["bitter", "balanced", "sour"])
          .optional()
          .describe("Taste balance"),
        notes: z.string().optional().describe("Free text notes"),
      },
    },
    async ({ shotId, ...noteFields }) => {
      await gaggimate.saveShotNotes(shotId, noteFields);
      return { content: [{ type: "text", text: `Notes saved for shot ${shotId}` }] };
    },
  );
}
