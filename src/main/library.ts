import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { AppRow, ExtRow, UpdatesInfo } from '../shared/types';
import { MB, lstatSafe, measure } from './fsutil';
import { bundleIdFor } from './apps';
import { cameWithMac, exists, findApps, mdlsDate } from './unusedapps';

const run = promisify(execFile);

export interface AppListDeps {
  dirs?: string[];
  lastUsed?: (appPath: string) => Promise<Date | null>;
  dateAdded?: (appPath: string) => Promise<Date | null>;
  bundleId?: (appPath: string) => Promise<string | undefined>;
}

/** Every app you installed yourself, with when you last opened it. Apps that came with macOS are left out. */
export async function listApps(home: string, deps: AppListDeps = {}): Promise<{ rows: AppRow[]; paths: Map<string, string> }> {
  const dirs = deps.dirs ?? ['/Applications', path.join(home, 'Applications')];
  const lastUsed = deps.lastUsed ?? mdlsDate('kMDItemLastUsedDate');
  const dateAdded = deps.dateAdded ?? mdlsDate('kMDItemDateAdded');
  const bundleId = deps.bundleId ?? bundleIdFor;
  const apps = await findApps(dirs);
  const rows: AppRow[] = [];
  const paths = new Map<string, string>();
  for (let i = 0; i < apps.length; i += 6) {
    const res = await Promise.all(
      apps.slice(i, i + 6).map(async (appPath): Promise<AppRow | null> => {
        const bid = await bundleId(appPath);
        if (!bid) return null;
        const hasReceipt = await exists(path.join(appPath, 'Contents', '_MASReceipt'));
        if (cameWithMac(appPath, bid, hasReceipt)) return null;
        const used = await lastUsed(appPath);
        const added = await dateAdded(appPath);
        const st = await lstatSafe(appPath);
        const m = await measure(appPath);
        return {
          id: `unused-app:${appPath}`,
          name: path.basename(appPath, '.app'),
          lastOpenedMs: used ? used.getTime() : null,
          addedMs: added ? added.getTime() : st ? st.mtimeMs : null,
          bytes: m.bytes,
          fromStore: hasReceipt,
        };
      }),
    );
    for (const r of res) if (r) {
      rows.push(r);
      paths.set(r.id, r.id.slice('unused-app:'.length));
    }
  }
  rows.sort((a, b) => (a.lastOpenedMs ?? a.addedMs ?? 0) - (b.lastOpenedMs ?? b.addedMs ?? 0));
  return { rows, paths };
}

const EXT_ROOTS: { editor: string; dir: string[] }[] = [
  { editor: 'VS Code', dir: ['.vscode', 'extensions'] },
  { editor: 'VS Code Insiders', dir: ['.vscode-insiders', 'extensions'] },
  { editor: 'Cursor', dir: ['.cursor', 'extensions'] },
];

/** "ms-python.python-2024.1.0-darwin-arm64" -> id and version. */
export function parseExtFolder(name: string): { ext: string; version: string } | null {
  const m = /^(.+?)-(\d+\.\d+\.\d+(?:[-.][\w.-]+)?)$/.exec(name);
  if (!m) return null;
  return { ext: m[1], version: m[2].replace(/-(darwin|universal|linux|win32).*$/, '') };
}

/** extensions.json lists the extensions the editor uses and when each was installed. */
export function parseExtensionsJson(text: string): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const arr = JSON.parse(text) as { relativeLocation?: string; metadata?: { installedTimestamp?: number } }[];
    for (const e of arr) {
      if (e.relativeLocation) out.set(e.relativeLocation, e.metadata?.installedTimestamp ?? 0);
    }
  } catch {
    /* ignore a broken file */
  }
  return out;
}

export async function listExtensions(home: string): Promise<{ rows: ExtRow[]; paths: Map<string, string> }> {
  const rows: ExtRow[] = [];
  const paths = new Map<string, string>();
  for (const root of EXT_ROOTS) {
    const dir = path.join(home, ...root.dir);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    let active = new Map<string, number>();
    try {
      active = parseExtensionsJson(await fs.readFile(path.join(dir, 'extensions.json'), 'utf8'));
    } catch {
      /* no list: treat every folder as in use */
    }
    const haveList = active.size > 0;
    for (const n of names) {
      const parsed = parseExtFolder(n);
      if (!parsed) continue;
      const full = path.join(dir, n);
      const st = await lstatSafe(full);
      if (!st || !st.isDirectory()) continue;
      const stamp = active.get(n);
      const m = await measure(full);
      const id = `ext:${root.editor}:${n}`;
      paths.set(id, full);
      rows.push({
        id,
        name: parsed.ext,
        version: parsed.version,
        editor: root.editor,
        installedMs: stamp && stamp > 0 ? stamp : st.mtimeMs,
        bytes: m.bytes,
        oldCopy: haveList && !active.has(n),
      });
    }
  }
  rows.sort((a, b) => a.installedMs - b.installedMs);
  return { rows, paths };
}

/** Lines of `softwareupdate -l` that name an update: "* Label: macOS Sequoia 15.1". */
export function parseSoftwareUpdate(text: string): string[] {
  return text.split('\n').map((l) => /^\s*\*\s*Label:\s*(.+)$/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x);
}

/** `brew outdated --quiet` and `mas outdated` print one thing per line. */
export function parseLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function tryRun(cmd: string, args: string[], timeout: number): Promise<string | null> {
  try {
    return (await run(cmd, args, { timeout, maxBuffer: 4_000_000 })).stdout;
  } catch {
    return null;
  }
}

async function firstExisting(list: string[]): Promise<string | null> {
  for (const p of list) if (await exists(p)) return p;
  return null;
}

/** Only looks. It never installs anything. */
export async function checkUpdates(): Promise<UpdatesInfo> {
  const sw = await tryRun('softwareupdate', ['-l'], 120_000);
  const brew = await firstExisting(['/opt/homebrew/bin/brew', '/usr/local/bin/brew']);
  const mas = await firstExisting(['/opt/homebrew/bin/mas', '/usr/local/bin/mas']);
  const brewOut = brew ? await tryRun(brew, ['outdated', '--quiet'], 90_000) : null;
  const masOut = mas ? await tryRun(mas, ['outdated'], 60_000) : null;
  return {
    macos: sw === null ? null : parseSoftwareUpdate(sw),
    brew: brew === null ? null : brewOut === null ? null : parseLines(brewOut),
    store: mas === null ? null : masOut === null ? null : parseLines(masOut),
    hasBrew: brew !== null,
    hasMas: mas !== null,
  };
}

export const MIN_EXT_MB = MB;
