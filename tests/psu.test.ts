import { describe, expect, it } from 'vitest';
import { efficiency, PSU_RATINGS, PSU_TRANSIENT_NOTE, psuVerdict, wallWatts, type PsuRating } from '../src/analysis/psu';

describe('80 PLUS efficiency curves (plan §13)', () => {
  it('reproduces the spec minimums at the table points', () => {
    expect(efficiency(0.2, 'white')).toBeCloseTo(0.8);
    expect(efficiency(0.5, 'bronze')).toBeCloseTo(0.85);
    expect(efficiency(1, 'gold')).toBeCloseTo(0.87);
    expect(efficiency(0.5, 'platinum')).toBeCloseTo(0.92);
    expect(efficiency(0.1, 'titanium')).toBeCloseTo(0.9);
    expect(efficiency(0.5, 'titanium')).toBeCloseTo(0.94);
  });

  it('interpolates between points and peaks at half load', () => {
    expect(efficiency(0.35, 'gold')).toBeCloseTo(0.885);
    for (const r of PSU_RATINGS) {
      const at = (f: number) => efficiency(f, r.id);
      expect(at(0.5)).toBeGreaterThanOrEqual(at(0.2));
      expect(at(0.5)).toBeGreaterThanOrEqual(at(1));
    }
  });

  it('falls further under 10 % load and never below the floor', () => {
    expect(efficiency(0.05, 'gold')).toBeLessThan(efficiency(0.1, 'gold'));
    expect(efficiency(0, 'none')).toBeGreaterThanOrEqual(0.5);
    expect(efficiency(1.5, 'gold')).toBeCloseTo(0.87);
  });

  it('ranks the badges', () => {
    const order: PsuRating[] = ['none', 'white', 'bronze', 'silver', 'gold', 'platinum', 'titanium'];
    for (let i = 1; i < order.length; i++) expect(efficiency(0.5, order[i])).toBeGreaterThan(efficiency(0.5, order[i - 1]));
  });
});

describe('wallWatts', () => {
  it('divides DC by the efficiency at that load', () => {
    // 500 W from a 1000 W Gold unit: 50 % load, 90 %.
    expect(wallWatts(500, 1000, 'gold')).toBeCloseTo(555.6, 0);
    expect(wallWatts(0, 1000, 'gold')).toBe(0);
    expect(wallWatts(500, 0, 'gold')).toBe(0);
  });
});

describe('psuVerdict: do I need a bigger PSU', () => {
  it('this box: 720 W sustained on a 1000 W unit is good', () => {
    const v = psuVerdict(720, 1000);
    expect(v.band).toBe('good');
    expect(v.headroomW).toBe(280);
    expect(v.recommendedW).toBeNull();
    expect(v.sentence).toContain('72 %');
  });

  it('850 W on a 1000 W unit is tight and names the next common size', () => {
    const v = psuVerdict(850, 1000);
    expect(v.band).toBe('tight');
    expect(v.recommendedW).toBe(1300);
    expect(v.sentence).toContain('1300 W');
  });

  it('over the rating is a hardware verdict, not a setting', () => {
    const v = psuVerdict(700, 650);
    expect(v.band).toBe('over');
    expect(v.recommendedW).toBe(1000);
    expect(v.sentence).toContain('not a setting');
  });

  it('a lightly loaded supply is generous, with nothing to buy', () => {
    const v = psuVerdict(300, 1000);
    expect(v.band).toBe('generous');
    expect(v.recommendedW).toBeNull();
  });

  it('the transient note says what 10 Hz polling cannot see', () => {
    expect(PSU_TRANSIENT_NOTE).toMatch(/ten times a second/);
    expect(PSU_TRANSIENT_NOTE).toMatch(/microseconds/);
  });
});
