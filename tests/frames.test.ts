import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { frameTimeMs, parseHeader, parseLine, parsePresentMonCsv } from '../src/analysis/frames';

const sample = readFileSync(new URL('../docs/phase0-presentmon-sample.csv', import.meta.url), 'latin1');

describe('parsePresentMonCsv on the real Phase 0 rows', () => {
  const { header, rows } = parsePresentMonCsv(sample);

  it('reads the 28-column header and all ten rows', () => {
    expect(header).toHaveLength(28);
    expect(header[0]).toBe('Application');
    expect(header[27]).toBe('MsClickToPhotonLatency');
    expect(rows).toHaveLength(10);
  });

  it('parses numbers, keeps QPC ticks exact and turns NA into null', () => {
    const r = rows[0];
    expect(r.application).toBe('claude.exe');
    expect(r.processId).toBe(17852);
    expect(r.presentMode).toBe('Hardware Composed: Independent Flip');
    expect(r.timeInQpc).toBe(746560840327);
    expect(r.cpuStartQpc).toBe(746560801855);
    expect(frameTimeMs(r)).toBeCloseTo(3.9022, 4);
    expect(r.msBetweenSimulationStart).toBeNull();
    expect(r.msAnimationError).toBeNull();
    expect(r.msFlipDelay).toBeNull();
    expect(r.msClickToPhotonLatency).toBeNull();
    expect(rows[1].msAnimationError).toBeCloseTo(-0.311, 3);
  });

  it('holds the v2 identity: MsBetweenAppStart = MsCPUBusy + MsCPUWait', () => {
    for (const r of rows) expect(r.msBetweenAppStart).toBeCloseTo(r.msCpuBusy! + r.msCpuWait!, 3);
  });

  it('is indifferent to CRLF', () => {
    const crlf = sample.replace(/\r?\n/g, '\r\n');
    expect(parsePresentMonCsv(crlf).rows).toEqual(rows);
  });
});

describe('parsing by header name', () => {
  const [headerLine, ...dataLines] = sample.trim().split(/\r?\n/);
  const header = parseHeader(headerLine);

  it('survives a permuted header', () => {
    const order = header.map((_, i) => i).reverse();
    const permuted = [order.map((i) => header[i]).join(','), ...dataLines.map((l) => {
      const cells = l.split(',');
      return order.map((i) => cells[i]).join(',');
    })].join('\n');
    expect(parsePresentMonCsv(permuted).rows).toEqual(parsePresentMonCsv(sample).rows);
  });

  it('nulls an optional column the header does not carry', () => {
    const drop = header.indexOf('MsGPUWait');
    const trimmed = [header.filter((_, i) => i !== drop).join(','), ...dataLines.map((l) => l.split(',').filter((_, i) => i !== drop).join(','))].join('\n');
    const { rows } = parsePresentMonCsv(trimmed);
    expect(rows).toHaveLength(10);
    expect(rows[0].msGpuWait).toBeNull();
    expect(rows[0].msGpuTime).toBeCloseTo(4.0815, 4);
    expect(rows[0].msGpuBusy).toBeCloseTo(0.1585, 4);
  });

  it('streams line by line and drops what is not a frame', () => {
    expect(parseLine(header, dataLines[2] + '\r')?.timeInQpc).toBe(746560936779);
    expect(parseLine(header, '')).toBeNull();
    expect(parseLine(header, headerLine)).toBeNull();
    expect(parseLine(header, 'a,b,c')).toBeNull();
    const noQpc = dataLines[0].split(',');
    noQpc[header.indexOf('TimeInQPC')] = 'NA';
    expect(parseLine(header, noQpc.join(','))).toBeNull();
  });

  it('returns nothing for an empty capture', () => {
    expect(parsePresentMonCsv('')).toEqual({ header: [], rows: [] });
    expect(parsePresentMonCsv(headerLine + '\r\n')).toEqual({ header, rows: [] });
  });
});
