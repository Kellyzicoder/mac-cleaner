import { promises as fs } from 'fs';
import * as path from 'path';
import { TidyGroup, TidyPlan, TidyResult } from '../shared/types';
import { humanSize } from './fsutil';

const MIN_FILES = 3;
const FRESH_MS = 10 * 60 * 1000;
const ABOUT = '_About this folder.txt';
const ABOUT_MARK = 'Made by Mac Purificator';
/** Notes made before the rename start with the old name. */
const ABOUT_MARK_OLD = 'Made by Mac Cleaner';

interface Kind {
  key: string;
  folder: string;
  label: string;
  exts: string[];
  description: string;
}

const KINDS: Kind[] = [
  { key: 'pictures', folder: 'Photos and Pictures', label: 'picture', exts: ['jpg', 'jpeg', 'png', 'gif', 'heic', 'webp', 'tif', 'tiff', 'bmp', 'svg', 'raw', 'cr2', 'nef'], description: 'Photos and pictures (JPG, PNG, HEIC and similar).' },
  { key: 'design', folder: 'Design Files (Photoshop, Illustrator, Figma)', label: 'design file', exts: ['psd', 'ai', 'fig', 'sketch', 'xd', 'indd', 'afdesign', 'afphoto'], description: 'Files you open in design apps such as Photoshop, Illustrator, Figma or Sketch.' },
  { key: 'pdf', folder: 'PDF Documents', label: 'PDF', exts: ['pdf'], description: 'PDF documents.' },
  { key: 'docs', folder: 'Written Documents (Word, Pages, Text)', label: 'written document', exts: ['doc', 'docx', 'pages', 'txt', 'rtf', 'md', 'odt'], description: 'Written documents: Word, Pages, plain text and Markdown files.' },
  { key: 'sheets', folder: 'Spreadsheets and Data Tables', label: 'spreadsheet', exts: ['xls', 'xlsx', 'csv', 'numbers', 'ods', 'tsv'], description: 'Spreadsheets and data tables (Excel, Numbers, CSV).' },
  { key: 'slides', folder: 'Presentations and Slides', label: 'presentation', exts: ['ppt', 'pptx', 'key', 'odp'], description: 'Presentations (PowerPoint, Keynote).' },
  { key: 'video', folder: 'Videos', label: 'video', exts: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'], description: 'Video files.' },
  { key: 'audio', folder: 'Music and Audio', label: 'audio file', exts: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'aiff', 'ogg'], description: 'Music, voice notes and other sound files.' },
  { key: 'archives', folder: 'Zip and Archive Files', label: 'archive', exts: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2'], description: 'Zip files and other compressed archives. Open one to see what is inside.' },
  { key: 'installers', folder: 'App Installers (dmg, pkg)', label: 'installer', exts: ['dmg', 'pkg', 'iso', 'xip'], description: 'Installers for Mac apps. Most can be deleted once the app is installed.' },
  { key: 'code', folder: 'Code and Config Files', label: 'code file', exts: ['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'json', 'html', 'css', 'sh', 'ipynb', 'sql', 'yml', 'yaml'], description: 'Code, web pages and settings files.' },
  { key: 'books', folder: 'Books (ePub)', label: 'book', exts: ['epub', 'mobi'], description: 'E-books.' },
  { key: 'fonts', folder: 'Fonts', label: 'font', exts: ['ttf', 'otf', 'woff', 'woff2'], description: 'Font files.' },
];

const EXT_TO_KIND = new Map<string, Kind>();
for (const k of KINDS) for (const e of k.exts) EXT_TO_KIND.set(e, k);

/** Files that are still being downloaded or are scratch files. Never moved. */
const SKIP_EXT = new Set(['crdownload', 'download', 'part', 'partial', 'tmp', 'icloud', 'opdownload']);

/** Words that start many file names but do not name a project. */
const GENERIC = new Set([
  'copy', 'final', 'new', 'untitled', 'image', 'img', 'document', 'doc', 'scan', 'file', 'photo', 'screenshot', 'screen',
  'whatsapp', 'download', 'draft', 'the', 'and', 'for', 'with', 'from', 'pdf', 'video', 'audio', 'recording', 'invoice',
  'receipt', 'page', 'pages', 'sheet', 'slide', 'slides', 'test', 'temp', 'export', 'output', 'data', 'backup', 'version',
  'resume', 'cv', 'letter', 'form', 'report', 'notes', 'note', 'picture', 'pic', 'pxl', 'dsc', 'mov', 'vid', 'jpeg', 'jpg', 'png',
]);

interface Candidate {
  name: string;
  full: string;
  bytes: number;
  mtime: number;
  kind: Kind;
  isScreenshot: boolean;
}

interface Planned extends TidyGroup {
  /** Full paths of the files in `files`, same order. */
  fullPaths: string[];
  createdBy: string;
}

function month(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function projectKey(name: string): string | null {
  const base = name.replace(/\.[^.]+$/, '');
  const token = base.split(/[\s\-_.()[\]]+/)[0] ?? '';
  if (!/^[A-Za-z]{3,}$/.test(token)) return null;
  if (GENERIC.has(token.toLowerCase())) return null;
  return token;
}

function plural(n: number, one: string): string {
  if (n === 1) return `1 ${one}`;
  return `${n} ${one}${/(h|s)$/.test(one) ? 'es' : 's'}`;
}

/** A folder that looks like a code project must not be tidied: moving files would break it. */
const PROJECT_MARKERS = ['.git', 'package.json', 'Package.swift', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'pom.xml', 'build.gradle', 'Podfile', 'Gemfile', 'requirements.txt'];

/** Returns why a folder cannot be tidied, or null when it is fine. */
export async function rootProblem(dir: string, home: string): Promise<string | null> {
  let real: string;
  try {
    real = await fs.realpath(dir);
  } catch {
    return 'It does not exist.';
  }
  const rel = path.relative(home, real);
  const inHome = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  const onDrive = /^\/Volumes\/[^/]+\/.+/.test(real);
  if (!inHome && !onDrive) return 'I only tidy folders inside your home folder or on a plugged-in drive.';
  if (inHome) {
    const parts = rel.split(path.sep);
    if (parts[0] === 'Library') return 'The Library folder belongs to macOS and your apps.';
    if (parts.some((p) => p.startsWith('.'))) return 'It is a hidden folder.';
    if (parts.length === 1 && ['Applications', 'Pictures', 'Music', 'Movies', 'Public'].includes(parts[0]))
      return 'Apps like Photos and Music manage this folder themselves.';
  }
  if (/\.(app|photoslibrary|musiclibrary|tvlibrary|xcodeproj|framework|bundle)(\/|$)/.test(real)) return 'It is inside an app or a library.';
  if (real.split(path.sep).includes('node_modules')) return 'It is inside node_modules.';
  for (const m of PROJECT_MARKERS) {
    try {
      await fs.lstat(path.join(real, m));
      return 'It looks like a code project. Moving files out would break it.';
    } catch {
      /* not there */
    }
  }
  return null;
}

async function listCandidates(dir: string, now: number): Promise<{ list: Candidate[]; skipped: number }> {
  const list: Candidate[] = [];
  let skipped = 0;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { list, skipped };
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === ABOUT) continue; // hidden and our own note
    if (!e.isFile()) {
      continue; // folders, links and apps are never touched, and not counted as files
    }
    const full = path.join(dir, e.name);
    let st;
    try {
      st = await fs.lstat(full);
    } catch {
      continue;
    }
    const ext = path.extname(e.name).slice(1).toLowerCase();
    const kind = EXT_TO_KIND.get(ext);
    if (!kind || SKIP_EXT.has(ext) || now - st.mtimeMs < FRESH_MS) {
      skipped++;
      continue;
    }
    list.push({
      name: e.name,
      full,
      bytes: st.size,
      mtime: st.mtimeMs,
      kind,
      isScreenshot: /^(Screenshot|Screen Shot|Screen Recording) /i.test(e.name),
    });
  }
  return { list, skipped };
}

function kindSummary(files: Candidate[]): string {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(f.kind.label, (counts.get(f.kind.label) ?? 0) + 1);
  return [...counts.entries()].map(([label, n]) => plural(n, label)).join(', ');
}

function groupDir(dir: string, files: Candidate[], idPrefix: string, now: number, existingNames: Set<string>): Planned[] {
  const out: Planned[] = [];
  const left = new Set(files);
  const make = (folderName: string, members: Candidate[], description: string, why: string, tag: string): void => {
    const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name));
    out.push({
      id: `${idPrefix}|${tag}`,
      folderName,
      sourceDir: dir,
      description,
      why,
      files: sorted.map((f) => ({ name: f.name, bytes: f.bytes })),
      fullPaths: sorted.map((f) => f.full),
      totalBytes: sorted.reduce((s, f) => s + f.bytes, 0),
      folderExists: existingNames.has(folderName),
      createdBy: 'tidy',
    });
    for (const f of members) left.delete(f);
  };

  // 1. Screenshots, one folder per month.
  const shots = new Map<string, Candidate[]>();
  for (const f of files) if (f.isScreenshot) shots.set(month(f.mtime), [...(shots.get(month(f.mtime)) ?? []), f]);
  for (const [m, list] of shots) {
    if (list.length < MIN_FILES) continue;
    make(
      `Screenshots and Screen Recordings - ${m}`,
      list,
      `Screenshots and screen recordings taken in ${m}.`,
      'Their names start with “Screenshot” or “Screen Recording”, so they were grouped by month.',
      `shots-${m}`,
    );
  }

  // 2. Projects: files that start with the same word.
  const byKey = new Map<string, Candidate[]>();
  for (const f of files) {
    if (!left.has(f)) continue;
    const key = projectKey(f.name);
    if (!key) continue;
    const k = key.toLowerCase();
    byKey.set(k, [...(byKey.get(k) ?? []), f]);
  }
  for (const [k, list] of byKey) {
    if (list.length < MIN_FILES) continue;
    const shown = projectKey(list[0].name) ?? k;
    make(
      `${shown} - project files`,
      list,
      `Files that all start with “${shown}”: ${kindSummary(list)}.`,
      `${list.length} files start with the same word, so they probably belong to the same piece of work. Check this before you accept it.`,
      `project-${k}`,
    );
  }

  // 3. The rest, by kind.
  const byKind = new Map<string, Candidate[]>();
  for (const f of left) byKind.set(f.kind.key, [...(byKind.get(f.kind.key) ?? []), f]);
  for (const [key, list] of byKind) {
    if (list.length < MIN_FILES) continue;
    const kind = KINDS.find((x) => x.key === key) as Kind;
    make(kind.folder, list, kind.description, `${list.length} loose files of the same kind (.${[...new Set(list.map((f) => path.extname(f.name).slice(1).toLowerCase()))].join(', .')}).`, `kind-${key}`);
  }
  void now;
  return out;
}

