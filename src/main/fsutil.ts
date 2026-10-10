import { promises as fs, Stats } from 'fs';
import * as path from 'path';

export const MB = 1024 * 1024;
export const GB = 1024 * MB;
export const DAY = 24 * 60 * 60 * 1000;

export interface SizeInfo {
  bytes: number;
  /** Newest modification time found inside (ms). */
  newest: number;
  files: number;
}

/** Real disk use (blocks * 512) when available, like `du`. Never follows symlinks. */
export function diskBytes(st: Stats): number {
  return st.blocks ? st.blocks * 512 : st.size;
}

export async function lstatSafe(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

/** Measure a file or folder. Symlinks are counted as the link itself, not followed. */
export async function measure(p: string): Promise<SizeInfo> {
  const info: SizeInfo = { bytes: 0, newest: 0, files: 0 };
  const rootStat = await lstatSafe(p);
  if (!rootStat) return info;
  info.newest = rootStat.mtimeMs;
  if (!rootStat.isDirectory()) {
    info.bytes = diskBytes(rootStat);
    info.files = 1;
    return info;
  }
  const stack: string[] = [p];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // no permission or vanished
    }
    for (let i = 0; i < entries.length; i += 64) {
      const batch = entries.slice(i, i + 64);
      const stats = await Promise.all(batch.map((e) => lstatSafe(path.join(dir, e.name))));
      stats.forEach((st, idx) => {
        if (!st) return;
        info.bytes += diskBytes(st);
        if (st.mtimeMs > info.newest) info.newest = st.mtimeMs;
        if (st.isDirectory()) stack.push(path.join(dir, batch[idx].name));
        else info.files++;
      });
    }
  }
  return info;
}

export interface WalkOptions {
  maxDepth: number;
  /** Return true to skip a folder entirely. */
  skipDir?: (name: string, full: string) => boolean;
  onFile?: (full: string, st: Stats) => void;
  /** Called for every folder before it is entered. Return false to not enter it. */
  onDir?: (full: string, name: string, depth: number) => boolean | void;
}

export async function walk(root: string, opts: WalkOptions, depth = 0): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (opts.skipDir?.(e.name, full)) continue;
      if (opts.onDir?.(full, e.name, depth) === false) continue;
      if (depth + 1 < opts.maxDepth) await walk(full, opts, depth + 1);
    } else if (e.isFile() && opts.onFile) {
      const st = await lstatSafe(full);
      if (st) opts.onFile(full, st);
    }
  }
}

/** Folders that are really single files to the user (apps, libraries). Never look inside. */
const PACKAGE_EXT = [
  '.app', '.photoslibrary', '.imovielibrary', '.fcpbundle', '.logicx', '.band',
  '.musiclibrary', '.sparsebundle', '.rtfd', '.xcodeproj', '.xcworkspace',
];
export function isPackageDir(name: string): boolean {
  const lower = name.toLowerCase();
  return PACKAGE_EXT.some((ext) => lower.endsWith(ext));
}

export function humanSize(bytes: number): string {
  if (bytes >= GB) return (bytes / GB).toFixed(1) + ' GB';
  if (bytes >= MB) return Math.round(bytes / MB) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

export function daysAgo(ms: number, now = Date.now()): number {
  return Math.floor((now - ms) / DAY);
}
