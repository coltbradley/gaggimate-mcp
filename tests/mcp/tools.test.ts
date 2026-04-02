import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

// Minimal McpServer mock that records registerTool calls
function makeMockServer() {
  const registeredTools: string[] = [];
  const handlers: Record<string, (args: any) => Promise<any>> = {};

  return {
    registerTool: vi.fn((name: string, _config: any, handler: (args: any) => Promise<any>) => {
      registeredTools.push(name);
      handlers[name] = handler;
    }),
    registeredTools,
    handlers,
  };
}

function makeMockGaggimate() {
  return {
    fetchProfiles: vi.fn().mockResolvedValue([]),
    saveProfile: vi.fn().mockResolvedValue({ success: true }),
    deleteProfile: vi.fn().mockResolvedValue(undefined),
    isReachable: vi.fn().mockResolvedValue(true),
    getConnectionDiagnostics: vi.fn().mockReturnValue({
      wsQueueDepth: 0,
      wsPendingResponses: 0,
      wsState: "none",
    }),
    fetchShot: vi.fn().mockResolvedValue(null),
    fetchShotNotes: vi.fn().mockResolvedValue(null),
    saveShotNotes: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockNotion() {
  return {
    queryRecentBrews: vi.fn().mockResolvedValue([]),
    queryBrewByActivityId: vi.fn().mockResolvedValue(null),
    queryProfiles: vi.fn().mockResolvedValue([]),
  };
}

describe("MCP tools registration", () => {
  it("registers all 11 tools", () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();

    registerTools(server as any, gaggimate as any, notion as any);

    expect(server.registeredTools).toHaveLength(11);
    expect(server.registeredTools).toContain("get_recent_brews");
    expect(server.registeredTools).toContain("get_brew_detail");
    expect(server.registeredTools).toContain("compare_shots");
    expect(server.registeredTools).toContain("get_brew_trends");
    expect(server.registeredTools).toContain("list_profiles");
    expect(server.registeredTools).toContain("push_profile");
    expect(server.registeredTools).toContain("archive_profile");
    expect(server.registeredTools).toContain("get_device_status");
    expect(server.registeredTools).toContain("analyze_shot");
    expect(server.registeredTools).toContain("get_shot_notes");
    expect(server.registeredTools).toContain("save_shot_notes");
  });
});

describe("get_device_status", () => {
  it("returns reachability and diagnostics", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["get_device_status"]({});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.reachable).toBe(true);
    expect(parsed.wsState).toBe("none");
    expect(parsed.wsQueueDepth).toBe(0);
    expect(gaggimate.isReachable).toHaveBeenCalledOnce();
    expect(gaggimate.getConnectionDiagnostics).toHaveBeenCalledOnce();
  });

  it("reports unreachable device", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    gaggimate.isReachable.mockResolvedValue(false);
    const notion = makeMockNotion();

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["get_device_status"]({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.reachable).toBe(false);
  });
});

describe("get_recent_brews", () => {
  it("calls queryRecentBrews with default count 10", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();
    notion.queryRecentBrews.mockResolvedValue([{ id: "abc" }]);

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["get_recent_brews"]({});
    expect(notion.queryRecentBrews).toHaveBeenCalledWith(10);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
  });

  it("passes custom count to queryRecentBrews", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();

    registerTools(server as any, gaggimate as any, notion as any);

    await server.handlers["get_recent_brews"]({ count: 5 });
    expect(notion.queryRecentBrews).toHaveBeenCalledWith(5);
  });
});

describe("get_brew_detail", () => {
  it("returns brew data when found", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();
    notion.queryBrewByActivityId.mockResolvedValue({ id: "page-1", properties: {} });

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["get_brew_detail"]({ shotId: "047" });
    expect(notion.queryBrewByActivityId).toHaveBeenCalledWith("047");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe("page-1");
  });

  it("returns isError when brew not found", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["get_brew_detail"]({ shotId: "999" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("999");
  });
});

