import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { Battery, DashInfo, DeviceInfo, NetSpeed, SecurityCheck } from '../shared/types';

const run = promisify(execFile);

/** Runs a command with fixed arguments. Returns the output even when the command exits with an error. */
async function out(cmd: string, args: string[], timeout = 8000): Promise<string> {
  try {
    const r = await run(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
    return String(r.stdout);
  } catch (e) {
    const err = e as { stdout?: string };
    return err.stdout ? String(err.stdout) : '';
  }
}

// ---------- parsers (plain text in, numbers out, so they can be tested) ----------

export function parsePmset(text: string): Pick<Battery, 'present' | 'percent' | 'charging' | 'pluggedIn' | 'remaining'> {
  const pluggedIn = /AC Power/.test(text);
  const m = /(\d+)%;\s*([^;\n]+)(?:;\s*([^\n]*))?/.exec(text);
  if (!m) return { present: false, percent: null, charging: false, pluggedIn, remaining: null };
  const state = m[2].trim().toLowerCase();
  const rest = m[3] ?? '';
  const t = /(\d+:\d+)\s+remaining/.exec(rest);
  return {
    present: true,
    percent: Number(m[1]),
    charging: state === 'charging' || state === 'finishing charge',
    pluggedIn,
    remaining: t ? t[1] : null,
  };
}

export function parsePowerProfile(text: string): Pick<Battery, 'healthPercent' | 'cycles' | 'condition'> {
  const cap = /Maximum Capacity:\s*(\d+)\s*%/.exec(text);
  const cyc = /Cycle Count:\s*(\d+)/.exec(text);
  const con = /Condition:\s*([^\n]+)/.exec(text);
  return {
    healthPercent: cap ? Number(cap[1]) : null,
    cycles: cyc ? Number(cyc[1]) : null,
    condition: con ? con[1].trim() : null,
  };
}

/** `memory_pressure` prints "System-wide memory free percentage: 54%". Pressure = 100 - free. */
export function parseMemoryPressure(text: string): number | null {
  const m = /free percentage:\s*(\d+)\s*%/i.exec(text);
  return m ? Math.max(0, Math.min(100, 100 - Number(m[1]))) : null;
}

/** `netstat -ib`: add up bytes in and out for the Wi-Fi / Ethernet ports (en0, en1 ...). */
export function parseNetstat(text: string): { inBytes: number; outBytes: number } {
  let inBytes = 0;
  let outBytes = 0;
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || !/^en\d+$/.test(f[0]) || !f[2]?.startsWith('<Link#')) continue;
    // The last columns are always: Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    const ib = Number(f[f.length - 5]);
    const ob = Number(f[f.length - 2]);
    if (Number.isFinite(ib)) inBytes += ib;
    if (Number.isFinite(ob)) outBytes += ob;
  }
  return { inBytes, outBytes };
}

export function parseDiskutil(text: string): { external: boolean; smart: string | null; name: string | null } {
  const loc = /Device Location:\s*(\w+)/.exec(text);
  const internal = /Internal:\s*(Yes|No)/.exec(text);
  const smart = /SMART Status:\s*([^\n]+)/.exec(text);
  const name = /Volume Name:\s*([^\n]+)/.exec(text);
  const external = loc ? loc[1].toLowerCase() === 'external' : internal ? internal[1] === 'No' : false;
  return { external, smart: smart ? smart[1].trim() : null, name: name ? name[1].trim() : null };
}

export function parseModel(text: string): string | null {
  const m = /Model Name:\s*([^\n]+)/.exec(text);
  return m ? m[1].trim() : null;
}

export function healthFrom(input: {
  availablePercent: number;
  memoryPressure: number | null;
  battery: Battery;
  driveStatus: string | null;
}): DashInfo['health'] {
  const reasons: string[] = [];
  let care = 0;
  let okay = 0;
  if (input.availablePercent < 10) { care++; reasons.push('Your disk is almost full.'); }
  else if (input.availablePercent < 20) { okay++; reasons.push('Your disk is getting full.'); }
  if (input.memoryPressure !== null && input.memoryPressure >= 85) { care++; reasons.push('Memory is under a lot of pressure.'); }
  else if (input.memoryPressure !== null && input.memoryPressure >= 65) { okay++; reasons.push('Memory is busy.'); }
  const b = input.battery;
  if (b.present && b.condition && !/normal/i.test(b.condition)) { care++; reasons.push(`Battery condition: ${b.condition}.`); }
  else if (b.present && b.healthPercent !== null && b.healthPercent < 80) { okay++; reasons.push('Battery holds less charge than when new.'); }
  if (input.driveStatus && /fail/i.test(input.driveStatus)) { care++; reasons.push('The drive reports a problem.'); }
  return { level: care ? 'care' : okay ? 'okay' : 'good', reasons };
}

// ---------- collectors (need a real Mac) ----------

let lastCpu = os.cpus();
export function cpuLoadPercent(): number {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i]?.times ?? c.times;
    const dIdle = c.times.idle - p.idle;
    const dTotal = (Object.keys(c.times) as (keyof typeof c.times)[]).reduce((a, k) => a + (c.times[k] - p[k]), 0);
    idle += dIdle;
    total += dTotal;
  });
  lastCpu = now;
  return total > 0 ? Math.round(((total - idle) / total) * 100) : 0;
}

