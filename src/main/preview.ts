import { nativeImage } from 'electron';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { Finding, Preview } from '../shared/types';
import { lstatSafe, measure } from './fsutil';

const TEXT_EXT = new Set([
  '.log', '.txt', '.json', '.jsonl', '.md', '.csv', '.xml', '.plist', '.yml', '.yaml', '.toml', '.ini',
  '.conf', '.js', '.ts', '.py', '.sh', '.out', '.err', '.html', '.css', '',
]);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif']);
const MAX_IMAGE_READ = 80 * 1024 * 1024;
const TEXT_BYTES = 3000;

async function textPreview(p: string, size: number): Promise<Preview | null> {
  try {
    const handle = await fs.open(p, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, TEXT_BYTES));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const slice = buf.subarray(0, bytesRead);
      if (slice.includes(0)) return null; // binary file
      return { kind: 'text', text: slice.toString('utf8'), truncated: size > TEXT_BYTES };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Pictures, videos and PDFs: ask macOS for a thumbnail. If that fails, load the picture itself. */
async function imagePreview(p: string, ext: string): Promise<Preview | null> {
  try {
    const t = await nativeImage.createThumbnailFromPath(p, { width: 640, height: 480 });
    if (!t.isEmpty()) return { kind: 'image', dataUrl: t.toDataURL() };
  } catch {
    /* try the next way */
  }
  if (IMAGE_EXT.has(ext)) {
    try {
      const st = await fs.stat(p);
      if (st.size <= MAX_IMAGE_READ) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) {
          const small = img.getSize().width > 640 ? img.resize({ width: 640 }) : img;
          return { kind: 'image', dataUrl: 'data:image/jpeg;base64,' + small.toJPEG(80).toString('base64') };
        }
      }
    } catch {
      /* no preview */
    }
  }
  return null;
}

async function listPaths(paths: string[]): Promise<Preview> {
  const slice = paths.slice(0, 60);
  const items: { name: string; bytes: number; isDir: boolean }[] = [];
  for (let i = 0; i < slice.length; i += 8) {
    const batch = slice.slice(i, i + 8);
    const res = await Promise.all(
      batch.map(async (full) => {
        const st = await lstatSafe(full);
        if (!st) return null;
        const m = await measure(full);
        return { name: path.basename(full), bytes: m.bytes, isDir: st.isDirectory() };
      }),
    );
    for (const r of res) if (r) items.push(r);
  }
  items.sort((a, b) => b.bytes - a.bytes);
  return { kind: 'list', total: paths.length, items: items.slice(0, 12), more: Math.max(0, paths.length - 12) };
}

async function listDir(dir: string): Promise<Preview> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { kind: 'none', note: 'I cannot read this folder.' };
  }
  if (names.length === 0) return { kind: 'none', note: 'This folder is empty.' };
  return listPaths(names.map((n) => path.join(dir, n)));
}

/** A look at what would be moved. Read-only. */
export async function makePreview(f: Finding): Promise<Preview> {
  if (f.paths.length > 1) return listPaths(f.paths);
  const p = f.paths[0];
  const st = await lstatSafe(p);
  if (!st) return { kind: 'none', note: 'This item is no longer there.' };
  if (st.isDirectory()) {
    if (p.toLowerCase().endsWith('.app')) {
      const icon = await imagePreview(p, '.app');
      if (icon) return icon;
    }
    return listDir(p);
  }

  const ext = path.extname(p).toLowerCase();
  if (TEXT_EXT.has(ext)) {
    const t = await textPreview(p, st.size);
    if (t) return t;
  }
  const img = await imagePreview(p, ext);
  if (img) return img;
  return { kind: 'none', note: `No preview for this kind of file (${ext || 'no extension'}).` };
}

/** What is in the Trash right now. macOS may block this. */
export async function previewTrash(home: string): Promise<Preview> {
  const dir = path.join(home, '.Trash');
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n !== '.DS_Store');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none', note: 'The Trash is empty.' };
    return { kind: 'none', note: 'macOS does not let me look inside the Trash. You can open the Trash in Finder to see it.' };
  }
  if (names.length === 0) return { kind: 'none', note: 'The Trash is empty.' };
  return listPaths(names.map((n) => path.join(dir, n)));
}
