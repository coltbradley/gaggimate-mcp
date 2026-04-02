import { describe, it, expect } from 'vitest';
import { analyzeShotData } from '../../src/analysis/shotAnalysis.js';
import { ShotData, ShotSample } from '../../src/parsers/binaryShot.js';

function makeSample(overrides: Partial<ShotSample> = {}): ShotSample {
  return {
    t: 0,
    tt: 93,
    ct: 92,
    tp: 9,
    cp: 9,
    fl: 2,
    tf: 2,
    pf: 1.8,
    vf: 0,
    v: 0,
    ev: 0,
    pr: 5,
    systemInfo: { raw: 0, shotStartedVolumetric: false, currentlyVolumetric: false, bluetoothScaleConnected: false, volumetricAvailable: false, extendedRecording: false },
    ...overrides,
  };
}

function makeShot(overrides: Partial<ShotData> = {}): ShotData {
  return {
    id: '001',
    version: 5,
    fieldsMask: 0x1fff,
    sampleCount: 0,
    sampleInterval: 250,
    profileId: 'test-profile',
    profileName: 'Test Profile',
    timestamp: 1700000000,
    rating: 0,
    duration: 30000,
    weight: 36,
    samples: [],
    phases: [],
    incomplete: false,
    ...overrides,
  };
}

/**
 * Build a realistic two-phase shot (preinfusion + brew).
 */
function makeTwoPhaseShot(): ShotData {
  const samples: ShotSample[] = [];
  const interval = 250;

  // Preinfusion: 32 samples = 8 seconds, low pressure ~3 bar
  for (let i = 0; i < 32; i++) {
    samples.push(
      makeSample({
        t: i * interval,
        cp: 2.5 + (i / 32) * 1, // ramp 2.5 -> 3.5
        fl: 1.5,
        ct: 92,
        pr: 2 + i * 0.1,
        v: 0,
      }),
    );
  }

  // Brew: 96 samples = 24 seconds, high pressure ~9 bar
  for (let i = 0; i < 96; i++) {
    const idx = 32 + i;
    samples.push(
      makeSample({
        t: idx * interval,
        cp: 8.5 + (i / 96) * 1, // ramp 8.5 -> 9.5
        fl: 2.5,
        ct: 93,
        pr: 6 + i * 0.05,
        v: i * 0.38, // weight ramps to ~36g
      }),
    );
  }

  return makeShot({
    sampleCount: samples.length,
    duration: 32000, // 32s total
    weight: 36,
    samples,
    phases: [
      { sampleIndex: 0, phaseNumber: 0, phaseName: 'Preinfusion' },
      { sampleIndex: 32, phaseNumber: 1, phaseName: 'Brew' },
    ],
  });
}

