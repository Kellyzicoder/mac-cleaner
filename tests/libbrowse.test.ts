import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { browseLibrary, judge, matchesInstalled } from '../src/main/librarybrowse';
import { scanPhotoshop } from '../src/main/photoshop';
import { protectedReason } from '../src/main/safety';

const none = new Set<string>();

test('big sensitive folders are never offered', () => {
  for (const r of ['Keychains', 'Mail', 'Messages', 'Mobile Documents', 'Safari', 'Group Containers', 'Preferences']) {
    assert.equal(judge(r, none, none).verdict, 'never', r);
  }
  assert.equal(judge('Application Support/com.apple.TCC', none, none).verdict, 'never');
});

test('caches and logs are safe, containers need care', () => {
  assert.equal(judge('Caches', none, none).verdict, 'safe');
  assert.equal(judge('Caches/com.foo.bar', new Set(['foobar']), new Set(['com.foo.bar'])).verdict, 'safe');
  assert.equal(judge('Containers', none, none).verdict, 'careful');
});

test('a folder with no installed app is flagged as a possible leftover', () => {
  const names = new Set(['slack']);
  const ids = new Set(['com.tinyspeck.slackmacgap']);
  const gone = judge('Application Support/OldEditor', names, ids);
  assert.equal(gone.orphan, true);
  assert.equal(gone.verdict, 'careful');
  assert.match(gone.why, /leftover/);
  assert.equal(judge('Application Support/Slack', names, ids).orphan, false);
  assert.equal(matchesInstalled('com.tinyspeck.slackmacgap.ShipIt', names, ids), true);
  assert.equal(judge('Application Support/com.apple.something', none, none).verdict, 'never');
});

test('browse lists items with reasons and blocks protected ones', async () => {
  const home = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'libb-'));
  const lib = path.join(home, 'Library');
  for (const d of ['Caches', 'Keychains', 'Containers']) fs.mkdirSync(path.join(lib, d), { recursive: true });
  fs.writeFileSync(path.join(lib, 'Caches', 'x.bin'), 'x'.repeat(5000));
  const ids = new Map<string, string>();
  const r = await browseLibrary(home, lib, ids);
  const by = (n: string) => r.entries.find((e) => e.name === n)!;
  assert.equal(by('Keychains').canTrash, false);
  assert.equal(by('Caches').verdict, 'safe');
  assert.equal(by('Caches').canTrash, false); // the main folder itself is protected, only things inside it can go
  const inner = await browseLibrary(home, path.join(lib, 'Caches'), ids);
  assert.equal(inner.entries[0].canTrash, true);
  assert.deepEqual(inner.crumbs.map((c) => c.name), ['Library', 'Caches']);
});

test('Photoshop scratch files are found and allowed only with the right name', async () => {
  const home = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'ps-'));
  const tmp = path.join(home, 'T');
  fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(tmp, 'Photoshop Temp123'), Buffer.alloc(6 * 1024 * 1024));
  fs.writeFileSync(path.join(tmp, 'other.tmp'), Buffer.alloc(6 * 1024 * 1024));
  const found = await scanPhotoshop(home, () => undefined, tmp);
  assert.equal(found.length, 1);
  assert.equal(found[0].category, 'Photoshop scratch');
  assert.equal(protectedReason('/var/folders/ab/cd1234/T/Photoshop Temp123', '/Users/me'), null);
  assert.notEqual(protectedReason('/var/folders/ab/cd1234/T/other.tmp', '/Users/me'), null);
});
