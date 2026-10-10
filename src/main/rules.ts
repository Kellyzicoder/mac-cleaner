import { promises as fs } from 'fs';
import * as path from 'path';
import { RawFinding, Safety } from '../shared/types';
import { DAY, MB, measure, lstatSafe, humanSize } from './fsutil';

export interface Rule {
  id: string;
  category: string;
  title: string;
  /** Path under the home folder. */
  rel: string;
  /**
   * self: the folder itself is the junk.
   * contents: everything inside is junk (the folder stays).
   * children: each item inside is looked at on its own (big ones shown separately).
   */
  mode: 'self' | 'contents' | 'children';
  safety: Safety;
  whyJunk: string;
  whyKeep: string;
  afterRemoval: string;
  /** Only count items not changed for this many days. */
  olderThanDays?: number;
  /** children mode: items bigger than this get their own row; the rest are grouped. */
  minBytes?: number;
  /** children mode: change safety or the "keep" reason for a particular child. */
  classify?: (childName: string) => { safety?: Safety; whyKeep?: string } | undefined;
}

const CLAUDE = 'Claude leftovers';
const CACHES = 'App caches and logs';
const DEV = 'Developer tools';
const XCODE = 'Xcode';
const BACKUPS = 'Backups and mail';
const HIDDEN = 'Hidden folders';

const electronCache = (name: string, why: string): Rule => ({
  id: `claude-desktop-${name.toLowerCase().replace(/\s+/g, '-')}`,
  category: CLAUDE,
  title: `Claude app: ${name}`,
  rel: `Library/Application Support/Claude/${name}`,
  mode: 'self',
  safety: 'safe',
  whyJunk: why,
  whyKeep: 'If the Claude app is open right now, it may be using it. Quit Claude first for the best result.',
  afterRemoval: 'The Claude app rebuilds it automatically. The first start after cleaning may be a little slower.',
});

