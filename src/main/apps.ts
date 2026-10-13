import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import type { Finding } from '../shared/types';

const run = promisify(execFile);

/** One way to recognise a running app or program. Any one match is enough. */
export interface Matcher {
  /** Name shown to the user if the process has no app name of its own. */
  label: string;
  bundleIds?: string[];
  /** Exact .app names, like "Visual Studio Code". */
  appNames?: string[];
  /** Part of a .app name. Used for cache folders such as "Google" (for Google Chrome). */
  appNameIncludes?: string[];
  /** Command names of programs that are NOT inside an .app, like "npm" or "claude". */
  procNames?: string[];
  /** Pieces of the full command line, like "gradle". */
  commandIncludes?: string[];
  /** A process working inside one of these folders counts. */
  cwdUnder?: string[];
  /** Show the process name (like "node") instead of the label. */
  showProc?: boolean;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
  /** Lowercase command name, or lowercase app name for apps. */
  name: string;
  appPath?: string;
  appName?: string;
  bundleId?: string;
  cwd?: string;
}

export interface Snapshot {
  procs: ProcInfo[];
  /** Files that programs have open right now: path -> names of the programs. */
  openFiles: Map<string, Set<string>>;
}

export const EMPTY_SNAPSHOT: Snapshot = { procs: [], openFiles: new Map() };

/** Background helpers that touch files for a moment. They do not count as "using" something. */
const NOISE = new Set([
  'mds', 'mds_stores', 'mdworker', 'mdworker_shared', 'fseventsd', 'quicklookd', 'quicklookuiservice',
  'lsof', 'ps', 'backupd', 'corespotlightd', 'suggestd', 'revisiond', 'fileproviderd', 'bird', 'cloudd',
  'distnoted', 'diskarbitrationd', 'finder', 'launchservicesd', 'coreservicesd', 'trustd', 'syspolicyd',
]);

function isNoise(name: string): boolean {
  const n = name.toLowerCase();
  return NOISE.has(n) || n.startsWith('mdworker');
}

// ---------------------------------------------------------------------------
// Who normally owns an item
// ---------------------------------------------------------------------------

const claudeCode: Matcher = {
  label: 'Claude Code',
  procNames: ['claude'],
  commandIncludes: ['@anthropic-ai/claude-code', 'claude-code/cli'],
};
const claudeApp: Matcher = {
  label: 'Claude',
  bundleIds: ['com.anthropic.claudefordesktop'],
  appNames: ['Claude'],
};
const vscode: Matcher = {
  label: 'Visual Studio Code',
  bundleIds: ['com.microsoft.VSCode'],
  appNames: ['Visual Studio Code', 'Code'],
};
const xcode: Matcher[] = [
  { label: 'Xcode', bundleIds: ['com.apple.dt.Xcode'], appNames: ['Xcode'], procNames: ['xcodebuild'] },
  { label: 'Simulator', bundleIds: ['com.apple.iphonesimulator'], appNames: ['Simulator'] },
];

const BY_RULE: { prefix: string; matchers: Matcher[] }[] = [
  { prefix: 'claude-code', matchers: [claudeCode] },
  { prefix: 'claude-cli-nodejs', matchers: [claudeCode] },
  { prefix: 'claude-desktop', matchers: [claudeApp] },
  { prefix: 'vscode-', matchers: [vscode] },
  { prefix: 'xcode-', matchers: xcode },
  { prefix: 'mail-downloads', matchers: [{ label: 'Mail', bundleIds: ['com.apple.mail'], appNames: ['Mail'] }] },
  {
    prefix: 'npm-cache',
    matchers: [{ label: 'npm', procNames: ['npm', 'npx'], commandIncludes: ['npm/bin/npm-cli.js', 'npm/bin/npx-cli.js'] }],
  },
  { prefix: 'pnpm-store', matchers: [{ label: 'pnpm', procNames: ['pnpm'], commandIncludes: ['pnpm.cjs', '/pnpm/bin/pnpm'] }] },
  { prefix: 'gradle-cache', matchers: [{ label: 'Gradle', procNames: ['gradle', 'gradlew'], commandIncludes: ['gradle'] }] },
  { prefix: 'maven-repo', matchers: [{ label: 'Maven', procNames: ['mvn'], commandIncludes: ['plexus-classworlds', 'maven'] }] },
  { prefix: 'cargo-registry', matchers: [{ label: 'Cargo', procNames: ['cargo', 'rustc'] }] },
];

