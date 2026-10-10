import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanAll } from '../src/main/scanner';
import { getSnapshot, parseProc, ProcInfo, Snapshot } from '../src/main/apps';
import { inUseText } from '../src/shared/text';
import { Finding } from '../src/shared/types';

const MB = 1024 * 1024;
const DAY = 86_400_000;

function makeHome(): string {
  return fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'cleaner-apps-'));
}

function put(home: string, rel: string, bytes: number, ageDays: number): string {
  const full = path.join(home, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes, 'a'));
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(full, t, t);
  for (let dir = path.dirname(full); dir !== home && dir.startsWith(home); dir = path.dirname(dir)) {
    fs.utimesSync(dir, t, t);
  }
  return full;
}

function proc(over: Partial<ProcInfo> & { pid: number; command: string }): ProcInfo {
  const p = parseProc(over.pid, 1, over.command);
  return { ...p, ...over };
}

function find(list: Finding[], part: string): Finding | undefined {
  return list.find((f) => f.displayPath.includes(part) || f.title.includes(part) || f.paths.some((x) => x.includes(part)));
}

test('parseProc tells apps from programs that only mention an app', () => {
  const app = parseProc(5, 1, '/Applications/Visual Studio Code.app/Contents/MacOS/Electron --foo');
  assert.equal(app.appName, 'Visual Studio Code');
  const helper = parseProc(6, 5, '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper');
  assert.equal(helper.appName, 'Claude', 'helpers belong to the outer app');
  const node = parseProc(7, 1, '/usr/local/bin/node /Users/x/Foo.app/Contents/thing.js');
  assert.equal(node.appName, undefined, 'a node script is not an app');
  assert.equal(node.name, 'node');
});

test('items used by running apps are flagged, others are not', async () => {
  const home = makeHome();
  try {
    put(home, 'Library/Application Support/Claude/Cache/x.bin', 3 * MB, 5);
    put(home, '.claude/debug/old.log', 2 * MB, 20);
    put(home, 'Library/Caches/com.foo.app/data.bin', 60 * MB, 5);
    put(home, 'Library/Caches/com.bar.app/data.bin', 60 * MB, 5);
    put(home, 'Developer/live/package.json', 100, 100);
    put(home, 'Developer/live/package-lock.json', 100, 100);
    put(home, 'Developer/live/node_modules/x/big.bin', 25 * MB, 100);
    put(home, 'Developer/quiet/package.json', 100, 100);
    put(home, 'Developer/quiet/package-lock.json', 100, 100);
    put(home, 'Developer/quiet/node_modules/x/big.bin', 25 * MB, 100);
    const openFile = put(home, 'Downloads/old-installer.dmg', 5 * MB, 90);
    put(home, 'Downloads/other-installer.dmg', 5 * MB, 90);
    const noisyFile = put(home, 'Downloads/third-installer.dmg', 5 * MB, 90);

    const snapshot: Snapshot = {
      procs: [
        // Claude desktop app is open, Claude Code (the terminal tool) is not
        proc({ pid: 100, command: '/Applications/Claude.app/Contents/MacOS/Claude', bundleId: 'com.anthropic.claudefordesktop' }),
        // an app that owns com.foo.app
        proc({ pid: 101, command: '/Applications/Foo.app/Contents/MacOS/Foo', bundleId: 'com.foo.app' }),
        // a dev server working inside the "live" project
        proc({ pid: 102, command: 'node server.js', cwd: path.join(home, 'Developer/live') }),
      ],
      openFiles: new Map([
        [openFile, new Set(['Preview'])],
        [noisyFile, new Set(['mdworker_shared'])],
      ]),
    };
    // mdworker is background noise, so it must be dropped by getSnapshot. Simulate what it keeps.
    snapshot.openFiles.delete(noisyFile);

    const list = await scanAll({ home, apps: { dirs: [] }, keep: new Set(), snapshot });

    assert.deepEqual(find(list, 'Application Support/Claude/Cache')?.inUseBy, ['Claude']);
    assert.deepEqual(find(list, '.claude/debug')?.inUseBy, [], 'Claude Code is not running');
    assert.deepEqual(find(list, 'com.foo.app')?.inUseBy, ['Foo']);
    assert.deepEqual(find(list, 'com.bar.app')?.inUseBy, []);
    assert.deepEqual(find(list, 'Developer/live/node_modules')?.inUseBy, ['node']);
    assert.deepEqual(find(list, 'Developer/quiet/node_modules')?.inUseBy, []);
    assert.deepEqual(find(list, 'old-installer.dmg')?.inUseBy, ['Preview']);
    assert.deepEqual(find(list, 'other-installer.dmg')?.inUseBy, []);

    // Who normally uses it is shown too
    assert.deepEqual(find(list, 'Application Support/Claude/Cache')?.usedBy, ['Claude']);
    assert.deepEqual(find(list, '.claude/debug')?.usedBy, ['Claude Code']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a running Claude Code program blocks Claude Code leftovers, not the desktop app ones', async () => {
  const home = makeHome();
  try {
    put(home, '.claude/debug/old.log', 2 * MB, 20);
    put(home, 'Library/Application Support/Claude/Cache/x.bin', 3 * MB, 5);
    const snapshot: Snapshot = {
      procs: [proc({ pid: 200, command: '/Users/me/.nvm/versions/node/v22/bin/claude' })],
      openFiles: new Map(),
    };
    const list = await scanAll({ home, apps: { dirs: [] }, keep: new Set(), snapshot });
    assert.deepEqual(find(list, '.claude/debug')?.inUseBy, ['Claude Code']);
    assert.deepEqual(find(list, 'Application Support/Claude/Cache')?.inUseBy, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('getSnapshot leaves out this program itself', async () => {
  const snap = await getSnapshot();
  assert.ok(!snap.procs.some((p) => p.pid === process.pid));
});

test('the "in use" sentence is plain', () => {
  assert.equal(inUseText(['Claude']), 'Claude is using this right now. Quit it, then press Re-check.');
  assert.equal(inUseText(['A', 'B']), 'A, B are using this right now. Quit them, then press Re-check.');
});
