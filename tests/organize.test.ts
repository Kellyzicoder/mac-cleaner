import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyTidy, planTidy, rootProblem, undoTidy } from '../src/main/organize';

const NOW = Date.now();
const OLD = new Date(NOW - 5 * 86_400_000);

function makeHome(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'cleaner-tidy-')));
}
function file(dir: string, name: string, old = true): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  if (old) fs.utimesSync(p, OLD, OLD);
  return p;
}

test('plans folders by project and by kind, leaves the rest alone', async () => {
  const home = makeHome();
  try {
    const dl = path.join(home, 'Downloads');
    for (const n of ['HNU report.pdf', 'HNU wireframes.png', 'hnu-notes.docx']) file(dl, n);
    for (const n of ['a.pdf', 'b.pdf', 'c.pdf']) file(dl, n);
    for (const n of ['Screenshot 1.png', 'Screenshot 2.png', 'Screenshot 3.png']) file(dl, n);
    file(dl, 'lonely.mp4');
    file(dl, 'half.zip.crdownload');
    file(dl, 'fresh1.pdf', false);
    file(dl, '.hidden.pdf');
    file(dl, 'x.pdf'); // two more pdfs would not reach 3 without a.pdf..; here pdf count = 4
    fs.mkdirSync(path.join(dl, 'My Folder'));

    const plan = await planTidy([dl], home, NOW);
    const names = plan.groups.map((g) => g.folderName);
    assert.ok(names.includes('HNU - project files'));
    assert.ok(names.some((n) => n.startsWith('Screenshots and Screen Recordings - ')));
    assert.ok(names.includes('PDF Documents'));
    const pdf = plan.groups.find((g) => g.folderName === 'PDF Documents');
    assert.deepEqual(pdf?.files.map((f) => f.name), ['a.pdf', 'b.pdf', 'c.pdf', 'x.pdf']);
    assert.ok(!plan.groups.some((g) => g.files.some((f) => f.name === 'lonely.mp4')));
    assert.ok(!plan.groups.some((g) => g.files.some((f) => /crdownload|fresh1|hidden/.test(f.name))));
    assert.ok(plan.leftAlone >= 3);
    assert.match(plan.groups[0].description, /./);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('moves files, writes a note, never overwrites, and undo puts everything back', async () => {
  const home = makeHome();
  try {
    const dl = path.join(home, 'Downloads');
    for (const n of ['a.pdf', 'b.pdf', 'c.pdf']) file(dl, n);
    const plan = await planTidy([dl], home, NOW);
    assert.equal(plan.groups.length, 1);
    // a file with the same name is already in the target folder
    const dest = path.join(dl, 'PDF Documents');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'a.pdf'), 'OLD');
    const { result, log } = await applyTidy([plan.groups[0].id, 'bad-id'], home, NOW);
    assert.equal(result.movedFiles, 3);
    assert.equal(result.failed.length, 1, 'unknown id is refused');
    assert.equal(fs.readFileSync(path.join(dest, 'a.pdf'), 'utf8'), 'OLD', 'nothing overwritten');
    assert.ok(fs.existsSync(path.join(dest, 'a (2).pdf')));
    assert.ok(!fs.existsSync(path.join(dl, 'b.pdf')));
    assert.equal(fs.existsSync(path.join(dest, '_About this folder.txt')), false, 'no note in a folder that was already there');

    const undo = await undoTidy(log);
    assert.equal(undo.restored, 3);
    assert.ok(fs.existsSync(path.join(dl, 'a (2).pdf')) === false);
    assert.ok(fs.existsSync(path.join(dl, 'b.pdf')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a new folder gets an About note and undo removes the empty folder', async () => {
  const home = makeHome();
  try {
    const dl = path.join(home, 'Desktop');
    for (const n of ['a.mp3', 'b.mp3', 'c.mp3']) file(dl, n);
    const plan = await planTidy([dl], home, NOW);
    const { result, log } = await applyTidy([plan.groups[0].id], home, NOW);
    const dest = path.join(dl, 'Music and Audio');
    assert.equal(result.madeFolders, 1);
    const note = fs.readFileSync(path.join(dest, '_About this folder.txt'), 'utf8');
    assert.match(note, /What is here: Music, voice notes/);
    assert.match(note, /- a\.mp3/);
    await undoTidy(log);
    assert.equal(fs.existsSync(dest), false);
    assert.ok(fs.existsSync(path.join(dl, 'c.mp3')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('folders that must not be tidied are refused', async () => {
  const home = makeHome();
  try {
    const proj = path.join(home, 'Documents', 'site');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'package.json'), '{}');
    assert.match((await rootProblem(proj, home)) ?? '', /code project/);
    fs.mkdirSync(path.join(home, 'Library', 'x'), { recursive: true });
    assert.ok(await rootProblem(path.join(home, 'Library', 'x'), home));
    assert.ok(await rootProblem(home, home));
    assert.ok(await rootProblem('/etc', home));
    fs.mkdirSync(path.join(home, '.hidden'));
    assert.ok(await rootProblem(path.join(home, '.hidden'), home));
    assert.equal(await rootProblem(path.join(home, 'Documents'), home), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