function cacheMatcher(name: string): Matcher {
  return {
    label: name,
    bundleIds: [name],
    appNames: [name],
    appNameIncludes: name.length >= 4 && !name.includes('.') ? [name] : undefined,
  };
}

/** Which apps or programs could be using this item. */
export function ownersFor(f: Pick<Finding, 'id' | 'paths'>, home: string): Matcher[] {
  const prefix = f.id.split(':')[0];

  if (prefix === 'devjunk') {
    const parent = path.dirname(f.paths[0]);
    return [
      {
        label: `A program running in ${path.basename(parent)}`,
        cwdUnder: [parent],
        commandIncludes: [parent + '/'],
        showProc: true,
      },
    ];
  }

  if (prefix === 'library-caches') {
    return f.paths.map((p) => cacheMatcher(path.basename(p)));
  }

  if (prefix === 'dot-cache') {
    return f.paths.map((p) => {
      const n = path.basename(p);
      return { label: n, procNames: [n], commandIncludes: [`/.cache/${n}/`] };
    });
  }

  if (prefix === 'libfile') {
    return f.paths.map((p) => cacheMatcher(path.basename(p).replace(/\.(savedState|plist)$/, '')));
  }

  if (prefix.startsWith('photoshop')) {
    return [{ label: 'Adobe Photoshop', bundleIds: ['com.adobe.Photoshop'], appNameIncludes: ['Photoshop'], procNames: ['adobe photoshop'] }];
  }

  if (prefix === 'unused-app') {
    const name = path.basename(f.paths[0], '.app');
    return [{ label: name, appNames: [name] }];
  }

  if (prefix === 'hidden-home') {
    const tool = path.basename(f.paths[0]).replace(/^\./, '');
    return [{ label: tool, procNames: [tool.toLowerCase()], commandIncludes: [f.paths[0] + '/'] }];
  }

  for (const rule of BY_RULE) {
    if (prefix.startsWith(rule.prefix)) return rule.matchers;
  }
  void home;
  return []; // single files (installers, big files, copies) are checked by "open files" instead
}

/** A program started from inside one of these paths (for example node from an nvm folder) is using it. */
export function pathMatchers(f: Pick<Finding, 'paths'>): Matcher[] {
  return f.paths.slice(0, 40).map((p) => ({ label: path.basename(p), commandIncludes: [p + '/', p + ' '], showProc: true }));
}

export function ownerLabels(matchers: Matcher[]): string[] {
  return [...new Set(matchers.map((m) => m.label))];
}

// ---------------------------------------------------------------------------
// What is running right now
// ---------------------------------------------------------------------------

export function parseProc(pid: number, ppid: number, command: string): ProcInfo {
  const i = command.indexOf('.app/Contents/');
  if (command.startsWith('/') && i > 0) {
    const appPath = command.slice(0, i + 4);
    // A path like "/usr/bin/node /x/Foo.app/Contents" is a program with an argument, not an app.
    if (!/ \//.test(appPath)) {
      const appName = path.basename(appPath, '.app');
      return { pid, ppid, command, name: appName.toLowerCase(), appPath, appName };
    }
  }
  const exe = command.split(' ')[0];
  return { pid, ppid, command, name: path.basename(exe).toLowerCase() };
}

