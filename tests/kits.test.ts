import { describe, expect, it } from 'vitest';
import { cleanPartNumber, ratedSpeedFor } from '../src/analysis/kits';

const rated = (part: string) => ratedSpeedFor(part)?.ratedMts ?? null;
const profile = (part: string) => ratedSpeedFor(part)?.profile ?? null;

describe('ratedSpeedFor: one real part number per vendor scheme, spelled as the SPD reports it', () => {
  it('G.Skill: F5-/F4- then the MT/s', () => {
    expect(ratedSpeedFor('F5-6000J2836G16GX2-TZ5NR')).toEqual({ vendor: 'G.Skill', ratedMts: 6000, profile: 'xmp' });
    expect(rated('F5-6000J2836G16G')).toBe(6000);
    expect(rated('F5-6400J3239G16G')).toBe(6400);
    expect(rated('F4-3600C16D-16GTZNC')).toBe(3600);
  });

  it('Corsair: capacity, GX5, module count, revision letter, MT/s, then C or the EXPO kits\' Z; SODIMMs are CMSX', () => {
    expect(ratedSpeedFor('CMK32GX5M2B6000C30')).toEqual({ vendor: 'Corsair', ratedMts: 6000, profile: 'xmp' });
    expect(rated('CMH32GX5M2B5600C36')).toBe(5600);
    expect(rated('CMT32GX5M2X6000C30')).toBe(6000);
    expect(rated('CMK16GX4M2B3200C16')).toBe(3200);
    expect(rated('CMK32GX5M2B6000Z30')).toBe(6000);
    expect(rated('CMSX32GX5M2A4800C40')).toBe(4800);
  });

  it('Kingston FURY DDR5: two digits times 100; DDR4 is deliberately unknown', () => {
    expect(ratedSpeedFor('KF560C36BBEK2-32')).toEqual({ vendor: 'Kingston FURY', ratedMts: 6000, profile: 'xmp' });
    expect(rated('KF548C38BBK2-32')).toBe(4800);
    expect(rated('KF432C16BB/8')).toBeNull();
  });

  it('Kingston ValueRAM DDR5 is a JEDEC part', () => {
    expect(rated('KVR48U40BS8-16')).toBe(4800);
    expect(ratedSpeedFor('KVR56U46BS8-16')).toEqual({ vendor: 'Kingston ValueRAM', ratedMts: 5600, profile: 'jedec' });
    expect(rated('KVR32N22S8/8')).toBeNull();
  });

  it('Crucial DDR5: plain CT parts are JEDEC, the Pro CP parts carry a profile', () => {
    expect(ratedSpeedFor('CT16G56C46U5')).toEqual({ vendor: 'Crucial', ratedMts: 5600, profile: 'jedec' });
    expect(profile('CT16G56C46U5.M8D1')).toBe('jedec');
    expect(ratedSpeedFor('CP2K16G60C36U5B')).toEqual({ vendor: 'Crucial Pro', ratedMts: 6000, profile: 'xmp' });
    expect(rated('CT2K16G48C40U5')).toBe(4800);
    expect(rated('CT16G56C46S5')).toBe(5600);
    expect(rated('CT8G4DFRA32A')).toBeNull();
  });

  it('TeamGroup: the SPD says TEAMGROUP-UD5-6000, never the retail SKU', () => {
    expect(ratedSpeedFor('TEAMGROUP-UD5-6000')).toEqual({ vendor: 'TeamGroup', ratedMts: 6000, profile: 'xmp' });
    expect(rated('TEAMGROUP-UD4-3600')).toBe(3600);
    expect(rated('FF3D532G6000HC38ADC01')).toBeNull();
  });

  it('Patriot Viper DDR5', () => {
    expect(ratedSpeedFor('PVV532G6000C36K')).toEqual({ vendor: 'Patriot Viper', ratedMts: 6000, profile: 'xmp' });
    expect(rated('PVVR532G6000C36K')).toBe(6000);
    expect(rated('PVE532G5600C36K')).toBe(5600);
    expect(rated('PVX532G80C38K')).toBeNull();
  });

  it('XPG carries a profile; ADATA Premier is JEDEC', () => {
    expect(ratedSpeedFor('AX5U6000C3016G-DCLABK')).toEqual({ vendor: 'XPG', ratedMts: 6000, profile: 'xmp' });
    expect(ratedSpeedFor('AD5U480016G-B')).toEqual({ vendor: 'ADATA', ratedMts: 4800, profile: 'jedec' });
    expect(rated('AX4U360016G18I-DB50')).toBe(3600);
  });
});

describe('ratedSpeedFor: anything else is unknown, never a guess', () => {
  it('OEM and unlisted parts', () => {
    expect(rated('M378A1K43EB2-CWE')).toBeNull();
    expect(rated('HMCG78AGBUA081N')).toBeNull();
    expect(rated('Unknown')).toBeNull();
    expect(rated('')).toBeNull();
    expect(rated('   ')).toBeNull();
  });

  it('a capture outside the DDR range is a misread', () => {
    expect(rated('F5-99999J')).toBeNull();
    expect(rated('F4-1000C')).toBeNull();
  });

  it('is case- and whitespace-tolerant', () => {
    expect(rated('  f5-6000j2836g16g ')).toBe(6000);
  });
});

describe('cleanPartNumber', () => {
  it('cuts at the first byte that is not printable ASCII (the junk one DIMM here appends)', () => {
    expect(cleanPartNumber('F5-6000J2836G16G��A�A�A�}')).toBe('F5-6000J2836G16G');
    expect(cleanPartNumber('F5-6000J2836G16G  ')).toBe('F5-6000J2836G16G');
    expect(rated('F5-6000J2836G16G��A')).toBe(6000);
  });

  it('trims and upper-cases', () => {
    expect(cleanPartNumber(' cmk32gx5m2b6000c30 ')).toBe('CMK32GX5M2B6000C30');
  });
});
