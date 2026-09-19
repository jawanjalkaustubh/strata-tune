import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { LEGAL_FILE_NAMES, describeWindows, legalFilePaths, parseDxdiag, parseRegQuery, readLegal } from '../electron/about';
import { PRIVACY_SECTION, inline, legalText, parseMarkdown, sectionOf } from '../src/components/about/legalText';
import { EXPORT_FOOTER, REDACTED, buildSystemReport, hardwareSummary, redact, redactText } from '../src/components/about/systemReport';
import { directXLine } from '../src/components/about/Facts';
import { clocksText, coreRows } from '../src/components/about/ClocksTool';
import { backgroundBusy, thermalDrift } from '../src/components/about/ValidationTool';
import type { AboutSystem } from '../electron/about';
import type { SensorMeta, SensorRow, Timers } from '../src/collector-types';
import { devbox, devboxMeta, devboxTick, loadRun } from './fixtures';

// The helpers under test live beside components that read window.strata; outside Electron (and outside a browser) there is none.
vi.mock('../src/api', () => ({ api: undefined, inElectron: false, ipcErrorMessage: (e: unknown) => String(e) }));

const ROOT = path.resolve(__dirname, '..');
const NOW = '2026-09-16T20:15:00.000Z';

describe('legal file resolver (plan 27a: one source, bundled verbatim)', () => {
  it('resolves to the repo root in dev and to the resources folder once packaged', () => {
    const dev = legalFilePaths({ isPackaged: false, appPath: 'D:\\repo', resourcesPath: 'D:\\repo\\node_modules\\electron\\dist\\resources' });
    expect(dev.licence).toBe(path.join('D:\\repo', 'LICENSE'));
    expect(dev.disclaimer).toBe(path.join('D:\\repo', 'DISCLAIMER.md'));
    expect(dev.thirdParty).toBe(path.join('D:\\repo', 'THIRD-PARTY-NOTICES.md'));
    const packaged = legalFilePaths({ isPackaged: true, appPath: 'C:\\Program Files\\Strata Tune\\resources\\app.asar', resourcesPath: 'C:\\Program Files\\Strata Tune\\resources' });
    for (const p of Object.values(packaged)) expect(path.dirname(p)).toBe('C:\\Program Files\\Strata Tune\\resources');
    expect(Object.values(LEGAL_FILE_NAMES).sort()).toEqual(['DISCLAIMER.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md']);
  });

  it('reads the three files from this repo verbatim and reports a missing one by path', () => {
    const texts = readLegal(legalFilePaths({ isPackaged: false, appPath: ROOT, resourcesPath: '' }));
    expect(texts.missing).toEqual([]);
    expect(texts.licence).toBe(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf-8'));
    expect(texts.disclaimer).toBe(fs.readFileSync(path.join(ROOT, 'DISCLAIMER.md'), 'utf-8'));
    expect(texts.thirdParty).toBe(fs.readFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf-8'));
    const broken = readLegal({ licence: path.join(ROOT, 'LICENSE'), disclaimer: path.join(ROOT, 'NO-SUCH-FILE.md'), thirdParty: path.join(ROOT, 'THIRD-PARTY-NOTICES.md') });
    expect(broken.disclaimer).toBeNull();
    expect(broken.missing).toEqual([path.join(ROOT, 'NO-SUCH-FILE.md')]);
  });

  it('the Privacy tab is the disclaimer\'s section 6 on its own, heading included, and nothing else', () => {
    const disclaimer = fs.readFileSync(path.join(ROOT, 'DISCLAIMER.md'), 'utf-8');
    const privacy = sectionOf(disclaimer, PRIVACY_SECTION);
    expect(privacy.startsWith('## 6. Your data stays yours')).toBe(true);
    expect(privacy).toContain('no telemetry');
    expect(privacy).not.toContain('## 7.');
    expect(privacy).not.toContain('Hardware risk');
    expect(legalText({ licence: 'L', disclaimer, thirdParty: 'T', missing: [] }, 'privacy')).toBe(privacy);
    expect(legalText({ licence: 'L', disclaimer: null, thirdParty: 'T', missing: [] }, 'privacy')).toBeNull();
    expect(sectionOf(disclaimer, 42)).toBe('');
  });
});

describe('markdown blocks keep every word of the file', () => {
  it('headings, paragraphs joined by lines, bullets with continuation, quotes, tables and rules', () => {
    const md = ['# Title', '', 'One line', 'two lines.', '', '- first bullet', '  continues here', '- second', '', '> quoted', '> more', '>', '> second paragraph', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', '---', 'tail'].join('\n');
    expect(parseMarkdown(md)).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'paragraph', text: 'One line two lines.' },
      { kind: 'bullets', items: ['first bullet continues here', 'second'] },
      { kind: 'quote', text: 'quoted more' },
      { kind: 'quote', text: 'second paragraph' },
      { kind: 'table', header: ['A', 'B'], rows: [['1', '2']] },
      { kind: 'rule' },
      { kind: 'paragraph', text: 'tail' }
    ]);
  });

  it('inline keeps bold and code spans as segments and the plain text otherwise', () => {
    expect(inline('Sent **no telemetry** to `127.0.0.1` ever')).toEqual([
      { kind: 'text', text: 'Sent ' },
      { kind: 'bold', text: 'no telemetry' },
      { kind: 'text', text: ' to ' },
      { kind: 'code', text: '127.0.0.1' },
      { kind: 'text', text: ' ever' }
    ]);
  });

  it('every sentence of the real disclaimer survives parsing', () => {
    const disclaimer = fs.readFileSync(path.join(ROOT, 'DISCLAIMER.md'), 'utf-8');
    const rendered = parseMarkdown(disclaimer)
      .map((b) => (b.kind === 'bullets' ? b.items.join(' ') : b.kind === 'table' ? [...b.header, ...b.rows.flat()].join(' ') : b.kind === 'rule' ? '' : b.text))
      .join('\n');
    for (const line of disclaimer.split(/\r?\n/)) {
      const text = line.replace(/^#+\s+|^-\s+|^>\s?/, '').trim();
      if (text) expect(rendered).toContain(text);
    }
  });
});

describe('Windows and DirectX facts', () => {
  it('names Windows 11 from the build, the edition from EditionID, and appends the UBR', () => {
    const reg = parseRegQuery([
      '', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion',
      '    ProductName    REG_SZ    Windows 10 Home',
      '    EditionID    REG_SZ    Core',
      '    DisplayVersion    REG_SZ    25H2',
      '    CurrentBuild    REG_SZ    26200',
      '    UBR    REG_DWORD    0x4d2',
      ''
    ].join('\r\n'));
    expect(reg.UBR).toBe('1234');
    expect(describeWindows(reg, '10.0.26200')).toEqual({ name: 'Windows 11 Home', displayVersion: '25H2', build: '26200.1234' });
    expect(describeWindows({ EditionID: 'ProfessionalWorkstation', CurrentBuild: '19045' }, '10.0.19045').name).toBe('Windows 10 Pro for Workstations');
    expect(describeWindows({}, '10.0.26200')).toEqual({ name: 'Windows 11', displayVersion: '', build: '26200' });
  });

  it('parses dxdiag\'s text for the version, each card\'s feature levels, driver model and driver, and the row reads them', () => {
    const text = [
      '      Operating System: Windows 11 Home 64-bit (10.0, Build 26200)',
      '      DirectX Version: DirectX 12',
      '---------------', 'Display Devices', '---------------',
      '           Card name: NVIDIA GeForce RTX 5090',
      '      Display Memory: 48013 MB',
      '      Driver Version: 32.0.16.1692',
      '      Feature Levels: 12_2,12_1,12_0,11_1,11_0,10_1,10_0,9_3,9_2,9_1,1_0_CORE',
      '        Driver Model: WDDM 3.2',
      '           Card name: AMD Radeon(TM) Graphics',
      '      Driver Version: Unknown',
      '      Feature Levels: 12_2,12_1',
      '        Driver Model: WDDM 3.2'
    ].join('\r\n');
    const dx = parseDxdiag(text);
    expect(dx.version).toBe('DirectX 12');
    expect(dx.devices).toEqual([
      { name: 'NVIDIA GeForce RTX 5090', driverVersion: '32.0.16.1692', driverModel: 'WDDM 3.2', featureLevels: ['12_2', '12_1', '12_0', '11_1', '11_0', '10_1', '10_0', '9_3', '9_2', '9_1', '1_0_CORE'] },
      { name: 'AMD Radeon(TM) Graphics', driverVersion: '', driverModel: 'WDDM 3.2', featureLevels: ['12_2', '12_1'] }
    ]);
    expect(directXLine({ ...dx, readAt: NOW, release: '10.0.26200' })).toBe('DirectX 12 · feature level 12_2 · WDDM 3.2');
    expect(directXLine('reading')).toContain('dxdiag');
  });
});

const system: AboutSystem = {
  windows: { name: 'Windows 11 Home', displayVersion: '25H2', build: '26200.1234' },
  hwinfoRunning: false, logsFolder: 'C:\\Users\\x\\AppData\\Local\\Strata Tune\\logs', dataFolder: 'C:\\Users\\x\\AppData\\Local\\Strata Tune',
  electron: '34.5.8', chrome: '132.0.0.0', collector: { status: 'connected', message: 'Connected' },
  health: { ok: true, pid: 100, version: '0.1.0', elevated: true, pawnIo: { installed: true, version: '2.2.0' }, nvml: { available: true, driver: '616.92' }, lhm: { available: true }, pdh: { available: true }, qpcFrequency: 1e7, startedAt: NOW, uptime: 120, warming: false }
};
const timers: Timers = { currentMs: 1, finestMs: 0.5, coarsestMs: 15.625, qpcFrequency: 1e7, qpcSource: 'TSC', qpcNote: 'invariant TSC', requesters: [{ pid: 4242, name: 'Discord.exe', path: 'C:\\Apps\\Discord.exe', periodMs: 1, own: false }], requestersNote: null };

describe('system report (plan 17): snapshot, spec sheet, sensors, serials redacted', () => {
  const meta: SensorMeta[] = devboxMeta();
  const latest: SensorRow = { qpc: devboxTick().qpc, values: devboxTick().sensors };

  it('redacts serial and uuid fields, PCI instance ids and "Serial Number:" lines, and leaves the board model alone', () => {
    const dirty = {
      motherboard: { product: 'MAG X870E TOMAHAWK WIFI (MS-7E59)', serialNumber: '07E5920_O81B000000', SMBIOS_UUID: '1B2C3D4E-0000-1111-2222-333344445555' },
      note: 'Motherboard Serial: 07E5920_O81B000000 and PCI\\VEN_10DE&DEV_2B85&SUBSYS_89EC1043&REV_A1\\4&7E5920&0&0008 plus PCI_VEN_10DE&DEV_2B85&SUBSYS_89EC1043&REV_A1_4&7E5920&0&0008',
      disks: [{ friendlyName: 'Samsung SSD 980 PRO 2TB', serial: 'S6Z2NJ0T07E5920Z' }]
    };
    const clean = redact(dirty);
    const text = JSON.stringify(clean);
    expect(text).not.toContain('07E5920');
    expect(text).not.toContain('7E5920&0');
    expect(text).not.toContain('1B2C3D4E');
    expect(clean.motherboard.serialNumber).toBe(REDACTED);
    expect(clean.disks[0].serial).toBe(REDACTED);
    expect(clean.motherboard.product).toBe('MAG X870E TOMAHAWK WIFI (MS-7E59)');
    expect(clean.disks[0].friendlyName).toBe('Samsung SSD 980 PRO 2TB');
    expect(redactText('Processor Serial: ABC123\nName: fine')).toBe(`Processor Serial: ${REDACTED}\nName: fine`);
  });

  it('both renderings carry the snapshot, the spec sheet, the current sensors, the timers and the footer, and no serial-like field', () => {
    const report = buildSystemReport({ version: '0.1.0', generatedAt: NOW, snapshot: devbox(), meta, latest, system, directx: { version: 'DirectX 12', devices: [{ name: 'NVIDIA GeForce RTX 5090', driverVersion: '32.0.16.1692', driverModel: 'WDDM 3.2', featureLevels: ['12_2'] }], readAt: NOW, release: '10.0.26200' }, timers });
    for (const out of [report.text, report.html]) {
      expect(out).toContain('Windows 11 Home');
      expect(out).toContain('feature level 12_2');
      expect(out).toContain('AMD Ryzen 9 9950X');
      expect(out).toContain('GB202');
      expect(out).toContain('21760 shaders');
      expect(out).toContain('F5-6000J2836G16G');
      expect(out).toContain('Samsung SSD 9100 PRO 2TB');
      expect(out).toContain('Discord.exe');
      expect(out).toContain('PawnIO driver open (2.2.0)');
      expect(out).toContain(EXPORT_FOOTER);
      expect(out).toContain('Serial numbers');
      expect(out).not.toMatch(/serial\s*(number)?\s*:\s*[A-Z0-9]{6,}/i);
      expect(out).not.toContain('07E5920');
    }
    // Sensor rows come from the tick, with the sensor's own unit.
    expect(report.text).toMatch(/Core \(Tctl\/Tdie\)\s+Temperature\s+[\d.]+ °C/);
    expect(report.html).toContain('<td>Core (Tctl/Tdie)</td>');
    expect(report.html).toContain('<!doctype html>');
    expect(report.fileBase).toBe('strata-tune-system-report-2026-09-16');
  });

  it('degrades without the collector: system rows only, no sensors, still the footer', () => {
    const report = buildSystemReport({ version: '', generatedAt: NOW, snapshot: null, meta: [], latest: null, system, directx: null, timers: null });
    expect(report.text).toContain('== System ==');
    expect(report.text).not.toContain('== CPU ==');
    expect(report.text).not.toContain('Current sensors');
    expect(report.text).toContain(EXPORT_FOOTER);
  });

  it('the hardware summary is one line with CPU, GPU, RAM, board and Windows', () => {
    expect(hardwareSummary(devbox(), system)).toBe(
      'AMD Ryzen 9 9950X 16-Core Processor (16C/32T) · ASUS GeForce RTX 5090 32 GB, driver 616.92 · 32 GB RAM (2 × 16 GB at 6200 MT/s) · Micro-Star International Co., Ltd. MAG X870E TOMAHAWK WIFI (MS-7E59), BIOS 2.A60 · Windows 11 Home 25H2 build 26200.1234'
    );
    expect(hardwareSummary(null, null)).toBe('');
    expect(hardwareSummary(devbox(), null)).toContain('Microsoft Windows 11 Home build 26200');
  });
});

describe('Clocks and Validation helpers', () => {
  it('core rows read nominal, effective and the mean thread load from the tick, and the text lists them', () => {
    const cores = [{ n: 1, nominal: '/amdcpu/0/clock/1', effective: '/amdcpu/0/clock/17', loads: ['/amdcpu/0/load/1', '/amdcpu/0/load/2'] }];
    const row: SensorRow = { qpc: 1, values: { '/amdcpu/0/clock/1': 5480, '/amdcpu/0/clock/17': 212.4, '/amdcpu/0/load/1': 10, '/amdcpu/0/load/2': 30 } };
    const rows = coreRows(cores, row);
    expect(rows).toEqual([{ label: 'Core #1', nominalMhz: 5480, effectiveMhz: 212.4, loadPct: 20 }]);
    expect(coreRows(cores, null)).toEqual([{ label: 'Core #1', nominalMhz: null, effectiveMhz: null, loadPct: null }]);
    const text = clocksText('AMD Ryzen 9 9950X', rows, devbox().gpus);
    expect(text).toContain('Core #1       5480 /   212  20 %');
    expect(text).toContain('SM 1275 MHz');
  });

  it('thermal drift trips only when the card was still warming at the end; background busy names the process', () => {
    const steady = loadRun('heavy', 60, () => ({ temperatureC: 70 }));
    expect(thermalDrift(steady)).toBe(false);
    const warming = loadRun('heavy', 60, (t) => ({ temperatureC: 40 + t * 0.6 }));
    expect(thermalDrift(warming)).toBe(true);
    expect(backgroundBusy({ seconds: 3, logicalCpus: 32, processes: [{ pid: 1, name: 'OneDrive.exe', cpuPercent: 12, workingSetMiB: 200 }, { pid: 2, name: 'explorer.exe', cpuPercent: 0.3, workingSetMiB: 100 }] })).toEqual(['OneDrive.exe']);
    expect(backgroundBusy(null)).toEqual([]);
  });
});
