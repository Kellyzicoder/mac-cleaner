import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { DiskAnalysis, DiskCategory, DiskEntry } from '../shared/types';

const run = promisify(execFile);

/** Size of a file or folder in bytes, using the system `du`. Folders you may not read count as far as they can be read. */
export async function duBytes(p: string): Promise<number> {
  let text = '';
  try {
    const r = await run('du', ['-sk', '--', p], { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
    text = String(r.stdout);
  } catch (e) {
    text = String((e as { stdout?: string }).stdout ?? '');
  }
  // du prints one line per path. With -s there is one total line, in kilobytes.
  const m = /^(\d+)\s/m.exec(text);
  return m ? Number(m[1]) * 1024 : 0;
}

/** Only the home folder and /Applications can be looked into. */
export function allowedDiskPath(p: string, home: string): boolean {
  const r = path.resolve(p);
  return r === home || r.startsWith(home + path.sep) || r === '/Applications' || r.startsWith('/Applications/');
}

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

let counter = 0;

/** What is inside a folder, biggest first. Each entry gets an id so the window can ask for it without sending paths. */
export async function listChildren(dir: string, ids: Map<string, string>, limit = 60): Promise<DiskEntry[]> {
  let entries: import('fs').Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const real = entries.filter((e) => !e.isSymbolicLink());
  const sized = await pool(real, 4, async (e) => {
    const full = path.join(dir, e.name);
    return { name: e.name, full, isDir: e.isDirectory(), bytes: await duBytes(full) };
  });
  sized.sort((a, b) => b.bytes - a.bytes);
  return sized.slice(0, limit).map((s) => {
    const id = `disk:${++counter}`;
    ids.set(id, s.full);
    return { id, name: s.name, bytes: s.bytes, isDir: s.isDir };
  });
}

const NAMED = ['Documents', 'Desktop', 'Downloads'];

export async function analyzeDisk(
  home: string,
  totalBytes: number,
  availableBytes: number,
  ids: Map<string, string>,
  onStep: (s: string) => void = () => undefined,
): Promise<DiskAnalysis> {
  onStep('Measuring your home folder');
  const homeItems = await listChildren(home, ids, 500);
  onStep('Measuring Applications');
  const apps = (await duBytes('/Applications')) + (await duBytes(path.join(home, 'Applications')));

  const sizeOf = (name: string) => homeItems.find((e) => e.name === name)?.bytes ?? 0;
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const named = NAMED.reduce((a, n) => a + sizeOf(n), 0);
  const known = named + apps;
  const categories: DiskCategory[] = [
    { key: 'documents', label: 'Documents', bytes: sizeOf('Documents') },
    { key: 'applications', label: 'Applications', bytes: apps },
    { key: 'desktop', label: 'Desktop', bytes: sizeOf('Desktop') },
    { key: 'downloads', label: 'Downloads', bytes: sizeOf('Downloads') },
    { key: 'other', label: 'Other', bytes: Math.max(0, usedBytes - known) },
  ];

  const homeTotal = homeItems.reduce((a, e) => a + e.bytes, 0);
  const other = homeItems.filter((e) => !NAMED.includes(e.name) && e.name !== 'Applications');
  const system = Math.max(0, usedBytes - homeTotal - apps);
  if (system > 0) other.push({ id: 'system:rest', name: 'macOS, system files and other users (cannot be opened here)', bytes: system, isDir: false });
  other.sort((a, b) => b.bytes - a.bytes);
  return { totalBytes, availableBytes, usedBytes, categories, other };
}
