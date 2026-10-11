import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { TrashInfo } from '../shared/types';
import { measure } from './fsutil';

const run = promisify(execFile);

async function finderCount(): Promise<number | null> {
  try {
    const { stdout } = await run('osascript', ['-e', 'tell application "Finder" to count items of trash'], { timeout: 15000 });
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** How much is in the Trash. macOS may block reading it, so the size can be unknown. */
export async function trashInfo(home: string): Promise<TrashInfo> {
  const dir = path.join(home, '.Trash');
  try {
    const names = (await fs.readdir(dir)).filter((n) => n !== '.DS_Store');
    let bytes = 0;
    for (let i = 0; i < names.length; i += 8) {
      const sizes = await Promise.all(names.slice(i, i + 8).map((n) => measure(path.join(dir, n))));
      bytes += sizes.reduce((a, s) => a + s.bytes, 0);
    }
    return { readable: true, bytes, items: names.length };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { readable: true, bytes: 0, items: 0 };
    return { readable: false, bytes: null, items: await finderCount() };
  }
}

export function friendlyTrashError(message: string): string {
  if (message.includes('-1743') || /not authori[sz]ed/i.test(message)) {
    return (
      'macOS did not let Mac Purificator control Finder. Open System Settings > Privacy & Security > Automation, ' +
      'allow Mac Purificator to control Finder, then try again. Or empty the Trash in Finder yourself.'
    );
  }
  return `I could not empty the Trash: ${message}`;
}

/**
 * Asks Finder to empty the Trash, the same as Finder > Empty Trash.
 * That also empties the Trash on drives you have plugged in. This is permanent.
 * Only call this after the person has said yes.
 */
export async function emptyTrash(): Promise<{ ok: boolean; message: string }> {
  try {
    await run('osascript', ['-e', 'tell application "Finder" to empty the trash'], { timeout: 10 * 60 * 1000 });
    return { ok: true, message: 'The Trash is empty.' };
  } catch (err) {
    return { ok: false, message: friendlyTrashError((err as Error).message) };
  }
}