describe('analyzeShotData', () => {
  it('returns per-phase analysis with correct pressure stats', () => {
    const shot = makeTwoPhaseShot();
    const result = analyzeShotData(shot);

    expect(result.phases).toHaveLength(2);

    const preinfusion = result.phases[0];
    expect(preinfusion.name).toBe('Preinfusion');
    expect(preinfusion.pressure.min).toBeLessThan(4);
    expect(preinfusion.pressure.max).toBeLessThanOrEqual(3.5);
    expect(preinfusion.pressure.avg).toBeGreaterThan(2);
    expect(preinfusion.pressure.avg).toBeLessThan(4);

    const brew = result.phases[1];
    expect(brew.name).toBe('Brew');
    expect(brew.pressure.min).toBeGreaterThanOrEqual(8.5);
    expect(brew.pressure.max).toBeGreaterThanOrEqual(9);
    expect(brew.pressure.avg).toBeGreaterThan(8);
  });

  it('computes puck resistance stats', () => {
    const shot = makeTwoPhaseShot();
    const result = analyzeShotData(shot);

    expect(result.avgPuckResistance).not.toBeNull();
    expect(result.avgPuckResistance!).toBeGreaterThan(0);
    expect(result.peakPuckResistance).not.toBeNull();
    expect(result.peakPuckResistance!).toBeGreaterThan(result.avgPuckResistance!);

    // Per-phase: brew should have higher puck resistance than preinfusion
    const prePr = result.phases[0].puckResistance;
    const brewPr = result.phases[1].puckResistance;
    expect(brewPr.avg).toBeGreaterThan(prePr.avg);
  });

  it('generates human-readable phase summary with arrow separator', () => {
    const shot = makeTwoPhaseShot();
    const result = analyzeShotData(shot);

    expect(result.phaseSummary).toContain('Preinfusion:');
    expect(result.phaseSummary).toContain('\u2192');
    expect(result.phaseSummary).toContain('Brew:');
    expect(result.phaseSummary).toContain('bar');
    // Check format: "Preinfusion: Xs @ Y.Z bar -> Brew: Xs @ Y.Z bar"
    expect(result.phaseSummary).toMatch(/Preinfusion: \d+s @ [\d.]+ bar/);
    expect(result.phaseSummary).toMatch(/Brew: \d+s @ [\d.]+ bar/);
  });

  it('handles shots with no phase transitions (single unnamed phase)', () => {
    const samples: ShotSample[] = [];
    for (let i = 0; i < 40; i++) {
      samples.push(makeSample({ t: i * 250, cp: 9, fl: 2, ct: 93, pr: 5 }));
    }

    const shot = makeShot({
      sampleCount: 40,
      duration: 10000,
      samples,
      phases: [], // no transitions
    });

    const result = analyzeShotData(shot);

    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].name).toBe('');
    expect(result.phases[0].phaseNumber).toBe(0);
    expect(result.phases[0].sampleCount).toBe(40);
    expect(result.phases[0].pressure.avg).toBeCloseTo(9, 0);
  });

  it('detects brew-by-weight mode from systemInfo bit 0', () => {
    const samples: ShotSample[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push(
        makeSample({
          t: i * 250,
          systemInfo: {
            raw: 1,
            shotStartedVolumetric: true,
            currentlyVolumetric: true,
            bluetoothScaleConnected: true,
            volumetricAvailable: true,
            extendedRecording: false,
          },
        }),
      );
    }

    const shot = makeShot({ sampleCount: 10, duration: 2500, samples });
    const result = analyzeShotData(shot);
    expect(result.isBrewByWeight).toBe(true);
  });

  it('reports isBrewByWeight false when systemInfo bit 0 is not set', () => {
    const samples: ShotSample[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push(makeSample({ t: i * 250 }));
    }

    const shot = makeShot({ sampleCount: 10, duration: 2500, samples });
    const result = analyzeShotData(shot);
    expect(result.isBrewByWeight).toBe(false);
  });

  it('computes weight flow rate via regression (non-null when weight data present)', () => {
    const samples: ShotSample[] = [];
    // 80 samples = 20s at 250ms interval, linearly increasing weight ~2 g/s
    for (let i = 0; i < 80; i++) {
      samples.push(
        makeSample({
          t: i * 250,
          v: i * 0.5, // 0.5g per 250ms = 2 g/s
          cp: 9,
          fl: 2,
          ct: 93,
          pr: 5,
        }),
      );
    }

    const shot = makeShot({
      sampleCount: 80,
      duration: 20000,
      weight: 40,
      samples,
      phases: [{ sampleIndex: 0, phaseNumber: 0, phaseName: 'Brew' }],
    });

    const result = analyzeShotData(shot);

    expect(result.phases[0].weightFlowRate).not.toBeNull();
    // Should be approximately 2 g/s
    expect(result.phases[0].weightFlowRate!).toBeCloseTo(2, 0);
    expect(result.avgWeightFlowRate).not.toBeNull();
    expect(result.avgWeightFlowRate!).toBeCloseTo(2, 0);
  });

  it('returns null weight flow rate when no weight data', () => {
    const samples: ShotSample[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push(makeSample({ t: i * 250, v: 0 }));
    }

    const shot = makeShot({
      sampleCount: 20,
      duration: 5000,
      samples,
      phases: [{ sampleIndex: 0, phaseNumber: 0, phaseName: 'Brew' }],
    });

    const result = analyzeShotData(shot);
    expect(result.phases[0].weightFlowRate).toBeNull();
    expect(result.avgWeightFlowRate).toBeNull();
  });

  it('handles empty samples array gracefully', () => {
    const shot = makeShot({ sampleCount: 0, duration: 0, samples: [] });
    const result = analyzeShotData(shot);

    expect(result.phases).toHaveLength(0);
    expect(result.totalDurationMs).toBe(0);
    expect(result.isBrewByWeight).toBe(false);
    expect(result.avgPuckResistance).toBeNull();
    expect(result.peakPuckResistance).toBeNull();
    expect(result.avgWeightFlowRate).toBeNull();
    expect(result.exitReason).toBeNull();
    expect(result.phaseSummary).toBe('');
  });

  it('handles single-sample shots without crashing', () => {
    const samples = [makeSample({ t: 0, cp: 5, ct: 92, fl: 1, pr: 3 })];
    const shot = makeShot({
      sampleCount: 1,
      duration: 250,
      samples,
      phases: [{ sampleIndex: 0, phaseNumber: 0, phaseName: 'Brew' }],
    });

    const result = analyzeShotData(shot);

    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].sampleCount).toBe(1);
    expect(result.phases[0].pressure.min).toBe(result.phases[0].pressure.max);
    expect(result.phases[0].durationMs).toBe(0);
    // Single sample can't produce regression
    expect(result.phases[0].weightFlowRate).toBeNull();
  });

  it('rounds all metric values to 1 decimal place', () => {
    const samples: ShotSample[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push(makeSample({ t: i * 250, cp: 9.123456, ct: 92.789, fl: 2.3456, pr: 4.5678 }));
    }

    const shot = makeShot({ sampleCount: 20, duration: 5000, samples });
    const result = analyzeShotData(shot);

    const phase = result.phases[0];
    // Check that stats values have at most 1 decimal place
    const check = (n: number) => expect(Math.round(n * 10) / 10).toBe(n);
    check(phase.pressure.avg);
    check(phase.pressure.min);
    check(phase.pressure.max);
    check(phase.temperature.avg);
    check(phase.flow.avg);
    check(phase.puckResistance.avg);
  });

  it('preserves finalWeight from shot header', () => {
    const shot = makeShot({ weight: 36.5, samples: [makeSample({ t: 0 })], sampleCount: 1 });
    const result = analyzeShotData(shot);
    expect(result.finalWeight).toBe(36.5);
  });

  it('handles systemInfo as raw number (bit 0 check)', () => {
    const samples = [makeSample({ t: 0, systemInfo: 0x0005 })]; // bits 0 and 2 set
    const shot = makeShot({ sampleCount: 1, duration: 250, samples });
    const result = analyzeShotData(shot);
    expect(result.isBrewByWeight).toBe(true);
  });
});
