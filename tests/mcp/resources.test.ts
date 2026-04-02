import { describe, it, expect, vi } from "vitest";
import { registerResources } from "../../src/mcp/resources.js";

function makeMockServer() {
  const registeredResources: Array<{ name: string; uri: string }> = [];
  const handlers: Record<string, (uri: URL) => Promise<any>> = {};

  return {
    resource: vi.fn(
      (name: string, uri: string, handler: (uri: URL) => Promise<any>) => {
        registeredResources.push({ name, uri });
        handlers[name] = handler;
      },
    ),
    registeredResources,
    handlers,
  };
}

function makeMockGaggimate() {
  return {
    fetchProfiles: vi.fn().mockResolvedValue([{ id: "prof-1", label: "Espresso" }]),
    isReachable: vi.fn().mockResolvedValue(true),
    getConnectionDiagnostics: vi.fn().mockReturnValue({
      wsQueueDepth: 0,
      wsPendingResponses: 0,
      wsState: "none",
    }),
  };
}

function makeMockNotion() {
  return {
    queryRecentBrews: vi.fn().mockResolvedValue([{ id: "brew-1" }, { id: "brew-2" }]),
  };
}

describe("registerResources", () => {
  it("registers exactly 3 resources", () => {
    const server = makeMockServer();
    registerResources(server as any, makeMockGaggimate() as any, makeMockNotion() as any);
    expect(server.registeredResources).toHaveLength(3);
  });

  it("registers resources with correct names and URIs", () => {
    const server = makeMockServer();
    registerResources(server as any, makeMockGaggimate() as any, makeMockNotion() as any);

    const names = server.registeredResources.map((r) => r.name);
    expect(names).toContain("recent-brews");
    expect(names).toContain("active-profiles");
    expect(names).toContain("device-status");

    const uris = server.registeredResources.map((r) => r.uri);
    expect(uris).toContain("gaggimate://brews/recent");
    expect(uris).toContain("gaggimate://profiles/active");
    expect(uris).toContain("gaggimate://device/status");
  });
});

describe("recent-brews resource", () => {
  it("calls queryRecentBrews(10) and returns JSON contents", async () => {
    const server = makeMockServer();
    const notion = makeMockNotion();
    registerResources(server as any, makeMockGaggimate() as any, notion as any);

    const uri = new URL("gaggimate://brews/recent");
    const result = await server.handlers["recent-brews"](uri);

    expect(notion.queryRecentBrews).toHaveBeenCalledWith(10);
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].mimeType).toBe("application/json");
    expect(result.contents[0].uri).toBe("gaggimate://brews/recent");

    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("brew-1");
  });
});

describe("active-profiles resource", () => {
  it("calls fetchProfiles and returns JSON contents", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    registerResources(server as any, gaggimate as any, makeMockNotion() as any);

    const uri = new URL("gaggimate://profiles/active");
    const result = await server.handlers["active-profiles"](uri);

    expect(gaggimate.fetchProfiles).toHaveBeenCalledOnce();
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].mimeType).toBe("application/json");
    expect(result.contents[0].uri).toBe("gaggimate://profiles/active");

    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe("Espresso");
  });
});

describe("device-status resource", () => {
  it("calls isReachable and getConnectionDiagnostics and returns JSON contents", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    registerResources(server as any, gaggimate as any, makeMockNotion() as any);

    const uri = new URL("gaggimate://device/status");
    const result = await server.handlers["device-status"](uri);

    expect(gaggimate.isReachable).toHaveBeenCalledOnce();
    expect(gaggimate.getConnectionDiagnostics).toHaveBeenCalledOnce();
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].mimeType).toBe("application/json");
    expect(result.contents[0].uri).toBe("gaggimate://device/status");

    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.reachable).toBe(true);
    expect(parsed.wsState).toBe("none");
    expect(parsed.wsQueueDepth).toBe(0);
  });

  it("reflects unreachable device", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    gaggimate.isReachable.mockResolvedValue(false);
    registerResources(server as any, gaggimate as any, makeMockNotion() as any);

    const uri = new URL("gaggimate://device/status");
    const result = await server.handlers["device-status"](uri);
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.reachable).toBe(false);
  });
});
