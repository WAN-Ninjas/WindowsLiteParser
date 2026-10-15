'use strict';

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('portal', {
  state: (id, options) => ipcRenderer.invoke('portal:state', id, options),
  create: config => ipcRenderer.invoke('portal:create', config),
  import: (id, folder = false) => ipcRenderer.invoke('portal:import', id, folder),
  watch: (id, enabled) => ipcRenderer.invoke('portal:watch', id, enabled),
  export: id => ipcRenderer.invoke('portal:export', id),
  reveal: id => ipcRenderer.invoke('portal:reveal', id),
  revealData: () => ipcRenderer.invoke('portal:reveal-data'),
  document: id => ipcRenderer.invoke('portal:document', id),
  review: (id, values, additional) => ipcRenderer.invoke('portal:review', id, values, additional),
  draft: (id, values, additional) => ipcRenderer.invoke('portal:draft', id, values, additional),
  previewTeaching: (id, config) => ipcRenderer.invoke('portal:preview-teaching', id, config),
  teach: (id, config, values, additional) => ipcRenderer.invoke('portal:teach', id, config, values, additional),
  feedback: (id, name, flagged) => ipcRenderer.invoke('portal:feedback', id, name, flagged),
  retention: (id, retain) => ipcRenderer.invoke('portal:retention', id, retain),
  retry: id => ipcRenderer.invoke('portal:retry', id),
  analysisMode: (id, mode) => ipcRenderer.invoke('portal:analysis-mode', id, mode),
  reanalyze: id => ipcRenderer.invoke('portal:reanalyze', id),
  pause: () => ipcRenderer.invoke('portal:pause'),
  onChange: callback => { const listener = () => callback(); ipcRenderer.on('portal:changed', listener); return () => ipcRenderer.removeListener('portal:changed', listener); }
});
