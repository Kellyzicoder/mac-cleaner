import * as path from 'path';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { RawFinding } from '../shared/types';
import { DAY, GB, MB, daysAgo, diskBytes, humanSize, isPackageDir, walk } from './fsutil';

const USER_FOLDERS = ['Downloads', 'Desktop', 'Documents', 'Movies', 'Pictures'];
const BIG = 500 * MB;
const INSTALLER_EXT = ['.dmg', '.pkg', '.iso', '.xip'];
const INSTALLER_OLD_DAYS = 60;

interface FileInfo {
  full: string;
  bytes: number;
  mtime: number;
}

async function listFiles(
  home: string, folders: string[], minBytes: number, onStep: (s: string) => void, includeHidden: boolean,
): Promise<FileInfo[]> {
  const files: FileInfo[] = [];
  for (const f of folders) {
    onStep(`Looking through ${f}`);
    await walk(path.join(home, f), {
      maxDepth: 6,
      // Hidden folders are read too, except Git history and the Trash. Duplicate checks skip them,
      // because copies inside hidden tool folders are usually there on purpose.
      skipDir: (name) =>
        name === '.git' || name === '.Trash' || name === 'node_modules' || isPackageDir(name) || (!includeHidden && name.startsWith('.')),
      onFile: (full, st) => {
        if (!includeHidden && path.basename(full).startsWith('.')) return;
        const bytes = diskBytes(st);
        if (bytes >= minBytes) files.push({ full, bytes, mtime: st.mtimeMs });
      },
    });
  }
  return files;
}

/** Installers (any size) and very big files. */
export async function scanBigFiles(home: string, onStep: (s: string) => void, now = Date.now()): Promise<RawFinding[]> {
  const files = await listFiles(home, USER_FOLDERS, 1 * MB, onStep, true);
  const out: RawFinding[] = [];
  const downloads = path.join(home, 'Downloads') + path.sep;

  for (const f of files) {
    const ext = path.extname(f.full).toLowerCase();
    const age = daysAgo(f.mtime, now);
    const name = path.basename(f.full);

    if (INSTALLER_EXT.includes(ext) && f.full.startsWith(downloads)) {
      const old = age >= INSTALLER_OLD_DAYS;
      out.push({
        id: `installer:${f.full}`,
        category: 'Installers',
        title: `Installer: ${name}`,
        paths: [f.full],
        displayPath: f.full,
        sizeBytes: f.bytes,
        safety: old ? 'safe' : 'ask',
        whyJunk: `This is an installer (${ext}) in Downloads. Once the app is installed you do not need it.`,
        whyKeep: old
          ? `It is ${age} days old, so you have most likely installed it already. Keep it only if you need to install offline later.`
          : `It is only ${age} days old. I cannot tell if you finished installing it. Is the app already in Applications?`,
        afterRemoval: 'The installed app keeps working. You can download the installer again from the developer.',
        lastModified: f.mtime,
      });
      continue;
    }

    if (f.bytes >= BIG) {
      out.push({
        id: `bigfile:${f.full}`,
        category: 'Big files',
        title: `Big file: ${name}`,
        paths: [f.full],
        displayPath: f.full,
        sizeBytes: f.bytes,
        safety: 'ask',
        whyJunk: `This single file uses ${humanSize(f.bytes)}. Big files are the fastest way to free space.`,
        whyKeep: `I cannot tell if this is something you made or need (a video project, a backup, a disk image). Last changed ${age} days ago. Only you know.`,
        afterRemoval: 'It goes to Trash. If it was only copy of something, it is gone once Trash is emptied.',
        lastModified: f.mtime,
      });
    }
  }
  return out;
}

async function hashFile(file: string, partial: boolean, size: number): Promise<string> {
  const h = createHash('sha1');
  const opts = partial ? { start: 0, end: Math.min(size, 64 * 1024) - 1 } : {};
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(file, opts);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve());
    s.on('error', reject);
  });
  return h.digest('hex');
}

/** Exact copies (same content). The oldest copy is kept, the others are offered. */
export async function scanDuplicates(home: string, onStep: (s: string) => void): Promise<RawFinding[]> {
  const files = await listFiles(home, ['Downloads', 'Desktop', 'Documents', 'Pictures'], 1 * MB, onStep, false);
  onStep('Comparing files to find exact copies');

  const bySize = new Map<number, FileInfo[]>();
  // Compare by real file size, not disk blocks, to avoid false matches.
  const { promises: fsp } = await import('fs');
  for (const f of files) {
    try {
      const st = await fsp.stat(f.full);
      const arr = bySize.get(st.size) ?? [];
      arr.push(f);
      bySize.set(st.size, arr);
    } catch {
      /* vanished */
    }
  }

  const out: RawFinding[] = [];
  let hashed = 0;
  for (const [size, group] of bySize) {
    if (group.length < 2) continue;
    if (hashed > 3000) break; // keep scan time sane
    // Quick check on the first 64 KB, then a full check only if that matches.
    const quick = new Map<string, FileInfo[]>();
    for (const f of group) {
      try {
        const k = await hashFile(f.full, true, size);
        hashed++;
        quick.set(k, [...(quick.get(k) ?? []), f]);
      } catch { /* unreadable */ }
    }
    for (const candidates of quick.values()) {
      if (candidates.length < 2) continue;
      const full = new Map<string, FileInfo[]>();
      for (const f of candidates) {
        try {
          const k = await hashFile(f.full, false, size);
          full.set(k, [...(full.get(k) ?? []), f]);
        } catch { /* unreadable */ }
      }
      for (const same of full.values()) {
        if (same.length < 2) continue;
        same.sort((a, b) => a.mtime - b.mtime);
        const keep = same[0];
        for (const dup of same.slice(1)) {
          out.push({
            id: `dup:${dup.full}`,
            category: 'Duplicates',
            title: `Copy of ${path.basename(keep.full)}`,
            paths: [dup.full],
            displayPath: dup.full,
            sizeBytes: dup.bytes,
            safety: 'ask',
            whyJunk: `Same content, byte for byte, as: ${keep.full}. Keeping one copy is enough.`,
            whyKeep: 'I only compared the content. I cannot tell if a project or app points to this exact location, or which copy you prefer to keep.',
            afterRemoval: 'The other copy stays where it is.',
            lastModified: dup.mtime,
          });
        }
      }
    }
  }
  return out;
}

export { DAY, GB };
