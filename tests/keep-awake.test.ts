import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Plan section 17c, 'No sleeping mid-run' (phase 8 follow-up item 12): the collector holds
 * SetThreadExecutionState(ES_SYSTEM_REQUIRED | ES_CONTINUOUS) for a hunt and a load run, the
 * main process a powerSaveBlocker for a capture, and every end, stop and abort path releases
 * it; the display is never held. The C# has no test project, so the sources are read: the
 * flags, the hold at each run's start and the release in each run's finally.
 */
const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('keep-awake during runs', () => {
  it('the collector holds the system, never the display, and clears with ES_CONTINUOUS alone', () => {
    const src = read('collector/StrataTune.Collector/KeepAwake.cs');
    expect(src).toMatch(/EsContinuous = 0x80000000/);
    expect(src).toMatch(/EsSystemRequired = 0x00000001/);
    expect(src).not.toMatch(/0x00000002|DisplayRequired/i);
    expect(src).toContain('EntryPoint = "SetThreadExecutionState"');
    expect(src).toMatch(/SetExecutionState\(wanted \? EsContinuous \| EsSystemRequired : EsContinuous\)/);
  });

  it('a hunt holds at its start and releases in the finally that also restores the baseline (the Stop and crash-exit paths run through it)', () => {
    const hunt = read('collector/StrataTune.Collector/TuneHunt.cs');
    const run = hunt.slice(hunt.indexOf('public async Task RunAsync(TuneRunContext run)'), hunt.indexOf('public void Restore(TuneRunContext run)'));
    expect(run.indexOf('KeepAwake.Hold($"tune run {run.Id}")')).toBeGreaterThan(0);
    expect(run.indexOf('KeepAwake.Hold($"tune run {run.Id}")')).toBeLessThan(run.indexOf('try'));
    const finallyBlock = run.slice(run.indexOf('finally'));
    expect(finallyBlock).toContain('KeepAwake.Release($"tune run {run.Id}")');
    // The release sits with the restore and the lock release, so a stop (OperationCanceledException) and a failure both reach it.
    expect(finallyBlock.indexOf('Restore(run)')).toBeLessThan(finallyBlock.indexOf('KeepAwake.Release'));
    expect(run).toContain('catch (OperationCanceledException)');
  });

  it('a load run or bench holds before the worker starts and releases in its finally, cancel included', () => {
    const loads = read('collector/StrataTune.Collector/LoadRunner.cs');
    const run = loads.slice(loads.indexOf('private async Task RunAsync(ActiveRun run)'));
    expect(run.indexOf('KeepAwake.Hold($"load {run.Id}")')).toBeGreaterThan(0);
    expect(run.indexOf('KeepAwake.Hold($"load {run.Id}")')).toBeLessThan(run.indexOf('Process.Start(info)'));
    expect(run.slice(run.indexOf('finally'))).toContain('KeepAwake.Release($"load {run.Id}")');
  });

  it('a capture holds a powerSaveBlocker while capturing or saving and releases on every other state, the display never held', () => {
    const awake = read('electron/keepAwake.ts');
    expect(awake).toContain("powerSaveBlocker.start('prevent-app-suspension')");
    expect(awake).not.toContain('prevent-display-sleep');
    const capture = read('electron/capture.ts');
    const set = capture.slice(capture.indexOf('private set(patch: Partial<CaptureState>)'), capture.indexOf('private get busy()'));
    expect(set).toContain("if (this.state.status === 'capturing' || this.state.status === 'saving') hold('capture');");
    expect(set).toContain("else release('capture');");
  });
});
