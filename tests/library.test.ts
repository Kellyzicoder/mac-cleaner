import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listApps, listExtensions, parseExtFolder, parseExtensionsJson, parseLines, parseSoftwareUpdate } from '../src/main/library';

test('extension folder names are read', () => {
  assert.deepEqual(parseExtFolder('ms-python.python-2024.1.0-darwin-arm64'), { ext: 'ms-python.python', version: '2024.1.0' });
  assert.deepEqual(parseExtFolder('esbenp.prettier-vscode-10.4.0'), { ext: 'esbenp.prettier-vscode', version: '10.4.0' });
  assert.equal(parseExtFolder('extensions.json'), null);
});

test('extensions list: install dates and old copies', async () => {
  const home = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'lib-'));
  const dir = path.join(home, '.vscode', 'extensions');
  fs.mkdirSync(path.join(dir, 'a.b-1.0.0'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'a.b-2.0.0'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.b-2.0.0', 'x.txt'), 'hello');
  const t = Date.UTC(2023, 5, 1);
  fs.writeFileSync(path.join(dir, 'extensions.json'), JSON.stringify([{ relativeLocation: 'a.b-2.0.0', metadata: { installedTimestamp: t } }]));
  const { rows, paths } = await listExtensions(home);
  const n = rows.find((r) => r.version === '2.0.0')!;
  assert.equal(n.installedMs, t);
  assert.equal(n.oldCopy, false);
  assert.equal(rows.find((r) => r.version === '1.0.0')!.oldCopy, true);
  assert.ok(paths.get(n.id)!.endsWith('a.b-2.0.0'));
  assert.equal(parseExtensionsJson('not json').size, 0);
});

test('apps list shows every app you installed, with dates, and skips macOS apps', async () => {
  const home = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'libapps-'));
  const apps = path.join(home, 'Apps');
  for (const n of ['Mine.app', 'Safari.app']) fs.mkdirSync(path.join(apps, n, 'Contents'), { recursive: true });
  const used = new Date('2024-02-03T00:00:00Z');
  const { rows } = await listApps(home, {
    dirs: [apps],
    lastUsed: async () => used,
    dateAdded: async () => null,
    bundleId: async (p) => (p.includes('Safari') ? 'com.apple.Safari' : 'com.me.mine'),
  });
  assert.deepEqual(rows.map((r) => r.name), ['Mine']);
  assert.equal(rows[0].lastOpenedMs, used.getTime());
});

test('update tool output is read', () => {
  assert.deepEqual(parseSoftwareUpdate('Software Update Tool\n\n* Label: macOS Sequoia 15.1-24B83\n\tTitle: macOS'), ['macOS Sequoia 15.1-24B83']);
  assert.deepEqual(parseLines('a\n\n b \n'), ['a', 'b']);
});
