import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BusyApp, StartupItem } from '../shared/types';

const run = promisify(execFile);

/** Parts of macOS that must never be quit from here. */
const NEVER_QUIT = new Set([
  'kernel_task', 'WindowServer', 'loginwindow', 'Finder', 'Dock', 'SystemUIServer',
  'launchd', 'ControlCenter', 'NotificationCenter', 'Spotlight', 'Electron', 'Mac Purificator',
]);

export interface PsRow { pid: number; cpu: number; name: string }

/** Reads `ps -ceo pid=,pcpu=,comm=` lines. */
export function parsePs(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+(?:[.,]\d+)?)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), cpu: Number(m[2].replace(',', '.')), name: m[3] });
  }
  return rows;
}

/** Only real apps (inside a .app) that are not part of macOS itself can be quit. */
export function canQuit(name: string, fullPath: string): boolean {
  if (NEVER_QUIT.has(name)) return false;
  if (!/\.app\//.test(fullPath)) return false;
  if (fullPath.startsWith('/System/')) return false;
  return true;
}

export async function topCpuApps(limit = 5): Promise<{ list: BusyApp[]; pids: Map<string, number> }> {
  const uid = os.userInfo().uid;
  const { stdout } = await run('ps', ['-U', String(uid), '-ceo', 'pid=,pcpu=,comm=', '-r'], { timeout: 8000, maxBuffer: 4_000_000 });
  const rows = parsePs(stdout).filter((r) => r.pid !== process.pid && r.name !== 'ps' && r.cpu >= 0.1);
  const list: BusyApp[] = [];
  const pids = new Map<string, number>();
  for (const r of rows.slice(0, 12)) {
    let full = '';
    try {
      full = (await run('ps', ['-p', String(r.pid), '-o', 'comm='], { timeout: 4000 })).stdout.trim();
    } catch {
      continue;
    }
    const id = `proc:${r.pid}`;
    pids.set(id, r.pid);
    list.push({ id, name: r.name, cpuPercent: Math.round(r.cpu * 10) / 10, canQuit: canQuit(r.name, full) });
    if (list.length >= limit) break;
  }
  return { list, pids };
}

/** Quits an app politely (SIGTERM, like Quit from the Dock). Checks again that it is a normal app. */
export async function quitApp(pid: number): Promise<{ ok: boolean; message: string }> {
  try {
    const { stdout } = await run('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 4000 });
    const full = stdout.trim();
    const name = path.basename(full);
    if (!full) return { ok: false, message: 'That app is already closed.' };
    if (!canQuit(name, full)) return { ok: false, message: `${name} is part of macOS or is not a normal app, so I will not quit it.` };
    process.kill(pid, 'SIGTERM');
    return { ok: true, message: `Asked ${name} to quit. Unsaved work in it may be lost if it cannot save first.` };
  } catch (e) {
    return { ok: false, message: `Could not quit it: ${(e as Error).message}` };
  }
}

/** "Name1, Name2" from System Events. */
export function parseLoginItems(stdout: string): string[] {
  return stdout.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Turns "com.google.keystone.agent.plist" into a readable name. */
export function agentName(file: string): string {
  const base = file.replace(/\.plist$/, '');
  const parts = base.split('.');
  return parts.length > 2 ? parts.slice(2).join(' ') : base;
}

export async function startupItems(home: string): Promise<{ list: StartupItem[]; paths: Map<string, string> }> {
  const list: StartupItem[] = [];
  const paths = new Map<string, string>();
  try {
    const { stdout } = await run('osascript', ['-e', 'tell application "System Events" to get the name of every login item'], { timeout: 8000 });
    for (const n of parseLoginItems(stdout)) list.push({ id: `login:${n}`, name: n, kind: 'login' });
  } catch {
    // no permission yet: the agents below still show
  }
  const dir = path.join(home, 'Library', 'LaunchAgents');
  try {
    for (const f of (await fs.readdir(dir)).filter((x) => x.endsWith('.plist')).sort()) {
      const id = `agent:${f}`;
      paths.set(id, path.join(dir, f));
      list.push({ id, name: agentName(f), kind: 'agent' });
    }
  } catch {
    // folder does not exist
  }
  return { list, paths };
}
