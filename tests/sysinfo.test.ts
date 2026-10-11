import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { healthFrom, parseDiskutil, parseMemoryPressure, parseModel, parseNetstat, parsePmset, parsePowerProfile } from '../src/main/sysinfo';
import { allowedDiskPath, analyzeDisk, listChildren } from '../src/main/diskmap';

const MB = 1024 * 1024;

test('battery text is read', () => {
  const a = parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t20%; discharging; 0:46 remaining present: true\n");
  assert.deepEqual(a, { present: true, percent: 20, charging: false, pluggedIn: false, remaining: '0:46' });
  const b = parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t85%; charging; 1:10 remaining present: true\n");
  assert.equal(b.charging, true);
  assert.equal(b.pluggedIn, true);
  const c = parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n");
  assert.equal(c.charging, false);
  assert.equal(parsePmset("Now drawing from 'AC Power'\n").present, false);
  const d = parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t64%; discharging; (no estimate) present: true\n");
  assert.equal(d.remaining, null);
});

test('battery health is read', () => {
  const t = '    Battery Information:\n      Health Information:\n          Cycle Count: 211\n          Condition: Normal\n          Maximum Capacity: 98%\n';
  assert.deepEqual(parsePowerProfile(t), { healthPercent: 98, cycles: 211, condition: 'Normal' });
  assert.deepEqual(parsePowerProfile(''), { healthPercent: null, cycles: null, condition: null });
});

test('memory pressure is 100 minus the free percent', () => {
  assert.equal(parseMemoryPressure('The system has 8589934592 (524288 pages)\nSystem-wide memory free percentage: 54%\n'), 46);
  assert.equal(parseMemoryPressure('nothing'), null);
});

test('network bytes are added up for en ports only', () => {
  const t = [
    'Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
    'lo0   16384 <Link#1>                          100     0       5000      100     0       5000     0',
    'en0   1500  <Link#6>    aa:bb:cc:dd:ee:ff    2000     0    1000000     1500     0     400000     0',
    'en0   1500  192.168.1     192.168.1.5          2000     -    1000000     1500     -     400000     -',
    'en1   1500  <Link#7>                           10     0       2000       10     0       3000     0',
  ].join('\n');
  assert.deepEqual(parseNetstat(t), { inBytes: 1002000, outBytes: 403000 });
});

test('drive info and model are read', () => {
  const ext = 'Volume Name: PortableSSD\n Device Location: External\n Removable Media: Fixed\n';
  assert.deepEqual(parseDiskutil(ext), { external: true, smart: null, name: 'PortableSSD' });
  const int = 'Volume Name: Macintosh HD\n Internal: Yes\n SMART Status: Verified\n';
  assert.deepEqual(parseDiskutil(int), { external: false, smart: 'Verified', name: 'Macintosh HD' });
  assert.equal(parseModel('Hardware Overview:\n  Model Name: MacBook Air\n  Chip: Apple M2'), 'MacBook Air');
});

test('Mac health', () => {
  const batt = { present: true, percent: 50, charging: false, pluggedIn: false, remaining: null, healthPercent: 98, cycles: 100, condition: 'Normal' };
  assert.equal(healthFrom({ availablePercent: 24, memoryPressure: 46, battery: batt, driveStatus: 'Verified' }).level, 'good');
  assert.equal(healthFrom({ availablePercent: 15, memoryPressure: 46, battery: batt, driveStatus: 'Verified' }).level, 'okay');
  const bad = healthFrom({ availablePercent: 5, memoryPressure: 90, battery: batt, driveStatus: 'Verified' });
  assert.equal(bad.level, 'care');
  assert.equal(bad.reasons.length, 2);
});

test('disk map: sizes, categories and drill-down', async () => {
  const home = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'cleaner-disk-'));
  try {
    const put = (rel: string, mb: number) => {
      const f = path.join(home, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, Buffer.alloc(mb * MB, 'a'));
    };
    put('Documents/a.bin', 4);
    put('Downloads/b.bin', 8);
    put('Library/Caches/big.bin', 20);
    put('Library/Logs/x.bin', 2);
    put('.npm/_cacache/c.bin', 10);
    put('Movies/m.bin', 6);
    const ids = new Map<string, string>();
    const total = 1000 * MB;
    const a = await analyzeDisk(home, total, 700 * MB, ids);
    const cat = Object.fromEntries(a.categories.map((c) => [c.key, c.bytes]));
    assert.ok(cat.documents >= 4 * MB && cat.documents < 5 * MB);
    assert.ok(cat.downloads >= 8 * MB);
    assert.equal(a.usedBytes, 300 * MB);
    // Other is everything used that is not in the four named places, and it can be explored.
    const sum = a.categories.reduce((n, c) => n + c.bytes, 0);
    assert.ok(Math.abs(sum - a.usedBytes) < 1, 'slices add up to used space');
    assert.equal(a.other[0].name === 'macOS, system files and other users (cannot be opened here)' || a.other[0].name === 'Library', true);
    const lib = a.other.find((e) => e.name === 'Library');
    assert.ok(lib && lib.bytes >= 22 * MB);
    const names = a.other.map((e) => e.name);
    assert.ok(names.includes('.npm') && names.includes('Movies'), 'hidden folders are included');
    assert.ok(!names.includes('Documents') && !names.includes('Downloads'));
    const kids = await listChildren(ids.get(lib.id) as string, ids);
    assert.equal(kids[0].name, 'Caches');
    assert.ok(allowedDiskPath(ids.get(lib.id) as string, home));
    assert.ok(!allowedDiskPath('/etc', home));
    assert.ok(allowedDiskPath('/Applications/Foo.app', home));
    assert.ok(!allowedDiskPath(home + '/../other', home));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
