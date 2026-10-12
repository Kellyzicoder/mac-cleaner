import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findSourceFolder, isSourceFolder, parseCount, parseLog } from '../src/main/selfupdate';

test('git output is read', () => {
  assert.equal(parseCount('3\n'), 3);
  assert.equal(parseCount('oops'), 0);
  assert.deepEqual(parseLog('a623024 feat: apps tab\n1eec7cf fix: trash\n'), ['feat: apps tab', 'fix: trash']);
});

test('only the real source folder is accepted', async () => {
  const home = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'su-'));
  const good = path.join(home, 'Downloads', 'mac-cleaner');
  fs.mkdirSync(path.join(good, '.git'), { recursive: true });
  fs.writeFileSync(path.join(good, 'package.json'), JSON.stringify({ name: 'mac-purificator' }));
  const other = path.join(home, 'other');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'something-else' }));
  assert.equal(await isSourceFolder(good), true);
  assert.equal(await isSourceFolder(other), false);
  assert.equal(await findSourceFolder(home, null), good);
  assert.equal(await findSourceFolder(home, other), good);
});
