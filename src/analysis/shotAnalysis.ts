import { ShotData, ShotSample, PhaseTransition } from '../parsers/binaryShot.js';
import { MetricStats, PhaseAnalysis, ShotAnalysis } from './types.js';

const PREDICTIVE_WINDOW_MS = 4000;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Compute time-weighted min/max/avg/start/end for a metric across samples.
 * Each sample's contribution to the average is weighted by the time interval
 * it represents (delta to the next sample, or sampleInterval for the last one).
 */
function getMetricStats(
  samples: ShotSample[],
  key: keyof ShotSample,
  sampleInterval: number,
): MetricStats {
  if (samples.length === 0) {
    return { min: 0, max: 0, avg: 0, start: 0, end: 0 };
  }

  const first = Number(samples[0][key] ?? 0);
  const last = Number(samples[samples.length - 1][key] ?? 0);

  let min = first;
  let max = first;
  let weightedSum = 0;
  let totalWeight = 0;

  for (let i = 0; i < samples.length; i++) {
    const val = Number(samples[i][key] ?? 0);
    if (val < min) min = val;
    if (val > max) max = val;

    // Time interval this sample represents
    let dt: number;
    if (i < samples.length - 1) {
      const t0 = Number(samples[i].t ?? i * sampleInterval);
      const t1 = Number(samples[i + 1].t ?? (i + 1) * sampleInterval);
      dt = t1 - t0;
    } else {
      dt = sampleInterval;
    }
    if (dt <= 0) dt = sampleInterval;

    weightedSum += val * dt;
    totalWeight += dt;
  }

  const avg = totalWeight > 0 ? weightedSum / totalWeight : first;

  return {
    min: round1(min),
    max: round1(max),
    avg: round1(avg),
    start: round1(first),
    end: round1(last),
  };
}

/**
 * Linear regression of weight over the last PREDICTIVE_WINDOW_MS of samples.
 * Returns slope in g/s, or null if insufficient data.
 */
function getRegressionWeightRate(samples: ShotSample[], sampleInterval: number): number | null {
  if (samples.length < 2) return null;

  // Check if any sample has weight data
  const hasWeight = samples.some(s => (s.v ?? 0) > 0);
  if (!hasWeight) return null;

  // Use the last PREDICTIVE_WINDOW_MS of samples
  const lastTime = Number(samples[samples.length - 1].t ?? (samples.length - 1) * sampleInterval);
  const windowStart = lastTime - PREDICTIVE_WINDOW_MS;

  const windowSamples = samples.filter(s => {
    const t = Number(s.t ?? 0);
    return t >= windowStart;
  });

  if (windowSamples.length < 2) return null;

  // Standard least-squares linear regression: slope = (n*Sxy - Sx*Sy) / (n*Sxx - Sx^2)
  // x = time in ms, y = weight in g
  const n = windowSamples.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (const s of windowSamples) {
    const x = Number(s.t ?? 0);
    const y = Number(s.v ?? 0);
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }

  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return null;

  const slopePerMs = (n * sumXY - sumX * sumY) / denom;
  // Convert from g/ms to g/s
  const slopePerS = slopePerMs * 1000;

  return round1(slopePerS);
}

/**
 * Detect why a phase ended based on sample data at the phase boundary.
 * Simplified heuristic: checks weight change and duration patterns.
 */
function detectExitReason(
  phaseSamples: ShotSample[],
  isLastPhase: boolean,
  nextPhaseSamples: ShotSample[] | null,
): string | null {
  if (isLastPhase) return null;
  if (phaseSamples.length < 2) return null;

  // Check for weight stop: significant weight increase in last few samples
  const tailCount = Math.min(5, phaseSamples.length);
  const tailStart = phaseSamples.length - tailCount;
  const weightAtTailStart = Number(phaseSamples[tailStart].v ?? 0);
  const weightAtEnd = Number(phaseSamples[phaseSamples.length - 1].v ?? 0);

  if (weightAtEnd > 0 && weightAtTailStart > 0) {
    // If weight is near a round number target, likely weight stop
    const weightRounded = Math.round(weightAtEnd);
    if (Math.abs(weightAtEnd - weightRounded) < 0.5 && weightAtEnd > 5) {
      return 'Weight Stop';
    }
  }

  // Check for time stop: duration is a round number of seconds
  const firstTime = Number(phaseSamples[0].t ?? 0);
  const lastTime = Number(phaseSamples[phaseSamples.length - 1].t ?? 0);
  const durationMs = lastTime - firstTime;
  const durationS = durationMs / 1000;

  if (durationS > 0 && Math.abs(durationS - Math.round(durationS)) < 0.3) {
    return 'Time Stop';
  }

  // Check for pressure stop: pressure target was reached
  const lastSample = phaseSamples[phaseSamples.length - 1];
  const tp = Number(lastSample.tp ?? 0);
  const cp = Number(lastSample.cp ?? 0);
  if (tp > 0 && cp > 0 && Math.abs(cp - tp) < 0.5) {
    return 'Pressure Stop';
  }

  // Check for flow stop
  const tf = Number(lastSample.tf ?? 0);
  const fl = Number(lastSample.fl ?? 0);
  if (tf > 0 && fl > 0 && Math.abs(fl - tf) < 0.3) {
    return 'Flow Stop';
  }

  return null;
}

