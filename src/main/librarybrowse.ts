import { promises as fs } from 'fs';
import * as path from 'path';
import type { LibBrowse, LibEntry, LibVerdict } from '../shared/types';
import { duBytes } from './diskmap';
import { protectedReason } from './safety';
import { bundleIdFor } from './apps';
import { findApps } from './unusedapps';

interface Know {
  what: string;
  verdict: LibVerdict;
  why: string;
}

const k = (verdict: LibVerdict, what: string, why: string): Know => ({ verdict, what, why });

/** General knowledge about folders inside ~/Library. Keys are paths under ~/Library. */
export const KNOWLEDGE: Record<string, Know> = {
  Keychains: k('never', 'Your saved passwords, Wi-Fi passwords and certificates.', 'Deleting it can lock you out of accounts and Wi-Fi. There is no way to rebuild it.'),
  Mail: k('never', 'Your email messages and attachments stored on this Mac.', 'Some mail may exist only here, especially older or "On My Mac" mail. Deleting it loses those emails.'),
  Messages: k('never', 'Your iMessage and SMS history and the pictures sent in them.', 'Deleting it loses your chat history for good unless you have a backup.'),
  'Mobile Documents': k('never', 'Your iCloud Drive files kept on this Mac.', 'Deleting files here also deletes them from iCloud and your other devices.'),
  Safari: k('never', 'Safari bookmarks, history, tabs and settings.', 'Deleting it wipes your bookmarks and reading list.'),
  Preferences: k('never', 'Settings for every app (small .plist files).', 'Deleting one resets that app. macOS also caches these, so changes made by hand can be undone by the system.'),
  'Group Containers': k('never', 'Data shared between apps from the same company (Notes, Reminders, Messages and more).', 'Deleting parts of it can break the apps and lose their data.'),
  Accounts: k('never', 'Your internet accounts (iCloud, Google, Exchange).', 'Deleting it signs you out of every account on this Mac.'),
  Calendars: k('never', 'Calendar data stored on this Mac.', 'Calendars that are not synced to the cloud would be lost.'),
  Reminders: k('never', 'Your reminders data.', 'Deleting it loses reminders that are not in iCloud.'),
  Biome: k('never', 'Part of macOS (usage data that Siri and Spotlight use).', 'It belongs to the system. macOS may block or rebuild it, and tampering can cause odd behaviour.'),
  IdentityServices: k('never', 'Part of macOS (Apple ID, iMessage and FaceTime identity).', 'Deleting it can break iMessage and FaceTime sign-in.'),
  Cookies: k('careful', 'Website login cookies used by Safari and some apps.', 'Safe to delete, but you will be signed out of websites and apps that use them.'),
  Containers: k('careful', 'Every sandboxed app keeps its own documents and settings in its own folder here (usually named after the app).', 'Safe only for apps you have already deleted. For an app you still use, deleting its folder wipes that app\'s data.'),
  'Application Support': k('careful', 'Data, databases, plug-ins and settings for apps.', 'Each folder belongs to one app. If the app is gone, the folder is leftover. If you still use the app, deleting it can lose your data or settings.'),
  Caches: k('safe', 'Speed-up files that apps can rebuild.', 'Safe to remove. Apps may start a little slower and rebuild them. Close the app first.'),
  Logs: k('safe', 'Diagnostic log files.', 'Safe to remove. They only help when something needs debugging.'),
  'Saved Application State': k('safe', 'Where each app\'s windows were when you last quit it.', 'Safe to remove. Apps just forget which windows were open.'),
  HTTPStorages: k('safe', 'Small network storage files kept by apps.', 'Safe to remove. Apps recreate them. You may be asked to sign in again in some apps.'),
  WebKit: k('careful', 'Website data (storage, cookies) kept by apps that show web pages.', 'Deleting it can sign you out of those apps.'),
  LaunchAgents: k('careful', 'Small background helpers that start when you log in.', 'A helper whose app is deleted is junk. For an app you still use, deleting it can stop its updater or sync.'),
  Fonts: k('careful', 'Fonts you installed.', 'Documents and designs that use them can show a wrong font if they are removed.'),
  Developer: k('careful', 'Xcode and developer tool files (simulators, device support, build results).', 'Most of it can be downloaded or rebuilt, but simulators and device files can be large and slow to get back.'),
  'Developer/Xcode': k('careful', 'Xcode build results, archives and device support.', 'Build results (DerivedData) are safe to remove. Archives hold app versions you shipped, so keep those.'),
  'Developer/Xcode/DerivedData': k('safe', 'Xcode build results.', 'Safe to remove. Xcode rebuilds them on the next build (the first build is slower).'),
  'Developer/CoreSimulator': k('careful', 'iPhone and iPad simulators and their apps.', 'You can remove old ones from Xcode (Window > Devices and Simulators), which is safer than deleting by hand.'),
  'Autosave Information': k('careful', 'Automatic saves of documents that apps keep in case of a crash.', 'If a document was never saved and the app crashed, this may be the only copy.'),
  Colors: k('careful', 'Colour palettes you saved.', 'Deleting loses your saved colours.'),
  ColorSync: k('careful', 'Colour profiles for your screen and printers.', 'Removing a profile can make colours look wrong in design apps.'),
  Keyboard: k('careful', 'Keyboard settings and custom layouts.', 'Deleting resets those settings.'),
  'Input Methods': k('careful', 'Typing methods (for other languages, for example).', 'Deleting one stops that input method working.'),
  'Internet Plug-Ins': k('careful', 'Old browser plug-ins.', 'Most are outdated. Check what each one is before removing it.'),
  PreferencePanes: k('careful', 'Extra panels installed in System Settings.', 'Removing one removes that setting panel and may break the app that added it.'),
  'Screen Savers': k('careful', 'Screen savers you installed.', 'Safe to remove if you do not use them.'),
  Services: k('careful', 'Right-click Services you added.', 'Removing one removes that menu item.'),
  Sounds: k('careful', 'Sounds you added.', 'Safe if you do not use them.'),
  Spelling: k('careful', 'Your custom dictionary words.', 'Deleting makes the Mac forget words you taught it.'),
  Metadata: k('never', 'Spotlight and system metadata.', 'macOS manages it. Deleting can break search until it is rebuilt.'),
  Assistants: k('never', 'Part of macOS (Siri and setup assistants).', 'It belongs to the system.'),
  Shortcuts: k('careful', 'Your Shortcuts automations.', 'Deleting loses shortcuts you made.'),
  'Application Scripts': k('careful', 'Scripts that sandboxed apps use.', 'Deleting can break extensions of those apps.'),
  'Application Support/MobileSync': k('careful', 'iPhone and iPad backups made from this Mac.', 'These are big. Delete one only if you no longer need to restore that device from it.'),
  'Application Support/MobileSync/Backup': k('careful', 'Backups of your iPhone or iPad.', 'If your phone breaks, this may be the only copy of your data. Check in Finder > your iPhone > Manage Backups before deleting.'),
  'Application Support/Google': k('careful', 'Google Chrome profile (bookmarks, history, saved logins, extensions).', 'Deleting it resets Chrome as if new. Sync can bring most things back only if you were signed in with sync on.'),
  'Application Support/Code': k('careful', 'Visual Studio Code settings, snippets and workspace state.', 'Deleting resets VS Code. Settings Sync can bring them back only if you turned it on.'),
  'Application Support/Adobe': k('careful', 'Adobe presets, plug-ins and recovery files.', 'AutoRecover and cache folders inside are safe to clear when the app is closed. Presets, brushes and plug-ins are things you may have added.'),
  'Application Support/Slack': k('careful', 'Slack cache and settings.', 'Mostly cache, safe when Slack is closed. You may have to sign in again.'),
  'Application Support/Knowledge': k('never', 'Part of macOS (Siri and Screen Time data).', 'It belongs to the system and cannot be rebuilt.'),
  'Application Support/com.apple.TCC': k('never', 'The list of which apps may use your camera, microphone, files and so on.', 'Deleting it resets every privacy permission. macOS also protects it.'),
  'Application Support/Dock': k('never', 'Part of macOS (your Dock layout).', 'It belongs to the system.'),
  'Application Support/CallHistoryDB': k('never', 'Part of macOS (call history).', 'Deleting it loses your call history.'),
  'Application Support/iCloud': k('never', 'Part of macOS (iCloud sync data).', 'Deleting it can cause sync problems and lost changes.'),
  'Application Support/FileProvider': k('never', 'Part of macOS (cloud drive sync data).', 'Deleting it can cause sync problems.'),
  'Application Support/AddressBook': k('never', 'Your Contacts.', 'Contacts not stored in iCloud would be lost.'),
  'Application Support/CloudDocs': k('never', 'Part of macOS (iCloud Drive sync).', 'Deleting it can cause lost files and sync trouble.'),
};

