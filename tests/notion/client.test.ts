import { describe, expect, it, vi } from "vitest";
import { NotionClient } from "../../src/notion/client.js";

function createNotionClient() {
  const notion = new NotionClient({
    apiKey: "ntn_test",
    beansDbId: "beans-db",
    brewsDbId: "brews-db",
    profilesDbId: "profiles-db",
  });

  const mockClient = {
    pages: {
      create: vi.fn(),
      update: vi.fn(),
      retrieve: vi.fn(),
    },
    databases: {
      query: vi.fn(),
    },
    request: vi.fn(),
  };

  (notion as any).client = mockClient;
  return { notion, mockClient };
}

function titleProperty(value: string) {
  return {
    type: "title",
    title: [{ plain_text: value }],
  };
}

function richTextProperty(value: string) {
  return {
    type: "rich_text",
    rich_text: [{ plain_text: value }],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("NotionClient profile helpers", () => {
  it("normalizeProfileName repairs mojibake profile labels", () => {
    const { notion } = createNotionClient();

    const normalized = notion.normalizeProfileName("Linea Gesha â Extended Bloom Clarity v3");
    expect(normalized).toBe("linea gesha - extended bloom clarity v3");
  });

  it("normalizeProfileName normalizes dash variants and non-breaking spaces", () => {
    const { notion } = createNotionClient();

    const normalized = notion.normalizeProfileName("Linea\u00A0Gesha — Extended Bloom");
    expect(normalized).toBe("linea gesha - extended bloom");
    expect(notion.normalizeProfileName("Linea Gesha - Extended Bloom")).toBe(normalized);
  });

  it("createDraftProfile creates Draft profile with machine state fields", async () => {
    const { notion, mockClient } = createNotionClient();
    mockClient.pages.create.mockResolvedValue({ id: "new-page-id" });

    const pageId = await notion.createDraftProfile({
      id: "device-id",
      label: "Device Profile",
      type: "pro",
      description: "from device",
      favorite: true,
      selected: false,
      temperature: 93,
      phases: [{ name: "Extraction", phase: "brew", duration: 30 }],
    });

    expect(pageId).toBe("new-page-id");
    expect(mockClient.pages.create).toHaveBeenCalledTimes(1);

    const args = mockClient.pages.create.mock.calls[0][0];
    expect(args.parent).toEqual({ database_id: "profiles-db" });
    expect(args.properties["Push Status"]).toEqual({ select: { name: "Draft" } });
    expect(args.properties["Active on Machine"]).toEqual({ checkbox: true });
    expect(args.properties.Favorite).toEqual({ checkbox: true });
    expect(args.properties.Selected).toEqual({ checkbox: false });
  });

  it("updatePushStatus includes Active on Machine when provided", async () => {
    const { notion, mockClient } = createNotionClient();
    mockClient.pages.update.mockResolvedValue({});

    await notion.updatePushStatus("page-id", "Pushed", "2026-02-17T00:00:00.000Z", true);

    expect(mockClient.pages.update).toHaveBeenCalledTimes(1);
    expect(mockClient.pages.update).toHaveBeenCalledWith({
      page_id: "page-id",
      properties: {
        "Push Status": { select: { name: "Pushed" } },
        "Last Pushed": { date: { start: "2026-02-17T00:00:00.000Z" } },
        "Active on Machine": { checkbox: true },
      },
    });
  });

  it("listExistingProfiles extracts favorite/selected and excludes archived from lookup maps", async () => {
    const { notion, mockClient } = createNotionClient();
    mockClient.databases.query.mockResolvedValue({
      results: [
        {
          id: "pushed-page",
          properties: {
            "Profile Name": titleProperty("Pushed One"),
            "Profile JSON": richTextProperty("{\"id\":\"device-id\"}"),
            "Push Status": { type: "select", select: { name: "Pushed" } },
            "Active on Machine": { type: "checkbox", checkbox: true },
            "Profile Image": { type: "files", files: [] },
            Source: { type: "select", select: { name: "Custom" } },
            Favorite: { type: "checkbox", checkbox: true },
            Selected: { type: "checkbox", checkbox: true },
          },
        },
        {
          id: "archived-page",
          properties: {
            "Profile Name": titleProperty("Archived One"),
            "Profile JSON": richTextProperty("{\"id\":\"archived-id\"}"),
            "Push Status": { type: "select", select: { name: "Archived" } },
            "Active on Machine": { type: "checkbox", checkbox: false },
            "Profile Image": { type: "files", files: [] },
            Source: { type: "select", select: { name: "Custom" } },
            Favorite: { type: "checkbox", checkbox: false },
            Selected: { type: "checkbox", checkbox: false },
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    });

    const existing = await notion.listExistingProfiles();

    expect(existing.all).toHaveLength(2);
    const pushed = existing.byId.get("device-id");
    expect(pushed).toBeDefined();
    expect(pushed?.favorite).toBe(true);
    expect(pushed?.selected).toBe(true);

    expect(existing.byName.has("archived one")).toBe(false);
    expect(existing.byId.has("archived-id")).toBe(false);
  });

  it("getProfilePageIdByName scans paginated results for normalized name matches", async () => {
    const { notion, mockClient } = createNotionClient();
    mockClient.databases.query
      // Exact title match query (first attempt) returns no match.
      .mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      })
      // Fallback scan page 1
      .mockResolvedValueOnce({
        results: [
          {
            id: "page-1",
            properties: {
              "Profile Name": titleProperty("Some Other Profile"),
            },
          },
        ],
        has_more: true,
        next_cursor: "cursor-2",
      })
      // Fallback scan page 2
      .mockResolvedValueOnce({
        results: [
          {
            id: "target-page",
            properties: {
              "Profile Name": titleProperty("Linea Gesha â Extended Bloom Clarity v3"),
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      });

    const pageId = await notion.getProfilePageIdByName("Linea Gesha — Extended Bloom Clarity v3");
    expect(pageId).toBe("target-page");
  });

  it("caches missing profile lookups to avoid repeated full scans", async () => {
    const { notion, mockClient } = createNotionClient();
    mockClient.databases.query
      .mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      });

    const first = await notion.getProfilePageIdByName("Missing Profile");
    const second = await notion.getProfilePageIdByName("Missing Profile");

    expect(first).toBeNull();
    expect(second).toBeNull();
    // First lookup does exact match + fallback scan, second is served from negative cache.
    expect(mockClient.databases.query).toHaveBeenCalledTimes(2);
  });

  it("throttles repeated missing-profile warnings during brew writes", async () => {
    const { notion, mockClient } = createNotionClient();
    mockClient.databases.query
      .mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      });
    mockClient.pages.create.mockResolvedValue({ id: "brew-page" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const brewData = {
      activityId: "1",
      title: "#001 - Feb 14 AM",
      date: "2026-02-14T08:00:00.000Z",
      brewTime: 30,
      yieldOut: 36,
      brewTemp: 93,
      peakPressure: 9,
      preinfusionTime: 5,
      totalVolume: 40,
      profileName: "Unknown Profile",
      source: "Auto" as const,
    };

    try {
      await notion.createBrew(brewData);
      await notion.createBrew(brewData);

      expect(mockClient.pages.create).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('No Profiles DB match found for profile name "Unknown Profile"');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("deduplicates concurrent lookups for the same missing profile name", async () => {
    const { notion, mockClient } = createNotionClient();
    const exactDeferred = createDeferred<any>();
    mockClient.databases.query.mockImplementation(() => {
      const callCount = mockClient.databases.query.mock.calls.length;
      if (callCount === 1) {
        return exactDeferred.promise;
      }
      return Promise.resolve({
        results: [],
        has_more: false,
        next_cursor: null,
      });
    });

    const first = notion.getProfilePageIdByName("Concurrent Missing");
    const second = notion.getProfilePageIdByName("Concurrent Missing");

    expect(mockClient.databases.query).toHaveBeenCalledTimes(1);

    exactDeferred.resolve({
      results: [],
      has_more: false,
      next_cursor: null,
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBeNull();
    expect(secondResult).toBeNull();
    // One exact-match query + one fallback scan total, despite two callers.
    expect(mockClient.databases.query).toHaveBeenCalledTimes(2);
  });
});
