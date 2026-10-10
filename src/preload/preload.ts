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
};

contextBridge.exposeInMainWorld('cleaner', api);
