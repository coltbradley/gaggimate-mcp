import type { ShotData } from "../parsers/binaryShot.js";
import type { TransformedShot } from "../transformers/shotTransformer.js";
import type { ShotAnalysis } from "../analysis/types.js";
import type { ShotNotes } from "../gaggimate/types.js";
import type { BrewData } from "./types.js";

interface BrewTitleFormatOptions {
  timeZone?: string;
  analysis?: ShotAnalysis;
  shotNotes?: ShotNotes | null;
}

/**
 * Format a shot number with zero-padded prefix: "#047"
 */
function formatShotNumber(shotId: string): string {
  return `#${shotId.padStart(3, "0")}`;
}

/**
 * Format a date for brew title: "Feb 14 AM"
 */
function formatBrewDate(isoDate: string, options?: BrewTitleFormatOptions): string {
  const date = new Date(isoDate);
  const formatterOptions: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "numeric",
    hour12: true,
  };
  if (options?.timeZone) {
    formatterOptions.timeZone = options.timeZone;
  }

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", formatterOptions).formatToParts(date);
  } catch {
    // Fallback for invalid timezone config
    parts = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      hour12: true,
    }).formatToParts(date);
  }

  const month = parts.find((p) => p.type === "month")?.value || date.toLocaleDateString("en-US", { month: "short" });
  const day = parts.find((p) => p.type === "day")?.value || String(date.getDate());
  const dayPeriod = (parts.find((p) => p.type === "dayPeriod")?.value || (date.getHours() < 12 ? "AM" : "PM")).toUpperCase();
  const period = dayPeriod.startsWith("A") ? "AM" : "PM";
  return `${month} ${day} ${period}`;
}

/**
 * Map GaggiMate shot data to Notion Brews DB properties
 */
export function shotToBrewData(
  shot: ShotData,
  transformed: TransformedShot,
  options?: BrewTitleFormatOptions,
): BrewData {
  const isoDate = transformed.metadata.timestamp;
  const shotNumber = formatShotNumber(shot.id);
  const dateLabel = formatBrewDate(isoDate, options);

  const { analysis, shotNotes } = options ?? {};

  return {
    activityId: shot.id,
    title: `${shotNumber} - ${dateLabel}`,
    date: isoDate,
    brewTime: transformed.metadata.duration_seconds,
    yieldOut: transformed.metadata.final_weight_grams,
    brewTemp: Math.round(transformed.summary.temperature.average_celsius * 10) / 10,
    peakPressure: Math.round(transformed.summary.pressure.max_bar * 10) / 10,
    preinfusionTime: Math.round(transformed.summary.extraction.preinfusion_time_seconds * 10) / 10,
    totalVolume: transformed.summary.flow.total_volume_ml,
    profileName: transformed.metadata.profile_name,
    source: "Auto",
    // Shot notes (optional — null if no notes were stored for this shot)
    ...(shotNotes != null && {
      doseIn: shotNotes.doseIn,
      grindSetting: shotNotes.grindSetting != null ? Number(shotNotes.grindSetting) : undefined,
      tasteBal: shotNotes.balanceTaste,
    }),
    // DDSA analysis (optional — provided when analyzeShotData has been run)
    ...(analysis != null && {
      avgPuckResistance: analysis.avgPuckResistance ?? undefined,
      peakPuckResistance: analysis.peakPuckResistance ?? undefined,
      weightFlowRate: analysis.avgWeightFlowRate ?? undefined,
      phaseSummary: analysis.phaseSummary || undefined,
      exitReason: analysis.exitReason ?? undefined,
    }),
  };
}

/**
 * Convert BrewData to Notion page properties
 */
export function brewDataToNotionProperties(brew: BrewData): Record<string, any> {
  const properties: Record<string, any> = {
    // Title property
    Brew: {
      title: [{ text: { content: brew.title } }],
    },
    // Activity ID for dedup
    "Activity ID": {
      rich_text: [{ text: { content: brew.activityId } }],
    },
    // Date with time
    Date: {
      date: { start: brew.date },
    },
    // Brew metrics
    "Brew Time": {
      number: brew.brewTime,
    },
    "Brew Temp": {
      number: brew.brewTemp,
    },
    "Peak Pressure": {
      number: brew.peakPressure,
    },
    "Pre-infusion Time": {
      number: brew.preinfusionTime,
    },
    "Total Volume": {
      number: brew.totalVolume,
    },
    // Source
    Source: {
      select: { name: brew.source },
    },
  };

  // Only include Yield Out if we have weight data
  if (brew.yieldOut !== null) {
    properties["Yield Out"] = {
      number: brew.yieldOut,
    };
  }

  // Shot notes fields (optional)
  if (brew.doseIn != null) properties["Dose In"] = { number: brew.doseIn };
  if (brew.grindSetting != null) properties["Grind Setting"] = { number: brew.grindSetting };
  if (brew.tasteBal) properties["Taste Balance"] = { select: { name: brew.tasteBal } };

  // DDSA analysis fields (optional)
  if (brew.avgPuckResistance != null) properties["Avg Puck Resistance"] = { number: Math.round(brew.avgPuckResistance * 10) / 10 };
  if (brew.peakPuckResistance != null) properties["Peak Puck Resistance"] = { number: Math.round(brew.peakPuckResistance * 10) / 10 };
  if (brew.weightFlowRate != null) properties["Weight Flow Rate"] = { number: Math.round(brew.weightFlowRate * 10) / 10 };
  if (brew.phaseSummary) properties["Phase Summary"] = { rich_text: [{ text: { content: brew.phaseSummary } }] };
  if (brew.exitReason) properties["Exit Reason"] = { rich_text: [{ text: { content: brew.exitReason } }] };

  return properties;
}
