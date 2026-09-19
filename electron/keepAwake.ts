/**
 * Plan section 17c, 'No sleeping mid-run', for the runs the main process hosts (a frame
 * capture: PresentMon and the built-in bench live here, not in the collector). Electron's
 * powerSaveBlocker with 'prevent-app-suspension' is ES_SYSTEM_REQUIRED on Windows: the
 * machine stays awake, the display is never held (the other blocker type is not used). One
 * blocker per named run; every end path releases through release().
 */
import { powerSaveBlocker } from 'electron';

const held = new Map<string, number>();

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
