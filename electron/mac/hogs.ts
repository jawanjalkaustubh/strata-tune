/**
 * The audit's "background hogs" sample (plan §8) from two `ps` readings `seconds` apart:
 * each process's CPU time delta over the window as a share of the whole machine, and its
 * resident set. Our own process tree never counts, like the Windows collector's own-pid rule.
 */
import { execFile } from 'child_process';
import * as path from 'path';
import type { HogsResult, ProcessSample } from '../../src/collector-types';

interface Proc {
  pid: number;
  ppid: number;
  cpuSeconds: number;
  rssKiB: number;
  command: string;
}

/** ps prints cumulative CPU time as "[[D-]HH:]MM:SS.ss". */
export function parseCpuTime(text: string): number {
  let days = 0;
  let rest = text;
  const d = /^(\d+)-(.*)$/.exec(rest);
  if (d) {
    days = Number(d[1]);
    rest = d[2];
  }
  const parts = rest.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  return days * 86400 + seconds;
}

export function parsePs(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split('\n').slice(1)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), cpuSeconds: parseCpuTime(m[3]), rssKiB: Number(m[4]), command: m[5].trim() });
  }
  return out;
}

function ps(): Promise<Proc[]> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-Ao', 'pid,ppid,time,rss,comm'], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(parsePs(String(out)))));
  });
}

/** The pids in `roots` and every descendant, so a renderer or GPU helper of ours is excluded with the main process. */
export function excludedPids(procs: Proc[], roots: number[]): Set<number> {
  const out = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (!out.has(p.pid) && out.has(p.ppid)) {
        out.add(p.pid);
        grew = true;
      }
    }
  }
  return out;
}

export function hogsFrom(before: Proc[], after: Proc[], seconds: number, logicalCpus: number, exclude: Set<number>): ProcessSample[] {
  const prior = new Map(before.map((p) => [p.pid, p]));
  const samples: ProcessSample[] = [];
  for (const p of after) {
    if (exclude.has(p.pid)) continue;
    const was = prior.get(p.pid);
    const delta = Math.max(0, p.cpuSeconds - (was?.cpuSeconds ?? p.cpuSeconds));
    const cpuPercent = seconds > 0 && logicalCpus > 0 ? (delta / seconds / logicalCpus) * 100 : 0;
    samples.push({ pid: p.pid, name: path.basename(p.command) || p.command, cpuPercent, workingSetMiB: p.rssKiB / 1024 });
  }
  return samples.sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 40);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function sampleHogs(seconds: number, excludeRoots: number[], logicalCpus: number): Promise<HogsResult> {
  const before = await ps();
  await sleep(Math.max(0.5, seconds) * 1000);
  const after = await ps();
  const exclude = excludedPids(after, excludeRoots);
  return { seconds, logicalCpus, processes: hogsFrom(before, after, seconds, logicalCpus, exclude) };
}
