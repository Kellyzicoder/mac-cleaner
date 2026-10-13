import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RawFinding } from '../shared/types';
import { MB, measure } from './fsutil';

const WHY_SCRATCH =
  'Photoshop uses "scratch" files when your Mac runs out of memory while you work. If Photoshop crashes or is force-quit, ' +
  'these files stay behind and pile up until you see "scratch disks are full".';

/** Temp files, caches and crash-recovery files that Photoshop leaves behind. */
export async function scanPhotoshop(home: string, onStep: (s: string) => void, tmpDir = os.tmpdir()): Promise<RawFinding[]> {
  onStep('Looking for Photoshop scratch and temp files');
  const out: RawFinding[] = [];

  // 1. Scratch files in the temp folder, named "Photoshop Temp" plus a number.
  try {
    for (const name of await fs.readdir(tmpDir)) {
      if (!/^Photoshop Temp\d+$/.test(name)) continue;
      const full = path.join(tmpDir, name);
      const m = await measure(full);
      if (m.bytes < 5 * MB) continue;
      out.push({
        id: `photoshop-temp:${full}`,
        category: 'Photoshop scratch',
        title: `Photoshop scratch file: ${name}`,
        paths: [full],
        displayPath: full,
        sizeBytes: m.bytes,
        safety: 'safe',
        whyJunk: `${WHY_SCRATCH} This one is ${(m.bytes / (1024 * MB)).toFixed(1)} GB.`,
        whyKeep: 'If Photoshop is open right now it is using this file, so I will not touch it while Photoshop runs. Close Photoshop first.',
        afterRemoval: 'Photoshop makes a new scratch file next time it opens. Your saved .psd files are not here.',
        lastModified: m.newest,
      });
    }
  } catch {
    /* temp folder not readable */
  }

  // 2. Photoshop caches.
  const caches = path.join(home, 'Library', 'Caches');
  try {
    for (const name of await fs.readdir(caches)) {
      if (!/^(Adobe Photoshop|com\.adobe\.Photoshop)/i.test(name)) continue;
      const full = path.join(caches, name);
      const m = await measure(full);
      if (m.bytes < 20 * MB) continue;
      out.push({
        id: `photoshop-cache:${full}`,
        category: 'Photoshop scratch',
        title: `Photoshop cache: ${name}`,
        paths: [full],
        displayPath: full,
        sizeBytes: m.bytes,
        safety: 'safe',
        whyJunk: 'Photoshop keeps speed-up files here. It rebuilds them when it needs them.',
        whyKeep: 'The first start afterwards may be a little slower.',
        afterRemoval: 'Photoshop rebuilds the cache.',
        lastModified: m.newest,
      });
    }
  } catch {
    /* no caches folder */
  }

  // 3. Crash-recovery files. These can hold work you did not save, so I ask.
  const adobe = path.join(home, 'Library', 'Application Support', 'Adobe');
  try {
    for (const name of await fs.readdir(adobe)) {
      if (!/^Adobe Photoshop/.test(name)) continue;
      const full = path.join(adobe, name, 'AutoRecover');
      const m = await measure(full);
      if (m.bytes < 20 * MB) continue;
      out.push({
        id: `photoshop-autorecover:${full}`,
        category: 'Photoshop scratch',
        title: `Photoshop crash-recovery files (${name})`,
        paths: [full],
        displayPath: full,
        sizeBytes: m.bytes,
        safety: 'ask',
        whyJunk: 'Photoshop saves a copy here every few minutes so it can bring work back after a crash. Old copies from finished work only take space.',
        whyKeep: 'If Photoshop crashed recently and you never reopened the file, the only copy of that work may be in here. Open Photoshop once first and let it offer to recover.',
        afterRemoval: 'Photoshop makes new recovery files while you work.',
        lastModified: m.newest,
      });
    }
  } catch {
    /* no Adobe folder */
  }
  return out;
}
