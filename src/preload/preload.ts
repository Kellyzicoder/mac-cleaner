import { contextBridge, ipcRenderer } from 'electron';
import type { CleanerApi, ScanProgress } from '../shared/types';

const api: CleanerApi = {
  scan: () => ipcRenderer.invoke('scan'),
  onProgress: (cb) => {
    const handler = (_e: unknown, p: ScanProgress) => cb(p);
    ipcRenderer.on('scan-progress', handler);
    return () => ipcRenderer.removeListener('scan-progress', handler);
  },
  clean: (ids) => ipcRenderer.invoke('clean', ids),
  alwaysKeep: (id) => ipcRenderer.invoke('always-keep', id),
  reveal: (id) => ipcRenderer.invoke('reveal', id),
  preview: (id) => ipcRenderer.invoke('preview', id),
  recheck: () => ipcRenderer.invoke('recheck'),
  trashInfo: () => ipcRenderer.invoke('trash-info'),
  trashPreview: () => ipcRenderer.invoke('trash-preview'),
  emptyTrash: () => ipcRenderer.invoke('empty-trash'),
  tidyScan: (pick) => ipcRenderer.invoke('tidy-scan', pick),
  tidyApply: (ids) => ipcRenderer.invoke('tidy-apply', ids),
  tidyUndoCount: () => ipcRenderer.invoke('tidy-undo-count'),
  tidyUndo: () => ipcRenderer.invoke('tidy-undo'),
  dashInfo: () => ipcRenderer.invoke('dash-info'),
  netSpeed: () => ipcRenderer.invoke('net-speed'),
  speedTest: () => ipcRenderer.invoke('speed-test'),
  eject: (id) => ipcRenderer.invoke('eject', id),
  diskAnalyze: () => ipcRenderer.invoke('disk-analyze'),
  diskChildren: (id) => ipcRenderer.invoke('disk-children', id),
  diskReveal: (id) => ipcRenderer.invoke('disk-reveal', id),
  appUpdateCheck: () => ipcRenderer.invoke('app-update-check'),
  appUpdatePick: () => ipcRenderer.invoke('app-update-pick'),
  appUpdateRun: () => ipcRenderer.invoke('app-update-run'),
  onUpdateProgress: (cb) => {
    const h = (_e: unknown, line: string) => cb(line);
    ipcRenderer.on('update-progress', h);
    return () => ipcRenderer.removeListener('update-progress', h);
  },
  libBrowse: (id) => ipcRenderer.invoke('lib-browse', id),
  libReveal: (id) => ipcRenderer.invoke('lib-reveal', id),
  libApps: () => ipcRenderer.invoke('lib-apps'),
  libExtensions: () => ipcRenderer.invoke('lib-extensions'),
  libTrash: (ids) => ipcRenderer.invoke('lib-trash', ids),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  openSoftwareUpdate: () => ipcRenderer.invoke('open-software-update'),
  busyApps: () => ipcRenderer.invoke('busy-apps'),
  quitApp: (id) => ipcRenderer.invoke('quit-app', id),
  startupItems: () => ipcRenderer.invoke('startup-items'),
  openLoginSettings: () => ipcRenderer.invoke('open-login-settings'),
  startupReveal: (id) => ipcRenderer.invoke('startup-reveal', id),
};

contextBridge.exposeInMainWorld('cleaner', api);