/**
 * Check if the shot was started in brew-by-weight (volumetric) mode.
 * Checks bit 0 of systemInfo across samples.
 */
function detectBrewByWeight(samples: ShotSample[]): boolean {
  for (const s of samples) {
    if (s.systemInfo && typeof s.systemInfo === 'object') {
      if (s.systemInfo.shotStartedVolumetric) return true;
    } else if (typeof s.systemInfo === 'number') {
      if (s.systemInfo & 0x0001) return true;
    }
  }
  return false;
}

/**
 * Split samples into phase groups based on phase transitions.
 * Returns array of { transition, samples } for each phase.
 */
function splitIntoPhases(
  samples: ShotSample[],
  phases: PhaseTransition[],
): Array<{ transition: PhaseTransition; samples: ShotSample[] }> {
  if (phases.length === 0) {
    return [
      {
        transition: { sampleIndex: 0, phaseNumber: 0, phaseName: '' },
        samples,
      },
    ];
  }

  const result: Array<{ transition: PhaseTransition; samples: ShotSample[] }> = [];

  for (let i = 0; i < phases.length; i++) {
    const startIdx = phases[i].sampleIndex;
    const endIdx = i < phases.length - 1 ? phases[i + 1].sampleIndex : samples.length;
    result.push({
      transition: phases[i],
      samples: samples.slice(startIdx, endIdx),
    });
  }

  return result;
}

/**
 * Generate human-readable phase summary.
 * Example: "Preinfusion: 8s @ 3.1 bar -> Brew: 24s @ 9.0 bar"
 */
function generatePhaseSummary(phases: PhaseAnalysis[]): string {
  if (phases.length === 0) return '';

  return phases
    .map(p => {
      const durationS = Math.round(p.durationMs / 1000);
      const name = p.name || `Phase ${p.phaseNumber}`;
      return `${name}: ${durationS}s @ ${p.pressure.avg} bar`;
    })
    .join(' \u2192 ');
}

/**
 * Main analysis function. Takes raw ShotData, returns computed ShotAnalysis.
 * Pure function -- no I/O, no side effects.
 */
export function analyzeShotData(shot: ShotData): ShotAnalysis {
  const { samples, phases: phaseTransitions, sampleInterval, weight, duration } = shot;

  // Handle empty samples
  if (samples.length === 0) {
    return {
      phases: [],
      totalDurationMs: duration,
      isBrewByWeight: false,
      finalWeight: weight,
      avgPuckResistance: null,
      peakPuckResistance: null,
      avgWeightFlowRate: null,
      exitReason: null,
      phaseSummary: '',
    };
  }

  const isBrewByWeight = detectBrewByWeight(samples);
  const phaseGroups = splitIntoPhases(samples, phaseTransitions);

  const analyzedPhases: PhaseAnalysis[] = [];

  for (let i = 0; i < phaseGroups.length; i++) {
    const { transition, samples: phaseSamples } = phaseGroups[i];
    if (phaseSamples.length === 0) continue;

    const firstTime = Number(phaseSamples[0].t ?? 0);
    const lastTime = Number(phaseSamples[phaseSamples.length - 1].t ?? 0);
    const durationMs = lastTime - firstTime;

    const isLastPhase = i === phaseGroups.length - 1;
    const nextSamples = isLastPhase ? null : phaseGroups[i + 1].samples;
    const exitReason = detectExitReason(phaseSamples, isLastPhase, nextSamples);

    analyzedPhases.push({
      name: transition.phaseName,
      phaseNumber: transition.phaseNumber,
      startTimeMs: firstTime,
      durationMs,
      sampleCount: phaseSamples.length,
      pressure: getMetricStats(phaseSamples, 'cp', sampleInterval),
      flow: getMetricStats(phaseSamples, 'fl', sampleInterval),
      temperature: getMetricStats(phaseSamples, 'ct', sampleInterval),
      puckResistance: getMetricStats(phaseSamples, 'pr', sampleInterval),
      weightFlowRate: getRegressionWeightRate(phaseSamples, sampleInterval),
      exitReason,
    });
  }

  // Aggregate puck resistance across all samples
  const allPr = samples.map(s => Number(s.pr ?? 0)).filter(v => v > 0);
  const avgPuckResistance =
    allPr.length > 0 ? round1(allPr.reduce((a, b) => a + b, 0) / allPr.length) : null;
  const peakPuckResistance = allPr.length > 0 ? round1(Math.max(...allPr)) : null;

  // Aggregate weight flow rate (average of per-phase non-null rates)
  const phaseRates = analyzedPhases
    .map(p => p.weightFlowRate)
    .filter((r): r is number => r !== null);
  const avgWeightFlowRate =
    phaseRates.length > 0
      ? round1(phaseRates.reduce((a, b) => a + b, 0) / phaseRates.length)
      : null;

  // Overall exit reason is the exit reason of the last phase
  const overallExitReason =
    analyzedPhases.length > 0 ? analyzedPhases[analyzedPhases.length - 1].exitReason : null;

  return {
    phases: analyzedPhases,
    totalDurationMs: duration,
    isBrewByWeight,
    finalWeight: weight,
    avgPuckResistance,
    peakPuckResistance,
    avgWeightFlowRate,
    exitReason: overallExitReason,
    phaseSummary: generatePhaseSummary(analyzedPhases),
  };
}
