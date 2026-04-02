// Notion database schema types matching PRD database designs

export interface NotionConfig {
  apiKey: string;
  beansDbId: string;
  brewsDbId: string;
  profilesDbId: string;
}

// Brews DB types
export interface BrewData {
  activityId: string; // Shot ID from GaggiMate (dedup key)
  title: string; // e.g. "#047 - Feb 14 AM"
  date: string; // ISO date string
  brewTime: number; // seconds
  yieldOut: number | null; // grams
  brewTemp: number; // average temperature in °C
  peakPressure: number; // bar
  preinfusionTime: number; // seconds
  totalVolume: number; // ml
  profileName: string; // text fallback for profile relation
  source: "Auto" | "Manual";

  // Shot notes fields
  doseIn?: number;
  grindSetting?: number;
  tasteBal?: string;

  // DDSA analysis fields
  avgPuckResistance?: number;
  peakPuckResistance?: number;
  weightFlowRate?: number;
  phaseSummary?: string;
  exitReason?: string;
}

export interface BrewUpdateData {
  [key: string]: any;
}

// Profiles DB types
export type PushStatus = "Draft" | "Queued" | "Pushed" | "Failed" | "Archived";

export interface ProfileEntry {
  pageId: string;
  profileName: string;
  profileJson: string;
  pushStatus: PushStatus;
}

// Beans DB types
export interface BeanEntry {
  pageId: string;
  beanName: string;
  roaster?: string;
  origin?: string;
  process?: string;
  roastLevel?: string;
  roastDate?: string;
}

// Query filter types
export interface BrewFilters {
  startDate?: string;
  endDate?: string;
  beanPageId?: string;
  profilePageId?: string;
}

export interface BeanFilters {
  roaster?: string;
  buyAgain?: boolean;
}
