import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as os from 'os';
import { existsSync, promises as fs } from 'fs';
import { CleanResult, Finding, Preview } from '../shared/types';
import { inUseText } from '../shared/text';
import { readKeepList, scanAll, writeKeepList } from './scanner';
import { protectedReason } from './safety';
import { humanSize, measure } from './fsutil';
import { checkInUse, getSnapshot } from './apps';
import { makePreview, previewTrash } from './preview';
import { emptyTrash, trashInfo } from './trash';
import { applyTidy, MoveLog, planTidy, rootProblem, undoTidy } from './organize';

const home = os.homedir();
let win: BrowserWindow | null = null;
/** What the last scan found. The window can only ask to clean these ids, never raw paths. */
let lastScan = new Map<string, Finding>();

function keepFile(): string {
  return path.join(app.getPath('userData'), 'always-keep.json');
}

function iconPath(): string | undefined {
  const p = path.join(app.getAppPath(), 'assets', 'icon.png');
  return existsSync(p) ? p : undefined;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: 'Mac Purificator',
    icon: iconPath(),
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.env.ELECTRON_DEV) {
    void win.loadURL('http://localhost:5173');
  } else {
    void win.loadFile(path.join(__dirname, '..', '..', '..', 'renderer', 'index.html'));
  }
}

ipcMain.handle('scan', async (): Promise<Finding[]> => {
  const keep = readKeepList(keepFile());
  const findings = await scanAll({
    home,
    keep,
    onStep: (step) => win?.webContents.send('scan-progress', { step }),
  });
  lastScan = new Map(findings.map((f) => [f.id, f]));
  return findings;
});

/** Looks at the running apps again, without scanning the disk. */
ipcMain.handle('recheck', async (): Promise<Record<string, string[]>> => {
  const snap = await getSnapshot();
  const out: Record<string, string[]> = {};
  for (const f of lastScan.values()) {
    f.inUseBy = checkInUse(f, home, snap);
    out[f.id] = f.inUseBy;
  }
  return out;
});

ipcMain.handle('clean', async (_e, ids: string[]): Promise<CleanResult> => {
  const result: CleanResult = { movedIds: [], freedBytes: 0, failed: [] };
  // One fresh look at the running apps, taken right before moving anything.
  const snap = await getSnapshot();
  for (const id of ids) {
    const finding = lastScan.get(id);
    if (!finding) {
      result.failed.push({ id, reason: 'Not part of the last scan. Scan again.' });
      continue;
    }

    // 1. Is an app using it right now? Then leave it alone.
    const using = checkInUse(finding, home, snap);
    finding.inUseBy = using;
    if (using.length > 0) {
      result.failed.push({ id, reason: inUseText(using) });
      continue;
    }

    // 2. Move each path to the Trash.
    let ok = true;
    let freed = 0;
    for (const p of finding.paths) {
      // Check again right before touching anything.
      const reason = protectedReason(p, home);
      if (reason) {
        result.failed.push({ id, reason });
        ok = false;
        break;
      }
      try {
        const m = await measure(p);
        await shell.trashItem(p); // Trash only, never permanent delete
        freed += m.bytes;
      } catch (err) {
        const hint =
          finding.category === 'Unused apps'
            ? ' macOS may need your password to remove this app. Drag it to the Trash in Finder instead.'
            : '';
        result.failed.push({ id, reason: (err as Error).message + hint });
        ok = false;
        break;
      }
    }
    result.freedBytes += freed;
    if (ok) {
      result.movedIds.push(id);
      lastScan.delete(id);
    }
  }
  return result;
});

ipcMain.handle('always-keep', async (_e, id: string): Promise<void> => {
  const keep = readKeepList(keepFile());
  keep.add(id);
  await fs.mkdir(path.dirname(keepFile()), { recursive: true });
  writeKeepList(keepFile(), keep);
  lastScan.delete(id);
});

ipcMain.handle('reveal', async (_e, id: string): Promise<void> => {
  const f = lastScan.get(id);
  if (f) shell.showItemInFolder(f.paths[0]);
});

