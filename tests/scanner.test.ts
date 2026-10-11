import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanAll } from '../src/main/scanner';
import { protectedReason } from '../src/main/safety';
import { Finding } from '../src/shared/types';
import { EMPTY_SNAPSHOT } from '../src/main/apps';

const MB = 1024 * 1024;
const DAY = 86_400_000;

function makeHome(): string {
  return fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'cleaner-home-'));
}

function put(home: string, rel: string, bytes: number, ageDays: number, fill = 'a'): void {
  const full = path.join(home, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes, fill));
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(full, t, t);
  // Folder times also count as "last changed", so age the folders above the file too.
  for (let dir = path.dirname(full); dir !== home && dir.startsWith(home); dir = path.dirname(dir)) {
    fs.utimesSync(dir, t, t);
  }
}

function find(list: Finding[], part: string): Finding | undefined {
  return list.find((f) => f.displayPath.includes(part) || f.title.includes(part));
}

test('scanner classifies safe vs ask and respects protection', async () => {
  const home = makeHome();
  try {
    // Claude Code leftovers
    put(home, '.claude/debug/old.log', 2 * MB, 20);
    put(home, '.claude/debug/new.log', 3 * MB, 0);
    put(home, '.claude/projects/old-proj/session.jsonl', 6 * MB, 40);
    put(home, '.claude/projects/live-proj/session.jsonl', 6 * MB, 1);
    put(home, '.claude/settings.json', 2 * MB, 100); // protected, must never appear
    put(home, '.claude/skills/mine/SKILL.md', 2 * MB, 100); // protected

    // App caches
    put(home, 'Library/Caches/com.foo.app/data.bin', 60 * MB, 5);
    put(home, 'Library/Caches/com.apple.thing/data.bin', 60 * MB, 5);

    // Dev projects: old with lockfile (safe), recent (ask), old without lockfile (ask)
    put(home, 'Developer/old-app/package.json', 100, 100);
    put(home, 'Developer/old-app/package-lock.json', 100, 100);
    put(home, 'Developer/old-app/node_modules/x/big.bin', 25 * MB, 100);
    put(home, 'Developer/new-app/package.json', 100, 1);
    put(home, 'Developer/new-app/package-lock.json', 100, 1);
    put(home, 'Developer/new-app/node_modules/x/big.bin', 25 * MB, 1);
    put(home, 'Developer/nolock-app/package.json', 100, 100);
    put(home, 'Developer/nolock-app/node_modules/x/big.bin', 25 * MB, 100);
    put(home, 'Developer/next-app/package.json', 100, 1);
    put(home, 'Developer/next-app/.next/cache/big.bin', 25 * MB, 1);

    // Downloads
    put(home, 'Downloads/old-installer.dmg', 5 * MB, 90);
    put(home, 'Downloads/new-installer.dmg', 5 * MB, 2);
    put(home, 'Downloads/dup1.bin', 2 * MB, 30, 'z');
    put(home, 'Downloads/dup2.bin', 2 * MB, 10, 'z');
    put(home, 'Downloads/different.bin', 2 * MB, 10, 'y');
    put(home, 'Documents/MyThesis/node_modules/ignored.txt', 1, 1); // too small, ignored

    const list = await scanAll({ home, apps: { dirs: [] }, keep: new Set(), snapshot: EMPTY_SNAPSHOT });

    // Claude
    const dbg = find(list, '.claude/debug');
    assert.ok(dbg, 'debug logs found');
    assert.equal(dbg.safety, 'safe');
    assert.equal(dbg.paths.length, 1, 'only the old log, not the new one');
    assert.ok(dbg.paths[0].endsWith('old.log'));

    const old = find(list, 'old-proj');
    assert.ok(old, 'old chat history found');
    assert.equal(old.safety, 'ask');
    assert.ok(!find(list, 'live-proj'), 'recent chat history left alone');
    assert.ok(!list.some((f) => f.paths.some((p) => p.includes('settings.json') || p.includes('skills'))), 'user config is protected');

    // Caches
    assert.equal(find(list, 'com.foo.app')?.safety, 'safe');
    assert.equal(find(list, 'com.apple.thing')?.safety, 'ask');

    // Dev junk
    assert.equal(find(list, 'Developer/old-app/node_modules')?.safety, 'safe');
    assert.equal(find(list, 'Developer/new-app/node_modules')?.safety, 'ask');
    const nolock = find(list, 'Developer/nolock-app/node_modules');
    assert.equal(nolock?.safety, 'ask');
    assert.match(nolock?.whyKeep ?? '', /lockfile/);
    assert.equal(find(list, 'Developer/next-app/.next')?.safety, 'safe');

    // Installers and duplicates
    assert.equal(find(list, 'old-installer.dmg')?.safety, 'safe');
    assert.equal(find(list, 'new-installer.dmg')?.safety, 'ask');
    const dups = list.filter((f) => f.category === 'Duplicates');
    assert.equal(dups.length, 1, 'exactly one extra copy');
    assert.ok(dups[0].paths[0].endsWith('dup2.bin'), 'the newer copy is offered, the oldest is kept');

    // Every finding has a reason for both sides
    for (const f of list) {
      assert.ok(f.whyJunk.length > 10, `${f.title} has whyJunk`);
      assert.ok(f.whyKeep.length > 10, `${f.title} has whyKeep`);
    }

    // "Always keep" hides it next scan
    const again = await scanAll({ home, apps: { dirs: [] }, keep: new Set([old.id]), snapshot: EMPTY_SNAPSHOT });
    assert.ok(!find(again, 'old-proj'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('big files over 500 MB are found and need a decision', async () => {
  const home = makeHome();
  try {
    put(home, 'Movies/huge.mov', 510 * MB, 3);
    const list = await scanAll({ home, apps: { dirs: [] }, keep: new Set(), snapshot: EMPTY_SNAPSHOT });
    const big = find(list, 'huge.mov');
    assert.ok(big);
    assert.equal(big.safety, 'ask');
    assert.equal(big.category, 'Big files');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('protected paths can never be cleaned', () => {
  const home = '/Users/test';
  const blocked = [
    '/Users/test', '/Users/test/Documents', '/Users/test/Library', '/Users/test/.ssh/id_ed25519',
    '/Users/test/Library/Keychains/login.keychain-db', '/Users/test/.claude/settings.json',
    '/Users/test/.claude/skills/x', '/Users/test/Developer/app/.git/objects', '/etc/passwd',
    '/Users/test/Pictures/Photos Library.photoslibrary/originals/a.jpg', '/Users/test/app/.env',
    '/Users/test/../other/file',
  ];
  for (const p of blocked) assert.notEqual(protectedReason(p, home), null, `${p} should be protected`);
  const allowed = [
    '/Users/test/Library/Caches/com.foo.app', '/Users/test/Developer/app/node_modules',
    '/Users/test/.claude/projects/old', '/Users/test/Downloads/old.dmg',
  ];
  for (const p of allowed) assert.equal(protectedReason(p, home), null, `${p} should be allowed`);
});

test('Claude saved memory is never offered, and a project folder that holds it is skipped', async () => {
  const home = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'cleaner-mem-'));
  try {
    const old = new Date(Date.now() - 100 * 86_400_000);
    const mk = (rel: string, mb: number) => {
      const f = path.join(home, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, Buffer.alloc(mb * 1024 * 1024, 'a'));
      fs.utimesSync(f, old, old);
      fs.utimesSync(path.dirname(f), old, old);
    };
    mk('.claude/projects/-with-memory/chat.jsonl', 8);
    mk('.claude/projects/-with-memory/memory/notes.md', 1);
    mk('.claude/projects/-plain/chat.jsonl', 8);
    const list = await scanAll({ home, keep: new Set(), now: Date.now(), apps: { dirs: [] }, snapshot: EMPTY_SNAPSHOT });
    const hist = list.filter((f) => f.id.includes('claude-code-projects'));
    assert.equal(hist.length, 1, 'only the plain project is offered');
    assert.ok(hist[0].paths[0].endsWith('-plain'));
    assert.notEqual(protectedReason(path.join(home, '.claude/projects/-with-memory'), home), null);
    assert.notEqual(protectedReason(path.join(home, '.claude/projects/-with-memory/memory/notes.md'), home), null);
    assert.equal(protectedReason(path.join(home, '.claude/projects/-plain'), home), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
