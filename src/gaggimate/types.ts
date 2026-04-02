// GaggiMate API type definitions

export interface GaggiMateConfig {
  host: string;
  protocol: "ws" | "wss";
  requestTimeout: number;
}

export interface ProfilePhase {
  name: string;
  phase: "preinfusion" | "brew";
  valve?: number;
  duration: number;
  temperature?: number;
  transition?: {
    type: "linear" | "ease-out" | "ease-in" | "ease-in-out" | "instant";
    duration: number;
    adaptive?: boolean;
  };
  pump?: {
    target: "pressure" | "flow";
    pressure?: number;
    flow?: number;
  };
  targets?: Array<{
    type: "pressure" | "flow" | "volumetric" | "pumped";
    operator?: "gte" | "lte";
    value: number;
  }>;
}

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

export interface ProfileData {
  id?: string;
  label: string;
  type: string;
  description?: string;
  temperature: number;
  favorite?: boolean;
  selected?: boolean;
  utility?: boolean;
  phases: ProfilePhase[];
}
