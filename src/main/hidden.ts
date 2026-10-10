import { promises as fs } from 'fs';
import * as path from 'path';
import { RawFinding } from '../shared/types';
import { MB, humanSize, lstatSafe, measure } from './fsutil';

/** Hidden folders in the home folder that are only worth listing when they are big. */
export const HIDDEN_MIN = 200 * MB;

/**
 * Hidden folders I never offer, even when they are big.
 * They hold logins, keys, settings, your shell setup, or your Trash.
 */
const NEVER = new Set([
  '.ssh', '.gnupg', '.aws', '.kube', '.config', '.local', '.docker', '.cups', '.Trash', '.git',
  '.oh-my-zsh', '.claude', '.cache', '.npm', '.vscode-shared',
]);

/**
 * Any other big hidden folder in the home folder. I do not know what it is,
 * so it always goes to the "Not sure" tab with a plain explanation.
 * Folders that the known rules already cover are dropped later, when overlaps are removed.
 */
export async function scanHiddenHome(home: string, onStep: (s: string) => void): Promise<RawFinding[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: RawFinding[] = [];
  for (const e of entries) {
    if (!e.name.startsWith('.') || !e.isDirectory() || e.isSymbolicLink() || NEVER.has(e.name)) continue;
    const full = path.join(home, e.name);
    const st = await lstatSafe(full);
    if (!st) continue;
    onStep(`Looking at hidden folder ${e.name}`);
    const m = await measure(full);
    if (m.bytes < HIDDEN_MIN) continue;
    out.push({
      id: `hidden-home:${full}`,
      category: 'Hidden folders',
      title: `Hidden folder: ${e.name}`,
      paths: [full],
      displayPath: full,
      sizeBytes: m.bytes,
      safety: 'ask',
      whyJunk:
        `${e.name} is a hidden folder that a tool or app made in your home folder. It uses ${humanSize(m.bytes)}. ` +
        'Most big hidden folders like this hold caches, downloads or logs that the tool can make again, so it is often fine to delete.',
      whyKeep:
        'I do not know which tool made it. Hidden folders can also hold your settings, logins or saved data. ' +
        'If you delete it, that tool may forget its settings or sign you out. Open the preview and look at the names inside first.',
      afterRemoval: 'The tool usually makes a new, empty one the next time it runs. Anything that was only saved here is gone.',
      lastModified: m.newest,
    });
  }
  return out;
}
