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
    ollamaList: () => ipcRenderer.invoke('ollama:list')
  },

  // Frame capture (electron/capture.ts): PresentMon in main, one folder per session on disk.
  capture: {
    state: () => ipcRenderer.invoke('capture:state'),
    processes: () => ipcRenderer.invoke('capture:processes'),
    start: (pid) => ipcRenderer.invoke('capture:start', pid),
    startBench: () => ipcRenderer.invoke('capture:startBench'),
    stop: () => ipcRenderer.invoke('capture:stop'),
    arm: (on) => ipcRenderer.invoke('capture:arm', on),
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
    trashCount: () => ipcRenderer.invoke('sessions:trashCount'),
    emptyTrash: () => ipcRenderer.invoke('sessions:emptyTrash')
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
    start: (kind, enabled) => ipcRenderer.invoke('tune:start', kind, enabled),
    validate: () => ipcRenderer.invoke('tune:validate'),
    stop: () => ipcRenderer.invoke('tune:stop'),
    keep: () => ipcRenderer.invoke('tune:keep'),
    revert: () => ipcRenderer.invoke('tune:revert'),
    export: () => ipcRenderer.invoke('tune:export'),
    flight: () => ipcRenderer.invoke('tune:flight'),
    subscribe: () => ipcRenderer.send('tune:subscribe'),
    unsubscribe: () => ipcRenderer.send('tune:unsubscribe'),
    onRun: on('tune:run')
  }
});