let lastNet: { at: number; inBytes: number; outBytes: number } | null = null;
export async function netSpeed(): Promise<NetSpeed> {
  const now = Date.now();
  const cur = parseNetstat(await out('netstat', ['-ib']));
  const prev = lastNet;
  lastNet = { at: now, ...cur };
  if (!prev || now <= prev.at) return { downBytesPerSec: 0, upBytesPerSec: 0 };
  const sec = (now - prev.at) / 1000;
  return {
    downBytesPerSec: Math.max(0, Math.round((cur.inBytes - prev.inBytes) / sec)),
    upBytesPerSec: Math.max(0, Math.round((cur.outBytes - prev.outBytes) / sec)),
  };
}

/** Downloads a 25 MB test file and times it. Only runs when the person presses Test Speed. */
export async function speedTest(): Promise<{ ok: boolean; bytesPerSec: number; message: string }> {
  const start = Date.now();
  try {
    const res = await fetch('https://speed.cloudflare.com/__down?bytes=25000000', { signal: AbortSignal.timeout(30000) });
    const buf = await res.arrayBuffer();
    const sec = Math.max(0.05, (Date.now() - start) / 1000);
    return { ok: true, bytesPerSec: Math.round(buf.byteLength / sec), message: '' };
  } catch {
    return { ok: false, bytesPerSec: 0, message: 'Could not reach the test server. Check your internet.' };
  }
}

let profileCache: { at: number; value: Pick<Battery, 'healthPercent' | 'cycles' | 'condition'> } | null = null;

async function batteryInfo(): Promise<Battery> {
  const base = parsePmset(await out('pmset', ['-g', 'batt']));
  if (!base.present) return { ...base, healthPercent: null, cycles: null, condition: null };
  // system_profiler is slow and battery health changes slowly, so look at it every 10 minutes.
  if (!profileCache || Date.now() - profileCache.at > 10 * 60 * 1000) {
    profileCache = { at: Date.now(), value: parsePowerProfile(await out('system_profiler', ['SPPowerDataType'], 15000)) };
  }
  return { ...base, ...profileCache.value };
}

async function securityChecks(): Promise<SecurityCheck[]> {
  const [fv, sip, gk, fw] = await Promise.all([
    out('fdesetup', ['status']),
    out('csrutil', ['status']),
    out('spctl', ['--status']),
    out('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']),
  ]);
  const yn = (txt: string, yes: RegExp, no: RegExp): boolean | null => (yes.test(txt) ? true : no.test(txt) ? false : null);
  return [
    { label: 'FileVault disk lock', on: yn(fv, /is On/i, /is Off/i), note: 'Scrambles your disk so a lost Mac cannot be read.' },
    { label: 'System Integrity Protection', on: yn(sip, /enabled/i, /disabled/i), note: 'Stops apps changing core macOS files.' },
    { label: 'Gatekeeper app check', on: yn(gk, /enabled/i, /disabled/i), note: 'Checks apps you download before they open.' },
    { label: 'Firewall', on: yn(fw, /enabled|State = [12]/i, /disabled|State = 0/i), note: 'Blocks unwanted incoming connections.' },
  ];
}

/** Plugged-in drives, found in /Volumes. The start-up disk is left out. */
export async function listDevices(): Promise<(DeviceInfo & { mount: string })[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir('/Volumes');
  } catch {
    return [];
  }
  const found: (DeviceInfo & { mount: string })[] = [];
  for (const name of names) {
    const mount = path.join('/Volumes', name);
    const info = parseDiskutil(await out('diskutil', ['info', mount]));
    if (!info.external) continue;
    let free: number | null = null;
    let total: number | null = null;
    try {
      const s = await fs.statfs(mount);
      free = s.bavail * s.bsize;
      total = s.blocks * s.bsize;
    } catch {
      /* unknown */
    }
    found.push({ id: `dev:${name}`, mount, name, bytesFree: free, bytesTotal: total });
  }
  return found;
}

export async function ejectDevice(mount: string): Promise<{ ok: boolean; message: string }> {
  try {
    await run('diskutil', ['eject', mount], { timeout: 30000 });
    return { ok: true, message: 'Ejected. You can unplug it now.' };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    const text = (err.stderr || err.stdout || '').trim().split('\n').pop() ?? '';
    return { ok: false, message: text ? `Could not eject: ${text}` : 'Could not eject. An app may still be using it.' };
  }
}

let cachedModel: string | null = null;

export async function collectDash(lastScanAt: number | null): Promise<{ info: DashInfo; devices: (DeviceInfo & { mount: string })[] }> {
  const home = os.homedir();
  const st = await fs.statfs(home);
  const totalBytes = st.blocks * st.bsize;
  const availableBytes = st.bavail * st.bsize;
  if (!cachedModel) cachedModel = parseModel(await out('system_profiler', ['SPHardwareDataType'], 15000)) ?? 'Mac';
  const [pressureText, battery, security, devices, rootInfo] = await Promise.all([
    out('memory_pressure', []),
    batteryInfo(),
    securityChecks(),
    listDevices(),
    out('diskutil', ['info', '/']),
  ]);
  const memoryPressure = parseMemoryPressure(pressureText);
  const driveStatus = parseDiskutil(rootInfo).smart;
  const health = healthFrom({ availablePercent: (availableBytes / totalBytes) * 100, memoryPressure, battery, driveStatus });
  const info: DashInfo = {
    model: cachedModel,
    disk: { totalBytes, availableBytes },
    memoryPressure,
    memoryTotalBytes: os.totalmem(),
    cpuLoadPercent: cpuLoadPercent(),
    battery,
    driveStatus,
    devices: devices.map(({ mount: _m, ...d }) => d),
    security,
    lastScanAt,
    health,
  };
  return { info, devices };
}