ipcMain.handle('preview', async (_e, id: string): Promise<Preview> => {
  const f = lastScan.get(id);
  if (!f) return { kind: 'none', note: 'Scan again to see a preview.' };
  try {
    return await makePreview(f);
  } catch {
    return { kind: 'none', note: 'No preview available.' };
  }
});

ipcMain.handle('trash-info', () => trashInfo(home));

ipcMain.handle('trash-preview', () => previewTrash(home));

/** Emptying the Trash is permanent, so this window asks first. The page cannot skip it. */
ipcMain.handle('empty-trash', async (): Promise<{ ok: boolean; message: string }> => {
  const info = await trashInfo(home);
  if (info.items === 0) return { ok: true, message: 'The Trash is already empty.' };
  const what =
    info.items !== null
      ? `${info.items} item${info.items === 1 ? '' : 's'}${info.bytes !== null ? ` (${humanSize(info.bytes)})` : ''}`
      : 'everything';
  const options = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Empty Trash'],
    defaultId: 0,
    cancelId: 0,
    title: 'Empty the Trash?',
    message: 'Empty the Trash?',
    detail: `This deletes ${what} for good, from the Trash on this Mac and on any drives you have plugged in. You cannot undo this.`,
  };
  const box = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (box.response !== 1) return { ok: false, message: 'Cancelled. Nothing was deleted.' };
  return emptyTrash();
});

let pickedFolder: string | null = null;
let lastTidyLog: MoveLog[] = [];

function undoFile(): string {
  return path.join(app.getPath('userData'), 'last-tidy.json');
}

ipcMain.handle('tidy-scan', async (_e, pick: boolean) => {
  const notes: string[] = [];
  if (pick) {
    const opts = { title: 'Pick a folder to tidy', properties: ['openDirectory' as const], defaultPath: path.join(home, 'Downloads') };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (!r.canceled && r.filePaths[0]) {
      const problem = await rootProblem(r.filePaths[0], home);
      if (problem) notes.push(`Cannot tidy ${r.filePaths[0]}. ${problem}`);
      else pickedFolder = r.filePaths[0];
    }
  }
  const roots = ['Downloads', 'Desktop', 'Documents'].map((d) => path.join(home, d));
  if (pickedFolder && !roots.includes(pickedFolder)) roots.push(pickedFolder);
  const plan = await planTidy(roots, home);
  plan.notes.push(...notes);
  return plan;
});

ipcMain.handle('tidy-apply', async (_e, ids: string[]) => {
  const { result, log } = await applyTidy(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [], home);
  if (log.length > 0) {
    lastTidyLog = log;
    await fs.writeFile(undoFile(), JSON.stringify(log)).catch(() => undefined);
  }
  return result;
});

async function loadUndo(): Promise<MoveLog[]> {
  if (lastTidyLog.length > 0) return lastTidyLog;
  try {
    const raw = JSON.parse(await fs.readFile(undoFile(), 'utf8')) as MoveLog[];
    return Array.isArray(raw) ? raw.filter((m) => m && typeof m.from === 'string' && typeof m.to === 'string') : [];
  } catch {
    return [];
  }
}

ipcMain.handle('tidy-undo-count', async () => (await loadUndo()).length);

ipcMain.handle('tidy-undo', async () => {
  const log = await loadUndo();
  if (log.length === 0) return { ok: false, message: 'Nothing to undo.' };
  const r = await undoTidy(log);
  lastTidyLog = [];
  await fs.writeFile(undoFile(), '[]').catch(() => undefined);
  return {
    ok: r.restored > 0,
    message: `Put back ${r.restored} file${r.restored === 1 ? '' : 's'}.${r.failed ? ` ${r.failed} could not be put back because they moved or something is in the way.` : ''}`,
  };
});

void app.whenReady().then(() => {
  const icon = iconPath();
  if (icon && process.platform === 'darwin') app.dock?.setIcon(icon);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