let lastPlan = new Map<string, Planned>();

export async function planTidy(roots: string[], home: string, now: number = Date.now()): Promise<TidyPlan> {
  const groups: Planned[] = [];
  const notes: string[] = [];
  const used: string[] = [];
  let leftAlone = 0;
  for (const dir of roots) {
    const problem = await rootProblem(dir, home);
    if (problem) {
      if (!/does not exist/.test(problem)) notes.push(`Skipped ${dir}. ${problem}`);
      continue;
    }
    used.push(dir);
    const { list, skipped } = await listCandidates(dir, now);
    let existing = new Set<string>();
    try {
      existing = new Set((await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name));
    } catch {
      /* ignore */
    }
    const planned = groupDir(dir, list, dir, now, existing);
    const inGroups = planned.reduce((n, g) => n + g.files.length, 0);
    leftAlone += skipped + (list.length - inGroups);
    groups.push(...planned);
  }
  lastPlan = new Map(groups.map((g) => [g.id, g]));
  groups.sort((a, b) => b.totalBytes - a.totalBytes);
  return {
    groups: groups.map(({ fullPaths: _f, createdBy: _c, ...g }) => g),
    roots: used,
    leftAlone,
    notes,
  };
}

export interface MoveLog {
  from: string;
  to: string;
  /** Folder we made for this move (so undo can remove it if it is empty again). */
  madeFolder?: string;
}