export async function bundleIdFor(appPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')],
      { timeout: 4000 },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function unescapeLsof(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** One look at everything that is running and every file that is open. */
export async function getSnapshot(): Promise<Snapshot> {
  const snap: Snapshot = { procs: [], openFiles: new Map() };

  let psOut = '';
  try {
    psOut = (await run('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch {
    return snap; // cannot look, so nothing is reported as running
  }
  const all: ProcInfo[] = [];
  for (const line of psOut.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) all.push(parseProc(Number(m[1]), Number(m[2]), m[3]));
  }

  // Ignore this app, the programs that started it (npm, Terminal), and everything it started.
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const ignore = new Set<number>();
  for (let cur = process.pid; cur > 1 && !ignore.has(cur); cur = byPid.get(cur)?.ppid ?? 0) ignore.add(cur);
  const mine = new Set<number>([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) {
      if (!mine.has(p.pid) && mine.has(p.ppid)) {
        mine.add(p.pid);
        grew = true;
      }
    }
  }
  mine.forEach((pid) => ignore.add(pid));
  snap.procs = all.filter((p) => !ignore.has(p.pid));

  // Bundle ids of the running apps.
  const appPaths = [...new Set(snap.procs.map((p) => p.appPath).filter((x): x is string => !!x))];
  const ids = new Map<string, string | undefined>();
  for (let i = 0; i < appPaths.length; i += 8) {
    const batch = appPaths.slice(i, i + 8);
    const res = await Promise.all(batch.map((ap) => bundleIdFor(ap)));
    batch.forEach((ap, idx) => ids.set(ap, res[idx]));
  }
  for (const p of snap.procs) if (p.appPath) p.bundleId = ids.get(p.appPath);

  // Working folders and open files, in one call.
  try {
    const { stdout } = await run('lsof', ['-nP', '-w', '-Fpcfn'], { maxBuffer: 256 * 1024 * 1024, timeout: 60000 });
    const procByPid = new Map(snap.procs.map((p) => [p.pid, p]));
    let pid = 0;
    let cmd = '';
    let fd = '';
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const tag = line[0];
      const val = line.slice(1);
      if (tag === 'p') {
        pid = Number(val);
        cmd = '';
        fd = '';
      } else if (tag === 'c') cmd = unescapeLsof(val);
      else if (tag === 'f') fd = val;
      else if (tag === 'n') {
        if (ignore.has(pid)) continue;
        if (fd === 'cwd') {
          const proc = procByPid.get(pid);
          if (proc) proc.cwd = val;
        } else if (val.startsWith('/') && !['txt', 'mem', 'rtd'].includes(fd) && !isNoise(cmd)) {
          const set = snap.openFiles.get(val) ?? new Set<string>();
          set.add(cmd);
          snap.openFiles.set(val, set);
        }
      }
    }
  } catch {
    /* lsof missing or too slow: only the app checks are used */
  }
  return snap;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function lower(list?: string[]): string[] {
  return (list ?? []).map((s) => s.toLowerCase());
}

/** Returns the name to show if this process matches, or null. */
export function matchProc(m: Matcher, p: ProcInfo): string | null {
  const shown = p.appName ?? (m.showProc ? p.name : m.label);
  if (p.bundleId && lower(m.bundleIds).includes(p.bundleId.toLowerCase())) return shown;
  if (p.appName) {
    const an = p.appName.toLowerCase();
    if (lower(m.appNames).includes(an)) return shown;
    if (lower(m.appNameIncludes).some((s) => an.includes(s))) return shown;
  } else if (lower(m.procNames).includes(p.name)) {
    return shown;
  }
  const cmd = p.command.toLowerCase();
  if (lower(m.commandIncludes).some((s) => cmd.includes(s))) return shown;
  if (p.cwd && m.cwdUnder?.some((d) => p.cwd === d || (p.cwd as string).startsWith(d + '/'))) return shown;
  return null;
}

/**
 * Names of the apps or programs that are using this item right now.
 * An empty list means nothing was found, and it is fine to move it.
 */
export function checkInUse(f: Pick<Finding, 'id' | 'paths'>, home: string, snap: Snapshot): string[] {
  const names = new Set<string>();

  for (const m of ownersFor(f, home)) {
    for (const p of snap.procs) {
      const hit = matchProc(m, p);
      if (hit) {
        names.add(hit);
        break;
      }
    }
  }

  for (const m of pathMatchers(f)) {
    for (const p of snap.procs) {
      const hit = matchProc(m, p);
      if (hit) {
        names.add(hit);
        break;
      }
    }
  }

  for (const target of f.paths) {
    for (const [file, procs] of snap.openFiles) {
      if (file === target || file.startsWith(target + '/')) procs.forEach((n) => names.add(n));
    }
  }
  return [...names];
}
