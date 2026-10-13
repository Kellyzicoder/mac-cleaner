import * as fs from 'fs';
import { Finding, RawFinding } from '../shared/types';
import { runRules } from './rules';
import { scanDevJunk } from './devjunk';
import { scanBigFiles, scanDuplicates } from './bigfiles';
import { scanPhotoshop } from './photoshop';
import { scanHiddenHome } from './hidden';
import { AppDeps, scanUnusedApps } from './unusedapps';
import { protectedReason } from './safety';
import { checkInUse, getSnapshot, ownerLabels, ownersFor, Snapshot } from './apps';

export interface ScanOptions {
  home: string;
  /** Finding ids the user said "always keep". */
  keep: Set<string>;
  onStep?: (s: string) => void;
  now?: number;
  /** Only for tests: a fake list of running programs. */
  snapshot?: Snapshot;
  /** Only for tests: where to look for apps and how to read them. */
  apps?: AppDeps;
}

/** Runs every scanner, removes anything protected or already kept, and removes overlaps. */
export async function scanAll(opts: ScanOptions): Promise<Finding[]> {
  const step = opts.onStep ?? (() => undefined);
  const all: RawFinding[] = [];
  all.push(...(await runRules(opts.home, step, opts.now)));
  all.push(...(await scanPhotoshop(opts.home, step)));
  all.push(...(await scanDevJunk(opts.home, step, opts.now)));
  all.push(...(await scanHiddenHome(opts.home, step)));
  all.push(...(await scanUnusedApps(opts.home, step, opts.now, opts.apps)));
  all.push(...(await scanBigFiles(opts.home, step, opts.now)));
  all.push(...(await scanDuplicates(opts.home, step)));

  const claimed = new Set<string>();
  const kept: RawFinding[] = [];
  for (const f of all) {
    if (opts.keep.has(f.id)) continue;
    // Drop protected targets. If any target is protected, drop the whole finding.
    if (f.paths.some((p) => protectedReason(p, opts.home) !== null)) continue;
    // A path may only appear once (first scanner wins), and never inside an already listed folder.
    if (f.paths.some((p) => claimed.has(p) || isInsideClaimed(p, claimed) || hasClaimedInside(p, claimed))) continue;
    f.paths.forEach((p) => claimed.add(p));
    kept.push(f);
  }

  step('Checking which apps are open');
  const snap = opts.snapshot ?? (await getSnapshot());
  const result: Finding[] = kept.map((f) => ({
    ...f,
    usedBy: ownerLabels(ownersFor(f, opts.home)),
    inUseBy: checkInUse(f, opts.home, snap),
  }));
  result.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return result;
}

/** True if a folder I already listed sits inside this path, so listing it too would count that twice. */
function hasClaimedInside(p: string, claimed: Set<string>): boolean {
  for (const c of claimed) {
    if (c.startsWith(p + '/')) return true;
  }
  return false;
}

function isInsideClaimed(p: string, claimed: Set<string>): boolean {
  for (const c of claimed) {
    if (p.startsWith(c + '/')) return true;
  }
  return false;
}

export function readKeepList(file: string): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(file, 'utf8')) as string[]);
  } catch {
    return new Set();
  }
}

export function writeKeepList(file: string, keep: Set<string>): void {
  fs.writeFileSync(file, JSON.stringify([...keep], null, 2));
}
