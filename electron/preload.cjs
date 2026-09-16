const { contextBridge, ipcRenderer } = require('electron');

// The whole surface the renderer gets. Typed on the other side in src/api.ts;
// keep the two in step. Hardware never appears here: the collector (Phase 1)
// talks to the main process, and the main process talks to this bridge.
contextBridge.exposeInMainWorld('strata', {
  version: () => ipcRenderer.invoke('app:version'),
  support: () => ipcRenderer.invoke('app:support'),

  // Window controls for the frameless title bar
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close')
});