/** What to say about a folder inside a parent when I have no specific note. */
const BY_PARENT: Record<string, Know> = {
  Caches: KNOWLEDGE.Caches,
  Logs: KNOWLEDGE.Logs,
  'Saved Application State': KNOWLEDGE['Saved Application State'],
  HTTPStorages: KNOWLEDGE.HTTPStorages,
  Containers: k('careful', 'One app\'s own documents and settings.', 'Deleting it wipes that app\'s data. Safe only if the app is already deleted.'),
  'Application Support': k('careful', 'One app\'s data and settings.', 'If the app is gone this is leftover. If you still use the app, deleting it can lose data or settings.'),
  WebKit: k('careful', 'Website data for one app.', 'Deleting it signs you out of that app.'),
  LaunchAgents: k('careful', 'A background helper for an app.', 'Junk if the app is deleted. If you still use the app, it may stop updating or syncing.'),
  Preferences: k('never', 'Settings for one app.', 'Deleting it resets that app.'),
  Cookies: KNOWLEDGE.Cookies,
};

export function norm(s: string): string {
  return s.toLowerCase().replace(/\.(savedstate|plist|app)$/, '').replace(/[^a-z0-9]/g, '');
}

/** Does this folder or file name look like it belongs to an installed app? */
export function matchesInstalled(name: string, installedNames: Set<string>, installedIds: Set<string>): boolean {
  const lower = name.toLowerCase().replace(/\.(savedstate|plist)$/, '');
  if (installedIds.has(lower)) return true;
  for (const id of installedIds) if (lower.startsWith(id + '.') || id.startsWith(lower + '.')) return true;
  const n = norm(name);
  if (!n) return false;
  for (const a of installedNames) if (a === n || (n.length >= 4 && (a.includes(n) || n.includes(a)) && a.length >= 4)) return true;
  return false;
}