export const RULES: Rule[] = [
  // ---------- Claude Code (the terminal tool) ----------
  {
    id: 'claude-code-debug', category: CLAUDE, title: 'Claude Code debug logs (older than 7 days)',
    rel: '.claude/debug', mode: 'contents', safety: 'safe', olderThanDays: 7,
    whyJunk: 'Debug logs Claude Code writes while it runs. They are only useful when you are chasing a bug, and old ones almost never are.',
    whyKeep: 'If you are reporting a Claude Code bug, a recent log can help. Only logs older than 7 days are included here.',
    afterRemoval: 'New logs are written the next time you use Claude Code.',
  },
  {
    id: 'claude-code-shell-snapshots', category: CLAUDE, title: 'Claude Code shell snapshots (older than 7 days)',
    rel: '.claude/shell-snapshots', mode: 'contents', safety: 'safe', olderThanDays: 7,
    whyJunk: 'Copies of your terminal setup that Claude Code saves per session so its commands behave like your own Terminal.',
    whyKeep: 'Only a session that is still open would need its snapshot. Ones older than 7 days belong to finished sessions.',
    afterRemoval: 'A fresh snapshot is made at the start of the next session.',
  },
  {
    id: 'claude-code-statsig', category: CLAUDE, title: 'Claude Code cached settings and usage data',
    rel: '.claude/statsig', mode: 'contents', safety: 'safe',
    whyJunk: 'Cached feature settings and usage-tracking data. Nothing you wrote lives here.',
    whyKeep: 'None that I know of. It is a cache.',
    afterRemoval: 'Claude Code downloads it again.',
  },
  {
    id: 'claude-code-todos', category: CLAUDE, title: 'Claude Code old task lists (older than 30 days)',
    rel: '.claude/todos', mode: 'contents', safety: 'safe', olderThanDays: 30,
    whyJunk: 'Small task lists that Claude Code kept for sessions that finished a month or more ago.',
    whyKeep: 'If you wanted to look back at what a very old session planned, this is where that lives.',
    afterRemoval: 'Nothing breaks. Those old lists are simply gone.',
  },
  {
    id: 'claude-cli-nodejs', category: CLAUDE, title: 'Claude Code error and tool logs (older than 14 days)',
    rel: 'Library/Caches/claude-cli-nodejs', mode: 'contents', safety: 'safe', olderThanDays: 14,
    whyJunk: 'Logs and cache files from Claude Code and the tool servers it talks to.',
    whyKeep: 'Useful only if a tool server is failing and you are debugging it. Recent logs (under 14 days) are left alone.',
    afterRemoval: 'New logs are written when needed.',
  },
  {
    id: 'claude-code-projects', category: CLAUDE, title: 'Claude Code chat history (untouched for 30+ days)',
    rel: '.claude/projects', mode: 'children', safety: 'ask', olderThanDays: 30, minBytes: 5 * MB,
    whyJunk: 'The full text of past Claude Code sessions, one folder per project. It can grow to many GB over time.',
    whyKeep: 'This is your history. It is what lets you resume or look back at an old session. Once removed from Trash, it cannot be recovered. I cannot tell which projects you still care about, so you decide.',
    afterRemoval: 'Those old sessions can no longer be resumed or searched.',
  },
  {
    id: 'claude-desktop-logs', category: CLAUDE, title: 'Claude app logs (older than 7 days)',
    rel: 'Library/Logs/Claude', mode: 'contents', safety: 'safe', olderThanDays: 7,
    whyJunk: 'Log files the Claude desktop app writes while it runs.',
    whyKeep: 'Only useful if you are troubleshooting the app. Logs from the last 7 days are left alone.',
    afterRemoval: 'New logs are written when you use the app.',
  },
  electronCache('Cache', 'Web cache the Claude desktop app uses to load faster. It is a copy of data that can be downloaded again.'),
  electronCache('Code Cache', 'Pre-compiled code that helps the Claude app start faster. It is rebuilt on demand.'),
  electronCache('GPUCache', 'Graphics cache for the Claude app window. It is rebuilt on demand.'),
  {
    id: 'claude-desktop-system-cache', category: CLAUDE, title: 'Claude app system cache',
    rel: 'Library/Caches/com.anthropic.claudefordesktop', mode: 'self', safety: 'safe',
    whyJunk: 'Cache that macOS keeps for the Claude desktop app.',
    whyKeep: 'If the app is open it may be using it. Quit Claude first.',
    afterRemoval: 'Rebuilt automatically.',
  },
  {
    id: 'claude-desktop-vm-bundles', category: CLAUDE, title: 'Claude app sandbox files (large)',
    rel: 'Library/Application Support/Claude/vm_bundles', mode: 'self', safety: 'ask',
    whyJunk: 'Large files that the Claude app seems to keep for a sandboxed environment where it can run code on your Mac. They can take several GB.',
    whyKeep: 'I am not fully sure which of these are still in use. If you use features that run code in that sandbox, the app has to download them again, which can be several GB.',
    afterRemoval: 'The app downloads what it needs again the next time you use those features.',
  },

  // ---------- General app caches and logs ----------
  {
    id: 'library-caches', category: CACHES, title: 'App cache',
    rel: 'Library/Caches', mode: 'children', safety: 'safe', minBytes: 50 * MB,
    whyJunk: 'Apps keep copies of things they downloaded or calculated so they open faster. They can all be rebuilt.',
    whyKeep: 'The first time you open that app after cleaning, it may be slower or need to download things again. Offline use may be limited until it does.',
    afterRemoval: 'The app rebuilds its cache by itself.',
    classify: (name) =>
      name.startsWith('com.apple.')
        ? { safety: 'ask', whyKeep: 'This belongs to macOS or an Apple app. Parts of the system may use it, and I am not sure it is safe to remove. Restarting your Mac usually rebuilds it.' }
        : undefined,
  },
  {
    id: 'library-logs', category: CACHES, title: 'Old logs (older than 30 days)',
    rel: 'Library/Logs', mode: 'contents', safety: 'safe', olderThanDays: 30,
    whyJunk: 'Log files that apps and macOS wrote a month or more ago.',
    whyKeep: 'Old crash reports can help if you are tracking down a problem that keeps coming back.',
    afterRemoval: 'New logs are written as needed.',
  },
  {
    id: 'vscode-cached-data', category: CACHES, title: 'VS Code cached data',
    rel: 'Library/Application Support/Code/CachedData', mode: 'self', safety: 'safe',
    whyJunk: 'Compiled code VS Code keeps so it starts faster.',
    whyKeep: 'None. It is rebuilt on the next start. Quit VS Code first.',
    afterRemoval: 'Rebuilt on the next start.',
  },
  {
    id: 'vscode-vsix-cache', category: CACHES, title: 'VS Code downloaded extension packages',
    rel: 'Library/Application Support/Code/CachedExtensionVSIXs', mode: 'self', safety: 'safe',
    whyJunk: 'Copies of extension installers VS Code downloaded. The installed extensions live somewhere else.',
    whyKeep: 'You would need internet to reinstall an extension from them.',
    afterRemoval: 'Your installed extensions keep working.',
  },
  {
    id: 'mail-downloads', category: BACKUPS, title: 'Mail attachments you opened (older than 30 days)',
    rel: 'Library/Containers/com.apple.mail/Data/Library/Mail Downloads', mode: 'contents', safety: 'ask', olderThanDays: 30,
    whyJunk: 'Copies of email attachments that Mail saved when you opened them. The originals stay in your email.',
    whyKeep: 'If you edited one of these copies and never saved it somewhere else, the edits would be lost.',
    afterRemoval: 'The original attachments are still in your emails.',
  },
  {
    id: 'iphone-backups', category: BACKUPS, title: 'iPhone / iPad backup',
    rel: 'Library/Application Support/MobileSync/Backup', mode: 'children', safety: 'ask', minBytes: 1 * MB,
    whyJunk: 'Full backups of an iPhone or iPad made through your Mac. Old or duplicate ones can be many GB.',
    whyKeep: 'This may be the only backup of that device. If the phone is lost or broken, you cannot restore from it.',
    afterRemoval: 'The backup is gone. You can make a new one by plugging the device in.',
  },

  // ---------- Xcode ----------
  {
    id: 'xcode-derived-data', category: XCODE, title: 'Xcode build files (DerivedData)',
    rel: 'Library/Developer/Xcode/DerivedData', mode: 'self', safety: 'safe',
    whyJunk: 'Temporary build results and indexes. Xcode makes them again from your source code.',
    whyKeep: 'Your next build of each project will be slower. Quit Xcode first.',
    afterRemoval: 'Xcode rebuilds it.',
  },
  {
    id: 'xcode-simulator-caches', category: XCODE, title: 'Simulator caches',
    rel: 'Library/Developer/CoreSimulator/Caches', mode: 'self', safety: 'safe',
    whyJunk: 'Caches used by the iOS Simulator.',
    whyKeep: 'The Simulator may boot slower once.',
    afterRemoval: 'Rebuilt automatically.',
  },
  {
    id: 'xcode-archives', category: XCODE, title: 'Xcode app archives',
    rel: 'Library/Developer/Xcode/Archives', mode: 'self', safety: 'ask',
    whyJunk: 'Old builds you archived for release. They can be large.',
    whyKeep: 'Apps you shipped need their archive to read crash reports properly. If it is a version that is live in the App Store, keep it.',
    afterRemoval: 'You would have to rebuild that exact version from source.',
  },
  {
    id: 'xcode-device-support', category: XCODE, title: 'Xcode iOS device support files',
    rel: 'Library/Developer/Xcode/iOS DeviceSupport', mode: 'self', safety: 'ask',
    whyJunk: 'Files Xcode copied from each iPhone version you plugged in so it can debug it. They add up fast.',
    whyKeep: 'If you still debug on a device with one of those iOS versions, Xcode has to copy the files again (this takes a few minutes).',
    afterRemoval: 'Re-copied the next time you connect that device.',
  },

  // ---------- Developer package caches ----------
  {
    id: 'npm-cache', category: DEV, title: 'npm download cache',
    rel: '.npm/_cacache', mode: 'self', safety: 'safe',
    whyJunk: 'Copies of packages npm downloaded before. npm can download them again.',
    whyKeep: 'Without it, installs are slower and need internet.',
    afterRemoval: 'Rebuilt as you install packages.',
  },
  {
    id: 'pnpm-store', category: DEV, title: 'pnpm package store',
    rel: 'Library/pnpm/store', mode: 'self', safety: 'ask',
    whyJunk: 'One shared store of every package your pnpm projects used.',
    whyKeep: 'Your projects share it. Removing it can leave projects needing a full re-download on the next install, and offline installs stop working.',
    afterRemoval: 'Re-downloaded on the next install.',
  },
  {
    id: 'dot-cache', category: DEV, title: 'Tool cache in ~/.cache',
    rel: '.cache', mode: 'children', safety: 'ask', minBytes: 100 * MB,
    whyJunk: 'Caches from command-line tools (for example Python packages, or downloaded AI models).',
    whyKeep: 'Some of these are big downloads that take a long time to get again, like AI model files. I cannot tell which tool this belongs to, so you decide.',
    afterRemoval: 'Tools download it again when needed. Large model files can take a long time.',
  },
  {
    id: 'gradle-cache', category: DEV, title: 'Gradle cache',
    rel: '.gradle/caches', mode: 'self', safety: 'ask',
    whyJunk: 'Downloaded libraries and build results for Java/Android projects.',
    whyKeep: 'Next builds need internet and take much longer. If you are on a slow connection, think twice.',
    afterRemoval: 'Re-downloaded on the next build.',
  },
  {
    id: 'maven-repo', category: DEV, title: 'Maven library cache',
    rel: '.m2/repository', mode: 'self', safety: 'ask',
    whyJunk: 'Downloaded Java libraries.',
    whyKeep: 'Libraries you installed by hand into this folder cannot be downloaded again.',
    afterRemoval: 'Re-downloaded on the next build (except hand-installed ones).',
  },
  {
    id: 'cargo-registry', category: DEV, title: 'Rust (Cargo) package cache',
    rel: '.cargo/registry', mode: 'self', safety: 'ask',
    whyJunk: 'Downloaded Rust crates and their source.',
    whyKeep: 'Next builds need internet. Projects that must build offline would break.',
    afterRemoval: 'Re-downloaded on the next build.',
  },

  // ---------- Hidden folders in your home folder ----------
  {
    id: 'npm-logs', category: HIDDEN, title: 'npm logs (older than 14 days)',
    rel: '.npm/_logs', mode: 'contents', safety: 'safe', olderThanDays: 14,
    whyJunk: 'npm writes a log file every time you run it. Old ones only matter if you are chasing an old install error. Deleting them is fine.',
    whyKeep: 'If you are fixing an install problem right now, a recent log can help. Logs from the last 14 days are left alone.',
    afterRemoval: 'npm writes new logs when you use it.',
  },
  {
    id: 'nvm-cache', category: HIDDEN, title: 'nvm download cache',
    rel: '.nvm/.cache', mode: 'self', safety: 'safe',
    whyJunk: 'Downloads that nvm saved when you installed Node versions. The Node versions themselves live in another folder, so deleting this is fine.',
    whyKeep: 'You would need internet to install the same Node version again.',
    afterRemoval: 'Rebuilt the next time you install a Node version.',
  },
  {
    id: 'nvm-versions', category: HIDDEN, title: 'Node version installed by nvm',
    rel: '.nvm/versions/node', mode: 'children', safety: 'ask', minBytes: 1 * MB,
    whyJunk: 'Each folder is a full copy of one Node.js version that nvm installed. Old versions you no longer use only take space, and nvm can install them again.',
    whyKeep: 'A project might need exactly this Node version. If it is your default version, "node" in Terminal stops working until you install another one.',
    afterRemoval: 'Install it again with "nvm install" and the version number.',
  },
  {
    id: 'nuget-packages', category: HIDDEN, title: '.NET (NuGet) package cache',
    rel: '.nuget/packages', mode: 'self', safety: 'ask',
    whyJunk: 'Libraries that your .NET projects downloaded. NuGet can download them again, so deleting this is fine.',
    whyKeep: 'The next build needs internet and takes longer. Projects that must build offline would break.',
    afterRemoval: 'Downloaded again on the next build.',
  },
  {
    id: 'expo-cache', category: HIDDEN, title: 'Expo cache (.expo)',
    rel: '.expo', mode: 'self', safety: 'ask',
    whyJunk: 'Cache files from Expo (React Native tools), like downloaded Expo Go apps and lists of native modules. Expo makes them again, so deleting them is fine.',
    whyKeep: 'Expo has to download Expo Go again, which takes a few minutes. A small file here may also remember your Expo login.',
    afterRemoval: 'Rebuilt by Expo. You may need to sign in to Expo again.',
  },
  {
    id: 'vscode-extensions', category: HIDDEN, title: 'VS Code extensions you installed',
    rel: '.vscode/extensions', mode: 'self', safety: 'ask',
    whyJunk: 'Every extension you ever installed in VS Code lives here. Unused or old ones only take space, and they can be installed again from VS Code.',
    whyKeep: 'Deleting this folder removes ALL your VS Code extensions at once, not just the ones you do not use. Your settings are stored somewhere else and stay.',
    afterRemoval: 'Reinstall the extensions you want from inside VS Code.',
  },
  {
    id: 'adobe-hidden', category: HIDDEN, title: 'Adobe hidden folder (.adobe)',
    rel: '.adobe', mode: 'self', safety: 'ask',
    whyJunk: 'Settings and cache files that Adobe apps leave in a hidden folder. Adobe apps make them again.',
    whyKeep: 'Some of it may be your Adobe app settings or login. I cannot tell which parts.',
    afterRemoval: 'Adobe apps create it again. You might need to sign in or reset a few settings.',
  },
  {
    id: 'servicehub-logs', category: HIDDEN, title: 'Visual Studio service logs (older than 14 days)',
    rel: '.ServiceHub/Logs', mode: 'contents', safety: 'safe', olderThanDays: 14,
    whyJunk: 'Log files from background services of Visual Studio. They only help when tracking down a Visual Studio problem, so old ones are fine to delete.',
    whyKeep: 'If Visual Studio is acting up, recent logs help. Logs from the last 14 days are left alone.',
    afterRemoval: 'New logs are written when needed.',
  },
  {
    id: 'templateengine', category: HIDDEN, title: '.NET template cache (.templateengine)',
    rel: '.templateengine', mode: 'self', safety: 'ask',
    whyJunk: 'A cache that "dotnet new" uses to list project templates. It is rebuilt by .NET, so deleting it is fine.',
    whyKeep: 'If you installed extra templates yourself, you would have to install them again.',
    afterRemoval: 'Rebuilt the next time you use "dotnet new".',
  },
  {
    id: 'zsh-sessions', category: HIDDEN, title: 'Old Terminal window history (older than 30 days)',
    rel: '.zsh_sessions', mode: 'contents', safety: 'safe', olderThanDays: 30,
    whyJunk: 'Terminal remembers each window so it can bring it back after a restart. These belong to windows you closed a long time ago, so deleting them is fine.',
    whyKeep: 'You lose the "restore previous session" text for those old windows. Your main command history is somewhere else and stays.',
    afterRemoval: 'New session files are made when you open Terminal.',
  },
];

