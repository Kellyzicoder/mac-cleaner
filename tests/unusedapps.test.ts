import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanAll } from '../src/main/scanner';
import { cameWithMac } from '../src/main/unusedapps';
import { parseProc, Snapshot } from '../src/main/apps';
import { protectedReason } from '../src/main/safety';
import { trashInfo } from '../src/main/trash';
import { Finding } from '../src/shared/types';

const MB = 1024 * 1024;
const DAY = 86_400_000;
const NOW = Date.now();

function makeHome(): string {
  return fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'cleaner-appsscan-'));
}

/** Makes an app folder of a given size. `store` adds the App Store receipt. */
function makeApp(dir: string, rel: string, mb: number, store = false): string {
  const app = path.join(dir, rel);
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'bin'), Buffer.alloc(mb * MB, 'a'));
  if (store) {
    fs.mkdirSync(path.join(app, 'Contents', '_MASReceipt'));
    fs.writeFileSync(path.join(app, 'Contents', '_MASReceipt', 'receipt'), 'x');
  }
  return app;
}

function find(list: Finding[], name: string): Finding | undefined {
  return list.find((f) => f.category === 'Unused apps' && f.paths[0].endsWith(name));
}

test('apps you have not opened are offered, apps that came with the Mac never are', async () => {
  const home = makeHome();
  try {
    const dir = path.join(home, 'Applications');
    makeApp(dir, 'OldTool.app', 30); // not from the store, unused
    makeApp(dir, 'OldStore.app', 30, true); // from the store, unused
    makeApp(dir, 'Recent.app', 30); // opened 10 days ago
    makeApp(dir, 'Tiny.app', 2); // too small to matter
    makeApp(dir, 'AppleThing.app', 30); // com.apple.* with no store receipt = part of macOS
    makeApp(dir, 'Pages.app', 30, true); // Apple app from the store = not part of macOS
    makeApp(dir, 'Safari.app', 30); // known to come with macOS
    makeApp(dir, 'Running.app', 30); // unused but open right now
    makeApp(dir, 'Suite/Inner.app', 30); // inside a folder of apps
    makeApp(dir, 'NeverOpened.app', 30); // macOS has no open date
    makeApp(dir, 'NoId.app', 30); // cannot read what it is
    fs.mkdirSync(path.join(dir, 'Utilities', 'Terminal.app', 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Utilities', 'Terminal.app', 'Contents', 'big'), Buffer.alloc(30 * MB, 'a'));

    const days: Record<string, number | null> = {
      'OldTool.app': 400, 'OldStore.app': 400, 'Recent.app': 10, 'Tiny.app': 400, 'AppleThing.app': 400,
      'Pages.app': 400, 'Safari.app': 400, 'Running.app': 400, 'Inner.app': 400, 'NeverOpened.app': null, 'NoId.app': 400,
    };
    const ids: Record<string, string | undefined> = {
      'OldTool.app': 'com.vendor.oldtool', 'OldStore.app': 'com.vendor.oldstore', 'Recent.app': 'com.vendor.recent',
      'Tiny.app': 'com.vendor.tiny', 'AppleThing.app': 'com.apple.thing', 'Pages.app': 'com.apple.iWork.Pages',
      'Safari.app': 'com.apple.Safari', 'Running.app': 'com.vendor.running', 'Inner.app': 'com.vendor.inner',
      'NeverOpened.app': 'com.vendor.never', 'NoId.app': undefined,
    };
    const base = (p: string) => path.basename(p);

    const snapshot: Snapshot = {
      procs: [{ ...parseProc(900, 1, path.join(dir, 'Running.app', 'Contents', 'MacOS', 'bin')), bundleId: 'com.vendor.running' }],
      openFiles: new Map(),
    };

    const list = await scanAll({
      home,
      keep: new Set(),
      snapshot,
      now: NOW,
      apps: {
        dirs: [dir],
        bundleId: async (p) => ids[base(p)],
        lastUsed: async (p) => (days[base(p)] === null || days[base(p)] === undefined ? null : new Date(NOW - (days[base(p)] as number) * DAY)),
        dateAdded: async () => new Date(NOW - 500 * DAY),
      },
    });

    const tool = find(list, 'OldTool.app');
    assert.ok(tool, 'unused app found');
    assert.equal(tool.safety, 'ask', 'not from the store: you decide');
    assert.match(tool.whyKeep, /licence/);
    assert.match(tool.whyJunk, /did not come with macOS/);

    const store = find(list, 'OldStore.app');
    assert.equal(store?.safety, 'safe', 'store apps can be downloaded again');
    assert.match(store?.whyJunk ?? '', /download it again for free/);

    assert.ok(!find(list, 'Recent.app'), 'recently opened');
    assert.ok(!find(list, 'Tiny.app'), 'too small');
    assert.ok(!find(list, 'AppleThing.app'), 'came with macOS');
    assert.ok(!find(list, 'Safari.app'), 'came with macOS');
    assert.ok(!find(list, 'Terminal.app'), 'Utilities are never looked at');
    assert.ok(!find(list, 'NoId.app'), 'unknown apps are left alone');
    assert.equal(find(list, 'Pages.app')?.safety, 'safe', 'Apple apps from the store are not part of macOS');
    assert.ok(find(list, 'Inner.app'), 'apps inside a folder are found');

    const never = find(list, 'NeverOpened.app');
    assert.ok(never);
    assert.match(never.whyJunk, /no record/);

    assert.deepEqual(find(list, 'Running.app')?.inUseBy, ['Running'], 'an app that is open is blocked');
    assert.deepEqual(find(list, 'OldTool.app')?.inUseBy, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('cameWithMac', () => {
  assert.equal(cameWithMac('/System/Applications/Mail.app', 'com.apple.mail', false), true);
  assert.equal(cameWithMac('/Applications/Safari.app', 'com.apple.Safari', false), true);
  assert.equal(cameWithMac('/Applications/Foo.app', 'com.apple.foo', false), true);
  assert.equal(cameWithMac('/Applications/Pages.app', 'com.apple.iWork.Pages', true), false);
  assert.equal(cameWithMac('/Applications/Xcode.app', 'com.apple.dt.Xcode', false), false);
  assert.equal(cameWithMac('/Applications/Foo.app', 'com.vendor.foo', false), false);
});

test('apps in /Applications can be offered, the ones that came with macOS cannot', () => {
  const home = '/Users/test';
  assert.equal(protectedReason('/Applications/Foo.app', home), null);
  assert.equal(protectedReason('/Applications/Suite/Inner.app', home), null);
  assert.equal(protectedReason('/Users/test/Applications/Foo.app', home), null);
  assert.notEqual(protectedReason('/Applications/Safari.app', home), null);
  assert.notEqual(protectedReason('/Applications/Utilities/Terminal.app', home), null);
  assert.notEqual(protectedReason('/System/Applications/Mail.app', home), null);
  assert.notEqual(protectedReason('/Applications', home), null);
  assert.notEqual(protectedReason('/Applications/Foo.app/Contents/MacOS/Foo', home), null);
  assert.notEqual(protectedReason('/Applications/Foo.txt', home), null);
});

test('trashInfo counts what is in the Trash and handles a missing Trash', async () => {
  const home = makeHome();
  try {
    assert.deepEqual(await trashInfo(home), { readable: true, bytes: 0, items: 0 });
    fs.mkdirSync(path.join(home, '.Trash', 'folder'), { recursive: true });
    fs.writeFileSync(path.join(home, '.Trash', 'folder', 'a.bin'), Buffer.alloc(2 * MB, 'a'));
    fs.writeFileSync(path.join(home, '.Trash', 'b.bin'), Buffer.alloc(1 * MB, 'a'));
    fs.writeFileSync(path.join(home, '.Trash', '.DS_Store'), 'x');
    const info = await trashInfo(home);
    assert.equal(info.readable, true);
    assert.equal(info.items, 2, '.DS_Store is not counted');
    assert.ok((info.bytes ?? 0) >= 3 * MB);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a Finder timeout gets a plain message', async () => {
  const { friendlyTrashError } = await import('../src/main/trash');
  assert.match(friendlyTrashError('29:44: execution error: Finder got an error: AppleEvent timed out. (-1712)'), /taking a long time/);
  assert.match(friendlyTrashError('x (-1743)'), /Automation/);
  assert.match(friendlyTrashError('Finder got an error: AppleEvent handler failed. (-10000)'), /locked or in use/);
});