describe("compare_shots", () => {
  it("returns both brews when found", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();
    notion.queryBrewByActivityId
      .mockResolvedValueOnce({ id: "page-47" })
      .mockResolvedValueOnce({ id: "page-48" });

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["compare_shots"]({ shotId1: "047", shotId2: "048" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.shot1.id).toBe("page-47");
    expect(parsed.shot2.id).toBe("page-48");
  });

  it("returns isError when a brew is missing", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();
    notion.queryBrewByActivityId
      .mockResolvedValueOnce({ id: "page-47" })
      .mockResolvedValueOnce(null);

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["compare_shots"]({ shotId1: "047", shotId2: "999" });
    expect(result.isError).toBe(true);
  });
});

describe("list_profiles", () => {
  it("fetches from both by default", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();
    gaggimate.fetchProfiles.mockResolvedValue([{ id: "dev-1" }]);
    notion.queryProfiles.mockResolvedValue([{ pageId: "page-1" }]);

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["list_profiles"]({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.device).toHaveLength(1);
    expect(parsed.notion).toHaveLength(1);
  });

  it("fetches only from device when source is device", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["list_profiles"]({ source: "device" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.device).toBeDefined();
    expect(parsed.notion).toBeUndefined();
    expect(notion.queryProfiles).not.toHaveBeenCalled();
  });

  it("fetches only from notion when source is notion", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["list_profiles"]({ source: "notion" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.notion).toBeDefined();
    expect(parsed.device).toBeUndefined();
    expect(gaggimate.fetchProfiles).not.toHaveBeenCalled();
  });
});

describe("push_profile", () => {
  it("saves profile to device and returns response", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();
    gaggimate.saveProfile.mockResolvedValue({ id: "prof-1", label: "Test" });

    registerTools(server as any, gaggimate as any, notion as any);

    const profile = { label: "Test", temperature: 93, phases: [] };
    const result = await server.handlers["push_profile"]({ profile });
    expect(gaggimate.saveProfile).toHaveBeenCalledWith(profile);
    expect(result.content[0].text).toContain("Profile saved");
  });
});

describe("archive_profile", () => {
  it("deletes profile from device", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["archive_profile"]({ profileId: "prof-123" });
    expect(gaggimate.deleteProfile).toHaveBeenCalledWith("prof-123");
    expect(result.content[0].text).toContain("prof-123");
  });
});

describe("analyze_shot", () => {
  it("returns isError when shot not found on device", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();
    gaggimate.fetchShot.mockResolvedValue(null);

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["analyze_shot"]({ shotId: 42 });
    expect(gaggimate.fetchShot).toHaveBeenCalledWith("42");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("42");
  });
});

describe("get_shot_notes", () => {
  it("returns no-notes message when notes are null", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["get_shot_notes"]({ shotId: 10 });
    expect(gaggimate.fetchShotNotes).toHaveBeenCalledWith(10);
    expect(result.content[0].text).toContain("No notes");
    expect(result.isError).toBeUndefined();
  });

  it("returns notes when present", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();
    gaggimate.fetchShotNotes.mockResolvedValue({ id: 10, rating: 4, beanType: "Ethiopia" });

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["get_shot_notes"]({ shotId: 10 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.rating).toBe(4);
    expect(parsed.beanType).toBe("Ethiopia");
  });
});

describe("save_shot_notes", () => {
  it("saves notes and returns confirmation", async () => {
    const server = makeMockServer();
    const gaggimate = makeMockGaggimate();
    const notion = makeMockNotion();

    registerTools(server as any, gaggimate as any, notion as any);

    const result = await server.handlers["save_shot_notes"]({
      shotId: 15,
      rating: 4,
      beanType: "Kenya",
      doseIn: 18,
      doseOut: 36,
    });
    expect(gaggimate.saveShotNotes).toHaveBeenCalledWith(15, {
      rating: 4,
      beanType: "Kenya",
      doseIn: 18,
      doseOut: 36,
    });
    expect(result.content[0].text).toContain("15");
  });
});
