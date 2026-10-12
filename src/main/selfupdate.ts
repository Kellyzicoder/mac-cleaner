import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';

const run = promisify(execFile);

/** A GUI app has a tiny PATH, so run in a login shell to find git and node like Terminal does. */
const SHELL = '/bin/zsh';

/** True if this folder is the Mac Purificator source (a git copy of the repo). */
export async function isSourceFolder(dir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
    await fs.stat(path.join(dir, '.git'));
    return pkg.name === 'mac-purificator';
  } catch {
    return false;
  }
}

export async function findSourceFolder(home: string, saved: string | null): Promise<string | null> {
  const guesses = [saved, path.join(home, 'Downloads', 'mac-cleaner'), path.join(home, 'mac-cleaner'), path.join(home, 'Documents', 'mac-cleaner')];
  for (const g of guesses) if (g && (await isSourceFolder(g))) return g;
  return null;
}

/** Number printed by `git rev-list --count`. */
export function parseCount(text: string): number {
  const n = parseInt(text.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Turns "abc123 feat: thing" lines into plain notes. */
export function parseLog(text: string): string[] {
  return text.split('\n').map((l) => l.trim().replace(/^[0-9a-f]{7,40}\s+/, '')).filter(Boolean);
}

function sh(cmd: string, dir: string, timeout: number): Promise<string> {
  return run(SHELL, ['-lc', cmd], { cwd: dir, timeout, env: { ...process.env, SRC_DIR: dir }, maxBuffer: 4_000_000 }).then((r) => r.stdout);
}

/** Looks only: fetches the list of changes and counts what is new. */
export async function checkBehind(dir: string): Promise<{ behind: number; notes: string[] }> {
  await sh('git fetch origin main', dir, 60_000);
  const behind = parseCount(await sh('git rev-list --count HEAD..origin/main', dir, 20_000));
  const notes = behind > 0 ? parseLog(await sh('git log --oneline -8 HEAD..origin/main', dir, 20_000)) : [];
  return { behind, notes };
}

/** Pulls, installs, builds and installs the new app. Reports the last line of output as progress. */
export function runUpdate(dir: string, onLine: (line: string) => void): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const cmd = 'cd "$SRC_DIR" && git pull --ff-only && npm install && npm run package && npm run install-app';
    const child = spawn(SHELL, ['-lc', cmd], { env: { ...process.env, SRC_DIR: dir } });
    let tail = '';
    const feed = (b: Buffer) => {
      tail = (tail + b.toString()).slice(-4000);
      const last = tail.split('\n').map((l) => l.trim()).filter(Boolean).pop();
      if (last) onLine(last.slice(0, 140));
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => resolve({ ok: false, message: e.message }));
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true, message: 'Updated.' });
      const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ');
      resolve({ ok: false, message: `The update stopped (code ${code}). ${lines}` });
    });
  });
}
