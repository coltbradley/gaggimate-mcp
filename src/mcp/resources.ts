import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GaggiMateClient } from "../gaggimate/client.js";
import type { NotionClient } from "../notion/client.js";

export function registerResources(
  server: McpServer,
  gaggimate: GaggiMateClient,
  notion: NotionClient,
): void {
  server.resource("recent-brews", "gaggimate://brews/recent", async (uri) => {
    const brews = await notion.queryRecentBrews(10);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(brews, null, 2),
        },
      ],
    };
  });

  server.resource("active-profiles", "gaggimate://profiles/active", async (uri) => {
    const profiles = await gaggimate.fetchProfiles();
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(profiles, null, 2),
        },
      ],
    };
  });

  server.resource("device-status", "gaggimate://device/status", async (uri) => {
    const reachable = await gaggimate.isReachable();
    const diag = gaggimate.getConnectionDiagnostics();
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ reachable, ...diag }, null, 2),
        },
      ],
    };
  });
}