const MIN_SHOW = 1 * MB;

function mkFinding(
  rule: Rule, idSuffix: string, title: string, paths: string[], displayPath: string,
  bytes: number, newest: number, safety: Safety, whyKeep: string,
): RawFinding {
  return {
    id: `${rule.id}:${idSuffix}`,
    category: rule.category,
    title,
    paths,
    displayPath,
    sizeBytes: bytes,
    safety,
    whyJunk: rule.whyJunk,
    whyKeep,
    afterRemoval: rule.afterRemoval,
    lastModified: newest,
  };
}

export async function runRules(home: string, onStep: (s: string) => void, now = Date.now()): Promise<RawFinding[]> {
  const out: RawFinding[] = [];
  for (const rule of RULES) {
    const base = path.join(home, rule.rel);
    const st = await lstatSafe(base);
    if (!st) continue;
    onStep(`Checking ${rule.title}`);

    if (rule.mode === 'self') {
      const m = await measure(base);
      if (m.bytes >= MIN_SHOW) out.push(mkFinding(rule, base, rule.title, [base], base, m.bytes, m.newest, rule.safety, rule.whyKeep));
      continue;
    }

    let names: string[] = [];
    try {
      names = await fs.readdir(base);
    } catch {
      continue;
    }
    const cutoff = rule.olderThanDays ? now - rule.olderThanDays * DAY : Infinity;
    const items: { name: string; full: string; bytes: number; newest: number }[] = [];
    for (const name of names) {
      const full = path.join(base, name);
      const m = await measure(full);
      if (m.newest > cutoff) continue; // too recent, leave it
      items.push({ name, full, bytes: m.bytes, newest: m.newest });
    }

    if (rule.mode === 'contents') {
      const bytes = items.reduce((a, i) => a + i.bytes, 0);
      if (bytes >= MIN_SHOW) {
        out.push(mkFinding(rule, base, rule.title, items.map((i) => i.full), base, bytes,
          Math.max(...items.map((i) => i.newest)), rule.safety, rule.whyKeep));
      }
      continue;
    }

    // children
    const threshold = rule.minBytes ?? 0;
    const small: typeof items = [];
    for (const it of items) {
      if (it.bytes >= threshold && it.bytes >= MIN_SHOW) {
        const c = rule.classify?.(it.name);
        out.push(mkFinding(rule, it.full, `${rule.title}: ${it.name}`, [it.full], it.full, it.bytes, it.newest,
          c?.safety ?? rule.safety, c?.whyKeep ?? rule.whyKeep));
      } else {
        small.push(it);
      }
    }
    const smallSafe = small.filter((i) => rule.classify?.(i.name)?.safety !== 'ask');
    const smallBytes = smallSafe.reduce((a, i) => a + i.bytes, 0);
    if (smallSafe.length > 1 && smallBytes >= MIN_SHOW * 5) {
      out.push(mkFinding(rule, `${base}#small`, `${rule.title}: ${smallSafe.length} smaller items (each under ${humanSize(threshold || MIN_SHOW)})`,
        smallSafe.map((i) => i.full), base, smallBytes, Math.max(...smallSafe.map((i) => i.newest)),
        rule.safety, rule.whyKeep));
    }
  }
  return out;
}
