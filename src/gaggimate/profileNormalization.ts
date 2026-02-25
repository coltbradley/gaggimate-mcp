import type { ProfileData, ProfilePhase } from "./types.js";

const DEFAULT_PUMP_TARGET: "pressure" = "pressure";
const DEFAULT_PUMP_PRESSURE = 9;
const DEFAULT_PUMP_FLOW = 0;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function normalizePhase(phase: ProfilePhase, fallbackTemperature: number): ProfilePhase {
  const rawPump: Partial<NonNullable<ProfilePhase["pump"]>> =
    phase?.pump && typeof phase.pump === "object" ? phase.pump : {};

  const result: ProfilePhase = {
    ...phase,
    phase: phase?.phase === "preinfusion" ? "preinfusion" : "brew",
    valve: phase?.valve === 0 || phase?.valve === 1 ? phase.valve : 1,
    temperature: toFiniteNumber(phase?.temperature) ?? fallbackTemperature,
    pump: {
      ...rawPump,
      target: rawPump.target === "flow" ? "flow" : DEFAULT_PUMP_TARGET,
      pressure: toFiniteNumber(rawPump.pressure) ?? DEFAULT_PUMP_PRESSURE,
      flow: toFiniteNumber(rawPump.flow) ?? DEFAULT_PUMP_FLOW,
    },
  };

  // The device omits empty targets arrays rather than returning [].
  // Strip them here so [] and absent are treated as equivalent during comparison.
  if (Array.isArray(result.targets) && result.targets.length === 0) {
    delete (result as any).targets;
  }

  return result;
}

export function normalizeProfileForGaggiMate(profile: ProfileData): ProfileData {
  const fallbackTemperature = toFiniteNumber(profile.temperature) ?? 93;
  const phases = Array.isArray(profile.phases)
    ? profile.phases.map((phase) => normalizePhase(phase, fallbackTemperature))
    : [];

  return {
    ...profile,
    temperature: fallbackTemperature,
    phases,
  };
}
