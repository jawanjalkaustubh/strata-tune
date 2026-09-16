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
  }
});
