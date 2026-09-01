import { describe, expect, it } from 'vitest';
import { scoreConfidence } from '@mart/metrics';

/**
 * Confidence annotates a conclusion; it never touches the arithmetic.
 *
 * A low-confidence CPI is the same CPI, held more loosely. The score exists so
 * a reader knows how much weight it will bear, and every component is reported
 * beside it - a score nobody can decompose is one people either trust blindly
 * or ignore entirely, and both are worse than no score.
 */
describe('deterministic confidence', () => {
  it('is a function of its inputs alone', () => {
    const inputs = {
      freshness: 'fresh',
      spendCoveragePct: 95,
      ambiguousSpendPct: 0,
      sampleSize: 500,
      minimumSample: 25,
    };
    expect(scoreConfidence(inputs)).toEqual(scoreConfidence(inputs));
  });

  it('reports high when nothing material is qualifying the figure', () => {
    const result = scoreConfidence({
      freshness: 'fresh',
      spendCoveragePct: 100,
      ambiguousSpendPct: 0,
      sampleSize: 400,
      minimumSample: 25,
    });
    expect(result.level).toBe('high');
    expect(result.score).toBe(1);
  });

  it('lets one disqualifying input carry the whole score down', () => {
    // Components multiply rather than average: fresh, well-covered and
    // unambiguous but computed from four installs is not two-thirds
    // trustworthy, it is untrustworthy. Averaging would let three good inputs
    // hide the one that matters, which is the case the score exists to surface.
    const result = scoreConfidence({
      freshness: 'fresh',
      spendCoveragePct: 100,
      ambiguousSpendPct: 0,
      sampleSize: 4,
      minimumSample: 25,
    });
    expect(result.level).toBe('low');
    const sample = result.components.find((c) => c.input === 'sample');
    expect(sample?.score).toBeCloseTo(4 / 25, 6);
  });

  it("explains every component in the reader's terms", () => {
    const result = scoreConfidence({
      freshness: 'stale',
      spendCoveragePct: 42.5,
      ambiguousSpendPct: 12,
      sampleSize: 30,
      minimumSample: 25,
    });
    expect(result.components.map((c) => c.input).sort()).toEqual([
      'coverage',
      'freshness',
      'mapping',
      'sample',
    ]);
    for (const component of result.components) {
      expect(component.detail.length, component.input).toBeGreaterThan(10);
      expect(component.score).toBeGreaterThanOrEqual(0);
      expect(component.score).toBeLessThanOrEqual(1);
    }
    expect(result.components.find((c) => c.input === 'coverage')?.detail).toMatch(/42.5%/);
  });

  it('scores what it was given and nothing else', () => {
    // An input MART cannot measure is absent, not assumed good.
    const result = scoreConfidence({ freshness: 'fresh' });
    expect(result.components).toHaveLength(1);
    expect(result.level).toBe('high');
  });

  it('drops a stale figure below full confidence even when everything else is clean', () => {
    const result = scoreConfidence({
      freshness: 'stale',
      spendCoveragePct: 100,
      ambiguousSpendPct: 0,
    });
    expect(result.score).toBeLessThan(1);
    expect(result.components.find((c) => c.input === 'freshness')?.detail).toMatch(/stale/);
  });
});
