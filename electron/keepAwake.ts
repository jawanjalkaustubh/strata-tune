/**
 * Plan section 17c, 'No sleeping mid-run', for the runs the main process hosts (a frame
 * capture: PresentMon and the built-in bench live here, not in the collector). Electron's
 * powerSaveBlocker with 'prevent-app-suspension' is ES_SYSTEM_REQUIRED on Windows and an
 * IOPMAssertion against idle sleep on macOS: the machine stays awake, the display is never
 * held (the other blocker type is not used). One blocker per named run; every end path
 * releases through release().
 */
import { powerSaveBlocker } from 'electron';

const held = new Map<string, number>();
/** Overlapping awakeDuring() calls under one name share its blocker: the last to finish releases it. */
const counts = new Map<string, number>();

/** Holds the system awake for the named run; a second hold under the same name is one hold. */
export function hold(name: string): void {
  if (held.has(name)) return;
  held.set(name, powerSaveBlocker.start('prevent-app-suspension'));
}

/** Releases the named run's hold; nothing happens when it was not held. */
export function release(name: string): void {
  const id = held.get(name);
  if (id === undefined) return;
  held.delete(name);
  if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
}

/** Whether the named run holds the system awake now, for the tests and the log. */
export const holding = (name: string): boolean => held.has(name);

/** Holds the system awake while `work` runs, released however it ends (a result, a throw, a Stop). Ref-counted per name. */
export async function awakeDuring<T>(name: string, work: () => Promise<T>): Promise<T> {
  counts.set(name, (counts.get(name) ?? 0) + 1);
  hold(name);
  try {
    return await work();
  } finally {
    const left = (counts.get(name) ?? 1) - 1;
    if (left > 0) counts.set(name, left);
    else {
      counts.delete(name);
      release(name);
    }
  }
}

/**
 * macOS: Measure, the audit's loads, the LLM benchmark and llama-benchy run in this process (the
 * in-process collector, docs/MACOS.md), so this process holds the Mac awake for them. Windows
 * runs `work` untouched: its loads and benches are held by the elevated collector (KeepAwake.cs).
 */
export function keepAwakeOnMac<T>(name: string, work: () => Promise<T>): Promise<T> {
  return process.platform === 'darwin' ? awakeDuring(name, work) : work();
}

/** Quit: every hold goes, whatever run is still in flight. */
export function releaseAll(): void {
  for (const name of [...held.keys()]) release(name);
  counts.clear();
}
