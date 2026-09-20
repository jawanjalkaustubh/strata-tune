const { contextBridge, ipcRenderer } = require('electron');

// Subscribe to a push channel; returns the unsubscribe so React effects can return it.
const on = (channel) => (cb) => {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

// The whole surface the renderer gets. Typed on the other side in src/api.ts;
// keep the two in step. Hardware never appears here: the collector talks to
// the main process, and the main process talks to this bridge.
contextBridge.exposeInMainWorld('strata', {
  // 'darwin' hides what has no macOS counterpart (the Capture page, the Headroom hunt); a value, not a call.
  platform: process.platform,
  version: () => ipcRenderer.invoke('app:version'),
  support: () => ipcRenderer.invoke('app:support'),

  // Window controls for the frameless title bar
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  collector: {
    status: () => ipcRenderer.invoke('collector:status'),
    start: () => ipcRenderer.invoke('collector:start'),
    snapshot: () => ipcRenderer.invoke('collector:snapshot'),
    sensorsMeta: () => ipcRenderer.invoke('collector:sensorsMeta'),
    sensorsLatest: () => ipcRenderer.invoke('collector:sensorsLatest'),
    sensorsWindow: (seconds) => ipcRenderer.invoke('collector:sensorsWindow', seconds),
    gpu: () => ipcRenderer.invoke('collector:gpu'),
    hogs: (seconds) => ipcRenderer.invoke('collector:hogs', seconds),
    load: (kind, seconds) => ipcRenderer.invoke('collector:load', kind, seconds),
    // Stop (plan 17c): cancels the load run in flight; the pending load() then resolves as cancelled.
    cancelLoad: () => ipcRenderer.invoke('collector:cancelLoad'),
    // Ticks flow only while a page asks for them (the Monitor, later the Tune view).
    subscribe: () => ipcRenderer.send('collector:subscribe'),
    unsubscribe: () => ipcRenderer.send('collector:unsubscribe'),
    onTick: on('collector:tick'),
    onStatus: on('collector:status')
  },

  // AI stats card measurements (electron/bench.ts): the worker's kernels and a timed Ollama generation.
  advisor: {
    benchGpu: (req) => ipcRenderer.invoke('bench:gpu', req),
    benchOllama: (model) => ipcRenderer.invoke('bench:ollama', model),
    // Stop (plan 17c): the pending benchGpu / benchOllama then answers { error, code: 'cancelled' }.
    cancelBenchGpu: () => ipcRenderer.invoke('bench:cancelGpu'),
    cancelBenchOllama: () => ipcRenderer.invoke('bench:cancelOllama'),
    ollamaList: () => ipcRenderer.invoke('ollama:list'),
    // Free VRAM (plan 16, the hunt's Ollama refusal): evicts every resident model, keep_alive 0.
    ollamaUnload: () => ipcRenderer.invoke('ollama:unload')
  },

  // Frame capture (electron/capture.ts): PresentMon in main, one folder per session on disk.
  capture: {
    state: () => ipcRenderer.invoke('capture:state'),
    processes: () => ipcRenderer.invoke('capture:processes'),
    start: (pid) => ipcRenderer.invoke('capture:start', pid),
    startBench: () => ipcRenderer.invoke('capture:startBench'),
    stop: () => ipcRenderer.invoke('capture:stop'),
    arm: (on) => ipcRenderer.invoke('capture:arm', on),
    // Adds the account to Performance Log Users through one UAC prompt (electron/presentmon.ts grantTraceAccess).
    grantTrace: () => ipcRenderer.invoke('capture:grantTrace'),
    onState: on('capture:state'),
    onFrames: on('capture:frames')
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    load: (id) => ipcRenderer.invoke('sessions:load', id),
    delete: (id) => ipcRenderer.invoke('sessions:delete', id),
    setVerdict: (id, verdict) => ipcRenderer.invoke('sessions:verdict', id, verdict),
    reveal: (id) => ipcRenderer.invoke('sessions:reveal', id),
    exportHtml: (data) => ipcRenderer.invoke('sessions:exportHtml', data),
    exportSheet: (sheet) => ipcRenderer.invoke('sessions:exportSheet', sheet),
    trashCount: () => ipcRenderer.invoke('sessions:trashCount'),
    emptyTrash: () => ipcRenderer.invoke('sessions:emptyTrash')
  },

  // About hub (electron/about.ts): Windows and DirectX facts, the bundled legal texts, the
  // collector's timer probe, a save dialog for the tools' files, the logs folder.
  about: {
    system: () => ipcRenderer.invoke('about:system'),
    directx: () => ipcRenderer.invoke('about:directx'),
    legal: () => ipcRenderer.invoke('about:legal'),
    timers: (traceSeconds) => ipcRenderer.invoke('about:timers', traceSeconds),
    saveFile: (req) => ipcRenderer.invoke('about:saveFile', req),
    openLogs: () => ipcRenderer.invoke('about:openLogs')
  },

  // First launch (electron/legal.ts, plan 27a): the disclaimer's acceptance record; accept starts the collector it held back.
  legal: {
    status: () => ipcRenderer.invoke('legal:status'),
    accept: () => ipcRenderer.invoke('legal:accept')
  },

  // Fix verification (electron/history.ts): { what, before, after, date } entries in history.json.
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    add: (entry) => ipcRenderer.invoke('history:add', entry)
  },

  // OC auto-tune (electron/tune.ts): the collector's /tune/* routes; run events flow only while the Tune page asks.
  tune: {
    state: () => ipcRenderer.invoke('tune:state'),
    enable: (enabled, acknowledgedAt) => ipcRenderer.invoke('tune:enable', enabled, acknowledgedAt),
    start: (kind, enabled, vendor, caps) => ipcRenderer.invoke('tune:start', kind, enabled, vendor, caps),
    stop: () => ipcRenderer.invoke('tune:stop'),
    revert: () => ipcRenderer.invoke('tune:revert'),
    release: () => ipcRenderer.invoke('tune:release'),
    hold: (vendor) => ipcRenderer.invoke('tune:hold', vendor),
    export: () => ipcRenderer.invoke('tune:export'),
    flight: () => ipcRenderer.invoke('tune:flight'),
    subscribe: () => ipcRenderer.send('tune:subscribe'),
    unsubscribe: () => ipcRenderer.send('tune:unsubscribe'),
    onRun: on('tune:run')
  }
});
