import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanAll } from '../src/main/scanner';
import { EMPTY_SNAPSHOT, parseProc, Snapshot } from '../src/main/apps';
import { HIDDEN_MIN } from '../src/main/hidden';
import { protectedReason } from '../src/main/safety';
import { Finding } from '../src/shared/types';

const MB = 1024 * 1024;
const DAY = 86_400_000;

function makeHome(): string {
  return fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'cleaner-hidden-'));
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

function find(list: Finding[], part: string): Finding | undefined {
  return list.find((f) => f.displayPath.includes(part) || f.paths.some((x) => x.includes(part)));
}

test('hidden folders are read, explained, and the private ones are never offered', async () => {
  const home = makeHome();
  try {
    // Known hidden folders
    put(home, '.nvm/versions/node/v18.0.0/bin/node', 5 * MB, 100);
    put(home, '.nvm/versions/node/v20.0.0/bin/node', 5 * MB, 100);
    put(home, '.expo/native-modules-cache/x.bin', 5 * MB, 100);
    put(home, '.npm/_logs/old.log', 2 * MB, 20);
    put(home, '.npm/_logs/new.log', 2 * MB, 0);
    put(home, '.zsh_sessions/old.session', 2 * MB, 40);

    // An unknown big hidden folder
    put(home, '.mystery/data.bin', HIDDEN_MIN + 10 * MB, 10);
    // Private hidden folders, even when big
    put(home, '.config/somebig/data.bin', HIDDEN_MIN + 10 * MB, 10);
    put(home, '.ssh/id_ed25519', 2 * MB, 10);
    put(home, '.docker/big.bin', HIDDEN_MIN + 10 * MB, 10);

    // Hidden folders inside Downloads and inside a project
    put(home, 'Downloads/.stash/old.dmg', 5 * MB, 90);
    put(home, 'Developer/ng/package.json', 100, 100);
    put(home, 'Developer/ng/angular.json', 100, 100);
    put(home, 'Developer/ng/.angular/cache/x.bin', 25 * MB, 100);
    put(home, 'Developer/py/main.py', 100, 100);
    put(home, 'Developer/py/.pytest_cache/x.bin', 25 * MB, 100);
    // Copies inside hidden folders are not offered as duplicates
    put(home, 'Documents/.hiddenA/copy.bin', 2 * MB, 30);
    put(home, 'Documents/.hiddenB/copy.bin', 2 * MB, 10);

    const snapshot: Snapshot = {
      procs: [parseProc(300, 1, `${home}/.nvm/versions/node/v20.0.0/bin/node server.js`)],
      openFiles: new Map(),
    };
    const list = await scanAll({ home, apps: { dirs: [] }, keep: new Set(), snapshot });

    const nvm18 = find(list, 'v18.0.0');
    assert.ok(nvm18, 'old node version found');
    assert.equal(nvm18.safety, 'ask');
    assert.equal(nvm18.category, 'Hidden folders');
    assert.deepEqual(nvm18.inUseBy, []);
    assert.deepEqual(find(list, 'v20.0.0')?.inUseBy, ['node'], 'the node version that is running is blocked');

    assert.equal(find(list, '.expo')?.safety, 'ask');

    const logs = find(list, '.npm/_logs');
    assert.equal(logs?.safety, 'safe');
    assert.equal(logs?.paths.length, 1, 'only the old log');
    assert.equal(find(list, '.zsh_sessions')?.safety, 'safe');

    const mystery = find(list, '.mystery');
    assert.ok(mystery, 'unknown big hidden folder found');
    assert.equal(mystery.safety, 'ask');
    assert.match(mystery.whyJunk, /often fine to delete/);
    assert.match(mystery.whyKeep, /settings, logins or saved data/);

    for (const never of ['.config', '.ssh', '.docker']) {
      assert.ok(!list.some((f) => f.paths.some((p) => p.includes(`${home}/${never}`))), `${never} is never offered`);
    }

    assert.equal(find(list, 'Downloads/.stash/old.dmg')?.safety, 'safe', 'installer inside a hidden folder found');
    assert.equal(find(list, 'Developer/ng/.angular')?.safety, 'safe');
    assert.equal(find(list, 'Developer/py/.pytest_cache')?.safety, 'safe');
    assert.equal(list.filter((f) => f.category === 'Duplicates').length, 0, 'no duplicates from hidden folders');

    // Nothing is listed twice or inside something else that is listed
    const all = list.flatMap((f) => f.paths);
    for (const a of all) {
      assert.ok(!all.some((b) => b !== a && a.startsWith(b + '/')), `${a} is inside another listed path`);
    }
    for (const f of list) {
      assert.ok(f.whyJunk.length > 10 && f.whyKeep.length > 10);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('private hidden places are protected even if something tries to remove them', () => {
  const home = '/Users/test';
  for (const p of [
    '/Users/test/.config/anything', '/Users/test/.local/share/x', '/Users/test/.docker/config.json',
    '/Users/test/.zshrc', '/Users/test/.gitconfig', '/Users/test/.oh-my-zsh/plugins', '/Users/test/.Trash/x',
  ]) {
    assert.notEqual(protectedReason(p, home), null, `${p} should be protected`);
  }
  for (const p of ['/Users/test/.nvm/versions/node/v18.0.0', '/Users/test/.expo', '/Users/test/.vscode/extensions']) {
    assert.equal(protectedReason(p, home), null, `${p} may be offered`);
  }
});

test('scan with nothing hidden still works', async () => {
  const home = makeHome();
  try {
    const list = await scanAll({ home, apps: { dirs: [] }, keep: new Set(), snapshot: EMPTY_SNAPSHOT });
    assert.deepEqual(list, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
