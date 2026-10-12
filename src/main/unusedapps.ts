import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import { RawFinding } from '../shared/types';
import { MB, daysAgo, humanSize, lstatSafe, measure } from './fsutil';
import { MAC_OWN_APPS } from './safety';
import { bundleIdFor } from './apps';

const run = promisify(execFile);

/** An app that was not opened for this many days counts as unused. */
export const UNUSED_DAYS = 180;
/** Tiny apps are not worth listing. */
const MIN_APP_BYTES = 10 * MB;

export interface AppDeps {
  /** Folders to look in. Default: /Applications and ~/Applications. */
  dirs?: string[];
  /** When the app was last opened, or null if macOS has no record. */
  lastUsed?: (appPath: string) => Promise<Date | null>;
  /** When the app was added to this Mac, or null. */
  dateAdded?: (appPath: string) => Promise<Date | null>;
  bundleId?: (appPath: string) => Promise<string | undefined>;
}

function parseMdlsDate(raw: string): Date | null {
  // Looks like: 2026-09-12 03:11:22 +0000   (or "(null)")
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function mdlsDate(attr: string): (appPath: string) => Promise<Date | null> {
  return async (appPath) => {
    try {
      const { stdout } = await run('mdls', ['-name', attr, '-raw', appPath], { timeout: 8000 });
      return parseMdlsDate(stdout);
    } catch {
      return null;
    }
  };
}

export async function exists(p: string): Promise<boolean> {
  return (await lstatSafe(p)) !== null;
}

/** True if the app came with the Mac (or is an Apple app that is part of macOS). */
export function cameWithMac(appPath: string, bundleId: string | undefined, hasStoreReceipt: boolean): boolean {
  if (appPath.startsWith('/System/')) return true;
  if (MAC_OWN_APPS.has(path.basename(appPath))) return true;
  if (bundleId && bundleId.toLowerCase().startsWith('com.apple.')) {
    // Apple apps you installed yourself (Pages, Keynote, GarageBand, Xcode...) are not part of macOS.
    return !(hasStoreReceipt || bundleId === 'com.apple.dt.Xcode');
  }
  return false;
}

export async function findApps(dirs: string[]): Promise<string[]> {
  const apps: string[] = [];
  for (const dir of dirs) {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink() || !e.isDirectory() || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.name.endsWith('.app')) {
        apps.push(full);
      } else if (e.name !== 'Utilities') {
        // A folder of apps, like "Microsoft Office". Look one level in.
        try {
          for (const inner of await fs.readdir(full, { withFileTypes: true })) {
            if (inner.isDirectory() && !inner.isSymbolicLink() && inner.name.endsWith('.app')) {
              apps.push(path.join(full, inner.name));
            }
          }
        } catch {
          /* cannot read this folder */
        }
      }
    }
  }
  return apps;
}

function howLong(days: number): string {
  if (days >= 700) return `${Math.round(days / 365)} years`;
  if (days >= 60) return `${Math.round(days / 30)} months`;
  return `${days} days`;
}

/** Apps you installed yourself that you have not opened for a long time. */
export async function scanUnusedApps(
  home: string, onStep: (s: string) => void, now = Date.now(), deps: AppDeps = {},
): Promise<RawFinding[]> {
  const dirs = deps.dirs ?? ['/Applications', path.join(home, 'Applications')];
  const lastUsed = deps.lastUsed ?? mdlsDate('kMDItemLastUsedDate');
  const dateAdded = deps.dateAdded ?? mdlsDate('kMDItemDateAdded');
  const bundleId = deps.bundleId ?? bundleIdFor;

  onStep('Looking for apps you have not opened in a long time');
  const apps = await findApps(dirs);
  const out: RawFinding[] = [];

  for (let i = 0; i < apps.length; i += 6) {
    const batch = apps.slice(i, i + 6);
    const res = await Promise.all(
      batch.map(async (appPath): Promise<RawFinding | null> => {
        const id = await bundleId(appPath);
        if (!id) return null; // cannot tell what it is, so leave it alone
        const hasReceipt = await exists(path.join(appPath, 'Contents', '_MASReceipt'));
        if (cameWithMac(appPath, id, hasReceipt)) return null;

        const used = await lastUsed(appPath);
        const added = used ? null : await dateAdded(appPath);
        const st = await lstatSafe(appPath);
        const reference = used ?? added ?? (st ? new Date(st.mtimeMs) : null);
        if (!reference) return null;
        const days = daysAgo(reference.getTime(), now);
        if (days < UNUSED_DAYS) return null;

        const m = await measure(appPath);
        if (m.bytes < MIN_APP_BYTES) return null;

        const name = path.basename(appPath, '.app');
        const when = used
          ? `You last opened ${name} ${howLong(days)} ago.`
          : `macOS has no record that you ever opened ${name}. It was added ${howLong(days)} ago.`;
        return {
          id: `unused-app:${appPath}`,
          category: 'Unused apps',
          title: `${name} (not opened for ${howLong(days)})`,
          paths: [appPath],
          displayPath: appPath,
          sizeBytes: m.bytes,
          // Store apps can be downloaded again for free, so I am sure. Others might need a licence.
          safety: hasReceipt ? 'safe' : 'ask',
          whyJunk:
            `${when} It uses ${humanSize(m.bytes)}, and it did not come with macOS. ` +
            (hasReceipt ? 'You got it from the App Store, so you can download it again for free any time.' : 'Apps you never open only take space.'),
          whyKeep: hasReceipt
            ? 'If you only use it once in a while (like a tax or yearly app), you would just download it again. Its saved files and settings stay in your Library.'
            : 'I am not sure you could get it back easily. It may be a paid app with a licence or login you would need again, or it may not be on the web any more. ' +
              'Some apps also run quietly in the background and do not count as "opened".',
          afterRemoval:
            'The app goes to the Trash, so you can put it back until you empty the Trash. Its settings and saved data in your Library stay behind.',
          lastModified: reference.getTime(),
        };
      }),
    );
    for (const r of res) if (r) out.push(r);
  }
  return out;
}