export interface Judged extends Know {
  orphan: boolean;
}

/** Decides what to tell the person about one item. `rel` is the path under ~/Library, like "Application Support/Slack". */
export function judge(rel: string, installedNames: Set<string>, installedIds: Set<string>): Judged {
  const exact = KNOWLEDGE[rel];
  const parts = rel.split('/');
  if (exact) return { ...exact, orphan: false };

  // A child of a known folder.
  const top = parts[0];
  const parentRel = parts.slice(0, -1).join('/');
  const name = parts[parts.length - 1];
  let base: Know | undefined = parts.length === 2 ? BY_PARENT[top] : undefined;
  if (!base && parentRel && KNOWLEDGE[parentRel]) base = KNOWLEDGE[parentRel];
  if (!base) {
    // deeper inside something that is "never" stays never; inside safe stays safe.
    for (let i = parts.length - 1; i >= 1; i--) {
      const kn = KNOWLEDGE[parts.slice(0, i).join('/')];
      if (kn && (kn.verdict === 'never' || kn.verdict === 'safe')) {
        base = kn;
        break;
      }
    }
  }
  base = base ?? k('careful', 'I do not know this one.', 'I have no note about it. Look inside, and search for the name before deleting.');

  // Apple's own folders belong to macOS.
  if (/^com\.apple\./i.test(name) && base.verdict !== 'safe') {
    return { what: 'Part of macOS.', verdict: 'never', why: 'Folders named com.apple.* belong to macOS or Apple apps. Deleting them can break features and cannot always be fixed.', orphan: false };
  }

  const appLike = ['Application Support', 'Containers', 'Caches', 'Logs', 'Saved Application State', 'HTTPStorages', 'WebKit', 'LaunchAgents', 'Cookies'].includes(top) && parts.length === 2;
  const orphan = appLike && !matchesInstalled(name, installedNames, installedIds);
  if (orphan && base.verdict === 'careful') {
    return {
      verdict: 'careful',
      what: base.what,
      why: `${base.why} I could not match "${name}" to an app that is installed now, so it may be a leftover from an app you deleted. It may also belong to a tool that is not a normal app. Search the name first.`,
      orphan: true,
    };
  }
  return { ...base, orphan };
}

