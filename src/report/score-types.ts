/**
 * The comparison sheet of a scored run (plan §16 'Save as .html'): what the score layout
 * renders, as plain values the page owns. It is built from the collector's TuneExport (or a
 * bench session) by src/report/scoreSheet.ts and embedded in the one report template, so a
 * saved file stays readable when the wire shapes change. Nothing here names the machine:
 * the builder passes every string through the §17 redaction.
 */

export interface SheetStat {
  avg: number;
  max: number;
}

export interface SheetClocks {
  smMhz: number;
  memMhz: number;
}

export interface SheetScore {
  points: number;
  computePoints: number;
  bandwidthPoints: number;
  throughputGsps: number;
  bandwidthGBs: number;
}

/** One rung of the climb: the offset above the baseline on its own axis, its points or what stopped it. */
export interface SheetRung {
  ladder: 'core' | 'memory';
  offsetMhz: number;
  verdict: 'stable' | 'unstable' | 'invalid' | 'device-lost';
  stage: number | null;
  points: number | null;
  held: SheetClocks | null;
  note: string;
}

/** The GPU over the run; a figure the card does not report is null and its row is left out. */
export interface SheetGpu {
  coreMhz: SheetStat;
  memMhz: SheetStat;
  coreC: SheetStat;
  hotspotC: SheetStat | null;
  memoryJunctionC: SheetStat | null;
  boardW: SheetStat;
  powerCapW: number;
  /** Share of samples under each decoded limit reason, 0..1. */
  limitShare: Record<string, number>;
  fanPercent: SheetStat | null;
}

export interface SheetCpu {
  effectiveMhz: SheetStat | null;
  packageW: SheetStat | null;
  tctlC: SheetStat | null;
}

export interface SheetRam {
  configuredMts: number | null;
  /** The DIMM rail as the board's super-IO reads it, when the snapshot's sensors carried it. */
  dimmVoltage: number | null;
  modules: number;
  totalGiB: number;
}

export interface SheetValidity {
  label: string;
  ok: boolean | null;
  text: string;
}

export interface ScoreSheet {
  /** The official run of a hunt, the card as found alone, or the built-in bench. */
  run: 'headroom' | 'as-found' | 'bench';
  title: string;
  measuredAt: string;
  appVersion: string;
  /** Plan §17d: every score names its device class, in words. */
  deviceClass: string | null;
  score: SheetScore | null;
  referencePoints: number;
  asFoundPoints: number | null;
  /** The certified offsets in our units and in the vendor sliders' (the collector's conversion), null from a bench or when nothing was certified. */
  certified: { coreMhz: number; memMhz: number } | null;
  vendorSlider: { coreMhz: number; memMhz: number } | null;
  sliderTotal: { coreMhz: number; memMhz: number } | null;
  vendor: { coreMhz: number; memMhz: number } | null;
  held: { asFound: SheetClocks | null; certified: SheetClocks | null; now: SheetClocks | null };
  rungs: SheetRung[];
  telemetry: { samples: number; seconds: number; gpu: SheetGpu | null; cpu: SheetCpu | null } | null;
  ram: SheetRam | null;
  hardware: { cpu: string; gpu: string; board: string; bios: string; driver: string; windows: string };
  psu: { watts: number | null; rating: string | null };
  validity: SheetValidity[];
  confidence: string | null;
  /** Why the confidence is what it is, in the words the page uses (src/components/tune/wire.ts confidenceWhy); null on a bench. */
  confidenceWhy?: string | null;
  /** How each ladder ended (the collector's own sentence), so a sheet that says "+0 core" also says why; empty on a bench. */
  stops?: { ladder: 'core' | 'memory'; text: string }[];
  /** The export's own lines (the value set, the truth line), as the collector or its mirror wrote them. */
  lines: string[];
  /** Plan §27a's footer for every export, carried in the data so the standalone renderer needs none of the app's modules. */
  footer: string;
}
