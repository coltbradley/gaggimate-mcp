import { describe, it, expect, vi } from "vitest";
import { pushProfileToGaggiMate } from "../../src/sync/profilePush.js";

function createMockGaggiMate() {
  return {
    saveProfile: vi.fn().mockResolvedValue({ id: "profile-id" }),
    favoriteProfile: vi.fn().mockResolvedValue(undefined),
    selectProfile: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockNotion() {
  return {
    updatePushStatus: vi.fn().mockResolvedValue(undefined),
    extractProfileId: vi.fn().mockImplementation((profile: any) => {
      if (typeof profile?.id === "string" && profile.id.trim()) {
        return profile.id;
      }
      return null;
    }),
    updateProfileJson: vi.fn().mockResolvedValue(undefined),
    getProfilePreferenceState: vi.fn().mockResolvedValue({ favorite: false, selected: false }),
  };
}

describe("pushProfileToGaggiMate", () => {
  it("pushes valid profile and sets status to Pushed with Active on Machine", async () => {
    const gaggimate = createMockGaggiMate();
    const notion = createMockNotion();

    const profileJson = JSON.stringify({
      label: "My Profile",
      temperature: 93,
      phases: [{ name: "Extraction", phase: "brew", duration: 30 }],
    });

    await pushProfileToGaggiMate(gaggimate as any, notion as any, "page-1", profileJson);

    expect(gaggimate.saveProfile).toHaveBeenCalledTimes(1);
    const pushedProfile = gaggimate.saveProfile.mock.calls[0][0];
    // saveProfile receives the raw profile; normalization happens inside the client
    expect(pushedProfile.label).toBe("My Profile");
    expect(pushedProfile.temperature).toBe(93);
    expect(pushedProfile.phases).toHaveLength(1);
    expect(notion.updatePushStatus).toHaveBeenCalledWith("page-1", "Pushed", expect.any(String), true, expect.any(String));
    expect(gaggimate.favoriteProfile).toHaveBeenCalledWith("profile-id", false);
    expect(gaggimate.selectProfile).not.toHaveBeenCalled();
  });

  it("writes back assigned profile ID when save response contains id", async () => {
    const gaggimate = createMockGaggiMate();
    gaggimate.saveProfile.mockResolvedValue({ id: "device-123" });
    const notion = createMockNotion();

    const profileJson = JSON.stringify({
      label: "My Profile",
      temperature: 93,
      phases: [{ name: "Extraction", phase: "brew", duration: 30 }],
    });

    await pushProfileToGaggiMate(gaggimate as any, notion as any, "page-2", profileJson);

    expect(notion.updatePushStatus).toHaveBeenCalledWith("page-2", "Pushed", expect.any(String), true, expect.stringContaining('"id":"device-123"'));
    expect(gaggimate.favoriteProfile).toHaveBeenCalledWith("device-123", false);
  });

  it("does not write back ID when profile already has id", async () => {
    const gaggimate = createMockGaggiMate();
    gaggimate.saveProfile.mockResolvedValue({ id: "device-123" });
    const notion = createMockNotion();

    const profileJson = JSON.stringify({
      id: "already-present",
      label: "My Profile",
      temperature: 93,
      phases: [{ name: "Extraction", phase: "brew", duration: 30 }],
    });

    await pushProfileToGaggiMate(gaggimate as any, notion as any, "page-3", profileJson);

    expect(notion.updateProfileJson).not.toHaveBeenCalled();
    expect(gaggimate.favoriteProfile).toHaveBeenCalledWith("device-123", false);
  });

  it("applies favorite and selected state immediately after webhook push", async () => {
    const gaggimate = createMockGaggiMate();
    gaggimate.saveProfile.mockResolvedValue({ id: "device-xyz" });
    const notion = createMockNotion();
    notion.getProfilePreferenceState.mockResolvedValue({ favorite: true, selected: true });

    const profileJson = JSON.stringify({
      label: "My Profile",
      temperature: 93,
      phases: [{ name: "Extraction", phase: "brew", duration: 30 }],
    });

    await pushProfileToGaggiMate(gaggimate as any, notion as any, "page-pref", profileJson);

    expect(gaggimate.favoriteProfile).toHaveBeenCalledWith("device-xyz", true);
    expect(gaggimate.selectProfile).toHaveBeenCalledWith("device-xyz");
  });

  it("still marks profile pushed when preference sync fails", async () => {
    const gaggimate = createMockGaggiMate();
    gaggimate.saveProfile.mockResolvedValue({ id: "device-xyz" });
    gaggimate.favoriteProfile.mockRejectedValue(new Error("favorite sync failed"));
    const notion = createMockNotion();
    notion.getProfilePreferenceState.mockResolvedValue({ favorite: true, selected: true });

    const profileJson = JSON.stringify({
      label: "My Profile",
      temperature: 93,
      phases: [{ name: "Extraction", phase: "brew", duration: 30 }],
    });

    await pushProfileToGaggiMate(gaggimate as any, notion as any, "page-pref-fail", profileJson);

    expect(notion.updatePushStatus).toHaveBeenCalledWith("page-pref-fail", "Pushed", expect.any(String), true, expect.any(String));
  });

  it("rejects invalid JSON and sets status to Failed", async () => {
    const gaggimate = createMockGaggiMate();
    const notion = createMockNotion();

    await pushProfileToGaggiMate(gaggimate as any, notion as any, "page-4", "not json {{{");

    expect(gaggimate.saveProfile).not.toHaveBeenCalled();
    expect(notion.updatePushStatus).toHaveBeenCalledWith("page-4", "Failed");
  });

  it("rejects profile with missing temperature", async () => {
    const gaggimate = createMockGaggiMate();
    const notion = createMockNotion();

    const profileJson = JSON.stringify({
      phases: [{ name: "Extraction", phase: "brew", duration: 30 }],
    });

    await pushProfileToGaggiMate(gaggimate as any, notion as any, "page-5", profileJson);

    expect(gaggimate.saveProfile).not.toHaveBeenCalled();
    expect(notion.updatePushStatus).toHaveBeenCalledWith("page-5", "Failed");
  });

  it("rejects profile with non-numeric temperature", async () => {
    const gaggimate = createMockGaggiMate();
    const notion = createMockNotion();

    const profileJson = JSON.stringify({
      temperature: "93",
      phases: [{ name: "Extraction", phase: "brew", duration: 30 }],
    });

    await pushProfileToGaggiMate(gaggimate as any, notion as any, "page-5b", profileJson);

    expect(gaggimate.saveProfile).not.toHaveBeenCalled();
    expect(notion.updatePushStatus).toHaveBeenCalledWith("page-5b", "Failed");
  });

  it("rejects profile with missing phases", async () => {
    const gaggimate = createMockGaggiMate();
    const notion = createMockNotion();

    const profileJson = JSON.stringify({ temperature: 93 });

    await pushProfileToGaggiMate(gaggimate as any, notion as any, "page-6", profileJson);

    expect(gaggimate.saveProfile).not.toHaveBeenCalled();
    expect(notion.updatePushStatus).toHaveBeenCalledWith("page-6", "Failed");
  });

  it("rejects profile with temperature out of range", async () => {
    const gaggimate = createMockGaggiMate();
    const notion = createMockNotion();

    await pushProfileToGaggiMate(
      gaggimate as any,
      notion as any,
      "page-7",
      JSON.stringify({ temperature: 50, phases: [{ name: "X", phase: "brew", duration: 10 }] }),
    );
    expect(notion.updatePushStatus).toHaveBeenCalledWith("page-7", "Failed");

    await pushProfileToGaggiMate(
      gaggimate as any,
      notion as any,
      "page-8",
      JSON.stringify({ temperature: 110, phases: [{ name: "X", phase: "brew", duration: 10 }] }),
    );
    expect(notion.updatePushStatus).toHaveBeenCalledWith("page-8", "Failed");
  });

  it("rejects profile with more than 20 phases", async () => {
    const gaggimate = createMockGaggiMate();
    const notion = createMockNotion();

    const phases = Array.from({ length: 21 }, (_, i) => ({
      name: `Phase ${i}`,
      phase: "brew",
      duration: 5,
    }));

    await pushProfileToGaggiMate(
      gaggimate as any,
      notion as any,
      "page-phases",
      JSON.stringify({ temperature: 93, phases }),
    );

    expect(gaggimate.saveProfile).not.toHaveBeenCalled();
    expect(notion.updatePushStatus).toHaveBeenCalledWith("page-phases", "Failed");
  });

  it("sets status to Failed when saveProfile fails", async () => {
    const gaggimate = createMockGaggiMate();
    gaggimate.saveProfile.mockRejectedValue(new Error("Connection refused"));
    const notion = createMockNotion();

    const profileJson = JSON.stringify({
      label: "My Profile",
      temperature: 93,
      phases: [{ name: "Extraction", phase: "brew", duration: 30 }],
    });

    await pushProfileToGaggiMate(gaggimate as any, notion as any, "page-9", profileJson);

    expect(notion.updatePushStatus).toHaveBeenCalledWith("page-9", "Failed");
  });

});