let installedCache: { at: number; names: Set<string>; ids: Set<string> } | null = null;

async function installedApps(home: string): Promise<{ names: Set<string>; ids: Set<string> }> {
  if (installedCache && Date.now() - installedCache.at < 10 * 60_000) return installedCache;
  const apps = await findApps(['/Applications', '/System/Applications', path.join(home, 'Applications')]);
  const names = new Set(apps.map((a) => norm(path.basename(a))));
  const ids = new Set<string>();
  for (let i = 0; i < apps.length; i += 8) {
    const res = await Promise.all(apps.slice(i, i + 8).map((a) => bundleIdFor(a)));
    for (const r of res) if (r) ids.add(r.toLowerCase());
  }
  installedCache = { at: Date.now(), names, ids };
  return installedCache;
}

export function insideLibrary(p: string, home: string): boolean {
  const lib = path.join(home, 'Library');
  const r = path.resolve(p);
  return r === lib || r.startsWith(lib + path.sep);
}

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const mkId = (p: string) => `libfile:${p}`;

/** Lists one folder inside ~/Library with a verdict and reason for every item. */
export async function browseLibrary(home: string, dir: string, ids: Map<string, string>): Promise<LibBrowse> {
  const lib = path.join(home, 'Library');
  const here = path.resolve(dir);
  const crumbs: LibBrowse['crumbs'] = [{ id: mkId(lib), name: 'Library' }];
  ids.set(mkId(lib), lib);
  let acc = lib;
  for (const seg of path.relative(lib, here).split(path.sep).filter(Boolean)) {
    acc = path.join(acc, seg);
    ids.set(mkId(acc), acc);
    crumbs.push({ id: mkId(acc), name: seg });
  }

  let entries: import('fs').Dirent[] = [];
  try {
    entries = await fs.readdir(here, { withFileTypes: true });
  } catch {
    return { crumbs, entries: [], note: 'macOS did not let me look inside here. Give Mac Purificator Full Disk Access in System Settings > Privacy & Security to see more.' };
  }
  const { names, ids: bundleIds } = await installedApps(home);
  const real = entries.filter((e) => !e.isSymbolicLink() && e.name !== '.DS_Store' && e.name !== '.localized');
  const sized = await pool(real, 4, async (e) => {
    const full = path.join(here, e.name);
    return { e, full, bytes: await duBytes(full) };
  });
  const out: LibEntry[] = sized.map(({ e, full, bytes }) => {
    const rel = path.relative(lib, full).split(path.sep).join('/');
    const j = judge(rel, names, bundleIds);
    const prot = protectedReason(full, home);
    const isMainFolder = prot !== null && prot.startsWith('It is a main folder');
    // A main folder itself cannot be picked, but what is inside it can. Anything else that is protected is off limits.
    const verdict: LibVerdict = prot && !isMainFolder && j.verdict !== 'never' ? 'never' : j.verdict;
    const why = isMainFolder
      ? `${j.why} The folder itself cannot be picked. Open it and pick items inside.`
      : prot && j.verdict !== 'never' ? `${j.why} Mac Purificator also blocks this one: ${prot}` : j.why;
    const id = mkId(full);
    ids.set(id, full);
    return { id, name: e.name, bytes, isDir: e.isDirectory(), verdict, what: j.what, why, canTrash: verdict !== 'never' && !prot, orphan: j.orphan };
  });
  out.sort((a, b) => b.bytes - a.bytes);
  return { crumbs, entries: out.slice(0, 200) };
}
