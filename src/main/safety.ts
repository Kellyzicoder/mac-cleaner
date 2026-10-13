import { existsSync } from 'fs';
import * as path from 'path';

/**
 * Last line of defence. Even if a rule or scanner has a bug, nothing in here
 * can ever be moved to Trash by this app.
 * Returns a reason string if the path is protected, or null if it is allowed.
 */
/** Apps that came with macOS. They are never offered for removal. */
export const MAC_OWN_APPS = new Set([
  'Safari.app', 'Mail.app', 'Photos.app', 'Music.app', 'TV.app', 'Podcasts.app', 'Messages.app', 'FaceTime.app',
  'Maps.app', 'Notes.app', 'Calendar.app', 'Contacts.app', 'Reminders.app', 'Preview.app', 'TextEdit.app',
  'Terminal.app', 'Finder.app', 'App Store.app', 'System Settings.app', 'System Preferences.app', 'Siri.app',
  'Time Machine.app', 'Photo Booth.app', 'QuickTime Player.app', 'Dictionary.app', 'Calculator.app',
  'Automator.app', 'Chess.app', 'Stickies.app', 'Font Book.app', 'Image Capture.app', 'Books.app', 'Home.app',
  'Stocks.app', 'Weather.app', 'Voice Memos.app', 'Shortcuts.app', 'Freeform.app', 'Clock.app', 'Passwords.app',
]);

export function protectedReason(target: string, home: string): string | null {
  const p = path.resolve(target);
  const h = path.resolve(home);

  // Photoshop scratch files live in the system temp folder, outside the home folder.
  if (/^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/Photoshop Temp\d+$/.test(p)) return null;

  // Apps you installed yourself in /Applications may be offered. The ones that came with macOS never are.
  if (/^\/Applications\/(?:[^/]+\/)?[^/]+\.app$/.test(p)) {
    if (MAC_OWN_APPS.has(path.basename(p)) || p.startsWith('/Applications/Utilities/')) return 'It came with macOS.';
    return null;
  }

  if (p !== h && !p.startsWith(h + path.sep)) return 'It is outside your home folder.';

  const rel = path.relative(h, p);
  const segs = rel.split(path.sep);

  // The big top-level folders themselves: only things inside them may be cleaned.
  const exactRoots = [
    '', 'Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music', 'Public',
    'Applications', 'Library', 'Library/Application Support', 'Library/Caches',
    'Library/Logs', 'Library/Containers', 'Library/Developer', 'Library/Preferences',
    '.claude', '.cache', '.npm', '.config', '.local', 'Developer', 'Library/Application Support/Claude',
  ];
  if (exactRoots.includes(rel.split(path.sep).join('/'))) return 'It is a main folder, not a single junk item.';

  // Personal, private or hard-to-replace data.
  const protectedPrefixes = [
    'Library/Keychains', 'Library/Mobile Documents', 'Library/Mail', 'Library/Messages',
    'Library/Application Support/AddressBook', 'Library/Application Support/CloudDocs',
    'Library/Safari', 'Library/Preferences', 'Library/Group Containers',
    '.ssh', '.gnupg', '.aws', '.kube', '.config/gh',
    // Things you wrote or set up yourself for Claude Code:
    '.claude/settings.json', '.claude/settings.local.json', '.claude/CLAUDE.md', '.claude/.credentials.json',
    '.claude/agents', '.claude/commands', '.claude/skills', '.claude/plugins', '.claude/hooks',
    '.claude.json',
    // Settings, logins and shell setup. Never junk, even though they are hidden.
    '.config', '.local', '.docker', '.cups', '.Trash', '.oh-my-zsh',
    '.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile',
    '.gitconfig', '.zsh_history', '.bash_history',
  ];
  const relPosix = segs.join('/');
  for (const pre of protectedPrefixes) {
    if (relPosix === pre || relPosix.startsWith(pre + '/')) return `It is in a protected place (${pre}).`;
  }

  // Claude Code keeps its saved memory in .claude/projects/<project>/memory. Never touch it,
  // and never move a whole project folder that holds it.
  if (segs[0] === '.claude' && segs[1] === 'projects' && segs.length >= 3) {
    if (segs[3] === 'memory') return 'It is Claude\'s saved memory.';
    if (existsSync(path.join(h, '.claude', 'projects', segs[2], 'memory'))) return 'This project folder holds Claude\'s saved memory.';
  }

  // Never touch git history, or inside photo/music libraries.
  if (segs.includes('.git')) return 'It is part of a Git repository history.';
  if (segs.some((s) => /\.(photoslibrary|musiclibrary|imovielibrary|fcpbundle|logicx)$/i.test(s))) {
    return 'It is inside a media library.';
  }
  if (segs.includes('.env') || /(^|\/)\.env(\.[\w-]+)?$/.test(relPosix)) return 'It looks like a secrets file.';

  return null;
}
