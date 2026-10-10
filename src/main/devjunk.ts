import { promises as fs } from 'fs';
import * as path from 'path';
import { RawFinding, Safety } from '../shared/types';
import { DAY, MB, daysAgo, isPackageDir, lstatSafe, measure, walk, humanSize } from './fsutil';

/** Where people usually keep code. Only these are searched. */
const PROJECT_ROOTS = [
  'Developer', 'Projects', 'Code', 'code', 'dev', 'src', 'repos', 'work', 'workspace',
  'GitHub', 'github', 'Sites', 'Desktop', 'Documents',
];

const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'];
const IDLE_DAYS = 60;
const MIN_BYTES = 20 * MB;

interface JunkKind {
  name: string;
  label: string;
  /** If set, the folder only counts when a sibling with one of these names exists. */
  needsSibling?: string[];
  /** Build output that is always cheap to recreate. */
  alwaysSafe?: boolean;
  recreate: (siblings: string[]) => string;
}

const KINDS: JunkKind[] = [
  { name: 'node_modules', label: 'node_modules', recreate: () => 'Run "npm install" (or yarn / pnpm / bun) in the project to get it back.' },
  { name: '.next', label: 'Next.js build cache (.next)', alwaysSafe: true, recreate: () => 'Next.js rebuilds it the next time you run or build the project.' },
  { name: '.nuxt', label: 'Nuxt build cache (.nuxt)', alwaysSafe: true, recreate: () => 'Nuxt rebuilds it the next time you run the project.' },
  { name: '.svelte-kit', label: 'SvelteKit build cache', alwaysSafe: true, recreate: () => 'SvelteKit rebuilds it the next time you run the project.' },
  { name: '.turbo', label: 'Turborepo cache (.turbo)', alwaysSafe: true, recreate: () => 'Turborepo rebuilds it on the next run.' },
  { name: '.parcel-cache', label: 'Parcel cache', alwaysSafe: true, recreate: () => 'Parcel rebuilds it on the next run.' },
  { name: '__pycache__', label: 'Python compiled files (__pycache__)', alwaysSafe: true, recreate: () => 'Python recreates these when the code runs.' },
  { name: '.venv', label: 'Python virtual environment (.venv)', needsSibling: ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'], recreate: () => 'Recreate it with "python -m venv .venv" and install from requirements.txt / pyproject.toml.' },
  { name: 'venv', label: 'Python virtual environment (venv)', needsSibling: ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'], recreate: () => 'Recreate it with "python -m venv venv" and install from requirements.txt / pyproject.toml.' },
  { name: 'target', label: 'Rust build output (target)', needsSibling: ['Cargo.toml'], recreate: () => 'Run "cargo build". The first build takes a while.' },
  { name: '.angular', label: 'Angular cache (.angular)', needsSibling: ['angular.json'], alwaysSafe: true, recreate: () => 'Angular rebuilds it the next time you build or run the project.' },
  { name: '.dart_tool', label: 'Dart / Flutter build files (.dart_tool)', needsSibling: ['pubspec.yaml'], alwaysSafe: true, recreate: () => 'Run "flutter pub get" (or "dart pub get") in the project.' },
  { name: '.gradle', label: 'Gradle project cache (.gradle)', needsSibling: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'], alwaysSafe: true, recreate: () => 'Gradle rebuilds it on the next build.' },
  { name: '.pytest_cache', label: 'pytest cache (.pytest_cache)', alwaysSafe: true, recreate: () => 'pytest makes it again on the next run.' },
  { name: '.mypy_cache', label: 'mypy cache (.mypy_cache)', alwaysSafe: true, recreate: () => 'mypy makes it again on the next run.' },
  { name: '.ruff_cache', label: 'ruff cache (.ruff_cache)', alwaysSafe: true, recreate: () => 'ruff makes it again on the next run.' },
  { name: 'Pods', label: 'CocoaPods libraries (Pods)', needsSibling: ['Podfile'], recreate: () => 'Run "pod install" in the project.' },
];

const kindByName = new Map(KINDS.map((k) => [k.name, k]));

async function projectLastActivity(parent: string, junkNames: Set<string>): Promise<number> {
  // Newest change among the project's own top-level items (including .git, which changes on commit).
  let newest = 0;
  let names: string[] = [];
  try {
    names = await fs.readdir(parent);
  } catch {
    return 0;
  }
  for (const n of names) {
    if (junkNames.has(n)) continue;
    const st = await lstatSafe(path.join(parent, n));
    if (st && st.mtimeMs > newest) newest = st.mtimeMs;
  }
  return newest;
}

export async function scanDevJunk(home: string, onStep: (s: string) => void, now = Date.now()): Promise<RawFinding[]> {
  const found: { full: string; kind: JunkKind; parent: string }[] = [];
  const junkNames = new Set(KINDS.map((k) => k.name));

  for (const rootName of PROJECT_ROOTS) {
    const root = path.join(home, rootName);
    if (!(await lstatSafe(root))) continue;
    onStep(`Looking for old project folders in ${rootName}`);
    await walk(root, {
      maxDepth: 7,
      skipDir: (name) => name === '.git' || name === '.Trash' || name.startsWith('.') && !kindByName.has(name) || isPackageDir(name),
      onDir: (full, name) => {
        const kind = kindByName.get(name);
        if (!kind) return true;
        found.push({ full, kind, parent: path.dirname(full) });
        return false; // do not look inside junk
      },
    });
  }

  const out: RawFinding[] = [];
  for (const f of found) {
    let siblings: string[] = [];
    try {
      siblings = await fs.readdir(f.parent);
    } catch {
      continue;
    }
    if (f.kind.needsSibling && !f.kind.needsSibling.some((s) => siblings.includes(s))) continue;

    const m = await measure(f.full);
    if (m.bytes < MIN_BYTES) continue;

    const lastActive = await projectLastActivity(f.parent, junkNames);
    const idle = lastActive ? daysAgo(lastActive, now) : 9999;
    const projectName = path.basename(f.parent);
    const stale = idle >= IDLE_DAYS;

    let safety: Safety;
    let whyKeep: string;
    if (f.kind.alwaysSafe) {
      safety = 'safe';
      whyKeep = 'If a dev server for this project is running, stop it first. Otherwise nothing is lost, it is only a speed-up.';
    } else if (f.kind.name === 'node_modules') {
      const hasLock = LOCKFILES.some((l) => siblings.includes(l));
      if (hasLock && stale) {
        safety = 'safe';
        whyKeep = `You have not changed "${projectName}" in ${idle >= 9999 ? 'a long time' : idle + ' days'} and it has a lockfile, so the exact same packages come back on install. The only cost is time and internet.`;
      } else {
        safety = 'ask';
        const reasons: string[] = [];
        if (!stale) reasons.push(`you changed "${projectName}" ${idle} days ago, so you may still be working on it`);
        if (!hasLock) reasons.push('there is no lockfile, so reinstalling might give you different package versions');
        whyKeep = `Not sure: ${reasons.join(' and ')}.`;
      }
    } else {
      if (stale) {
        safety = 'safe';
        whyKeep = `"${projectName}" has not changed in ${idle >= 9999 ? 'a long time' : idle + ' days'}. Rebuilding costs only time.`;
      } else {
        safety = 'ask';
        whyKeep = `You changed "${projectName}" ${idle} days ago, so you may still be working on it. Rebuilding this can take a while.`;
      }
    }

    out.push({
      id: `devjunk:${f.full}`,
      category: 'Old project files',
      title: `${f.kind.label} in ${projectName} (${humanSize(m.bytes)})`.replace(/ \([\d.]+ (GB|MB|KB)\)$/, ''),
      paths: [f.full],
      displayPath: f.full,
      sizeBytes: m.bytes,
      safety,
      whyJunk: 'This folder is generated from your project\'s own files, so it is not your work. It takes a lot of space.',
      whyKeep,
      afterRemoval: f.kind.recreate(siblings),
      lastModified: m.newest,
    });
  }
  return out;
}

export { DAY };
