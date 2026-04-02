export interface MetricStats {
  min: number;
  max: number;
  avg: number;
  start: number;
  end: number;
}

export interface PhaseAnalysis {
  name: string;
  phaseNumber: number;
  startTimeMs: number;
  durationMs: number;
  sampleCount: number;
  pressure: MetricStats;
  flow: MetricStats;
  temperature: MetricStats;
  puckResistance: MetricStats;
  weightFlowRate: number | null; // g/s via linear regression
  exitReason: string | null; // "Time Stop", "Weight Stop", etc.
}

export interface ShotAnalysis {
  phases: PhaseAnalysis[];
  totalDurationMs: number;
  isBrewByWeight: boolean;
  finalWeight: number | null;
  avgPuckResistance: number | null;
  peakPuckResistance: number | null;
  avgWeightFlowRate: number | null;
  exitReason: string | null;
  phaseSummary: string; // "Preinfusion: 8s @ 3 bar -> Brew: 24s @ 9 bar"
}