function aboutText(g: Planned, movedNames: string[], now: number): string {
  const d = new Date(now).toISOString().slice(0, 10);
  const lines = [
    ABOUT_MARK + ' on ' + d + '.',
    '',
    `Folder: ${g.folderName}`,
    `What is here: ${g.description}`,
    `Why these files are together: ${g.why}`,
    `Total size: ${humanSize(g.totalBytes)}`,
    '',
    `Files moved here (${movedNames.length}):`,
    ...movedNames.slice(0, 60).map((n) => `- ${n}`),
  ];
  if (movedNames.length > 60) lines.push(`- ...and ${movedNames.length - 60} more`);
  lines.push('', 'You can move files out or rename this folder any time. Nothing here was deleted.');
  return lines.join('\n') + '\n';
}

async function uniqueTarget(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  let n = 2;
  for (;;) {
    try {
      await fs.lstat(candidate);
    } catch {
      return candidate;
    }
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n++;
  }
}

/** Moves the files of the chosen groups. Only ids from the last plan are accepted. Nothing is overwritten or deleted. */
export async function applyTidy(ids: string[], home: string, now: number = Date.now()): Promise<{ result: TidyResult; log: MoveLog[] }> {
  const result: TidyResult = { movedFiles: 0, madeFolders: 0, failed: [] };
  const log: MoveLog[] = [];
  for (const id of ids) {
    const g = lastPlan.get(id);
    if (!g) {
      result.failed.push({ file: id, reason: 'This group is not in the last scan. Scan again.' });
      continue;
    }
    const problem = await rootProblem(g.sourceDir, home);
    if (problem) {
      result.failed.push({ file: g.folderName, reason: problem });
      continue;
    }
    const destDir = path.join(g.sourceDir, g.folderName);
    let made = false;
    try {
      await fs.mkdir(destDir);
      made = true;
    } catch (e) {
      const st = await fs.lstat(destDir).catch(() => null);
      if (!st || !st.isDirectory()) {
        result.failed.push({ file: g.folderName, reason: 'Could not make the folder.' });
        continue;
      }
      void e;
    }
    const movedNames: string[] = [];
    let first = true;
    for (let i = 0; i < g.fullPaths.length; i++) {
      const from = g.fullPaths[i];
      const st = await fs.lstat(from).catch(() => null);
      if (!st || !st.isFile()) {
        result.failed.push({ file: g.files[i].name, reason: 'It moved or changed since the scan.' });
        continue;
      }
      if (path.dirname(from) !== g.sourceDir) continue;
      const to = await uniqueTarget(destDir, path.basename(from));
      try {
        await fs.rename(from, to);
        movedNames.push(path.basename(to));
        log.push({ from, to, madeFolder: made && first ? destDir : undefined });
        first = false;
        result.movedFiles++;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        result.failed.push({ file: g.files[i].name, reason: code === 'EXDEV' ? 'It is on a different drive.' : `Could not move it (${code ?? 'error'}).` });
      }
    }
    if (movedNames.length > 0) {
      if (made) {
        result.madeFolders++;
        try {
          await fs.writeFile(path.join(destDir, ABOUT), aboutText(g, movedNames, now), { flag: 'wx' });
        } catch {
          /* no note, files still moved */
        }
      }
    } else if (made) {
      await fs.rmdir(destDir).catch(() => undefined); // nothing moved: remove the empty folder we just made
    }
  }
  return { result, log };
}

/** Puts files back where they were. Removes folders we made if they are empty again. */
export async function undoTidy(log: MoveLog[]): Promise<{ restored: number; failed: number }> {
  let restored = 0;
  let failed = 0;
  const dirs = new Set<string>();
  for (const m of [...log].reverse()) {
    const toStat = await fs.lstat(m.to).catch(() => null);
    const fromStat = await fs.lstat(m.from).catch(() => null);
    if (!toStat || fromStat) {
      failed++;
      continue;
    }
    try {
      await fs.rename(m.to, m.from);
      restored++;
      if (m.madeFolder) dirs.add(m.madeFolder);
    } catch {
      failed++;
    }
  }
  for (const dir of dirs) {
    try {
      const left = (await fs.readdir(dir)).filter((n) => n !== ABOUT);
      if (left.length > 0) continue;
      const note = path.join(dir, ABOUT);
      const text = await fs.readFile(note, 'utf8').catch(() => '');
      if (text.startsWith(ABOUT_MARK) || text.startsWith(ABOUT_MARK_OLD)) await fs.unlink(note); // only our own note
      await fs.rmdir(dir);
    } catch {
      /* leave it */
    }
  }
  return { restored, failed };
}
