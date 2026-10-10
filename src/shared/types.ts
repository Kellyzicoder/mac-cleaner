/** "safe" = we are confident it can go. "ask" = we are not sure, so the user decides. */
export type Safety = 'safe' | 'ask';

/** What the scanners produce. The app-check fills in the last two fields afterwards. */
export interface RawFinding {
  /** Stable id (rule id + path). Used for the "always keep" list. */
  id: string;
  category: string;
  title: string;
  /** What gets moved to Trash if the user approves. */
  paths: string[];
  /** Path shown to the user (usually the folder or file). */
  displayPath: string;
  sizeBytes: number;
  safety: Safety;
  /** Why it is junk. */
  whyJunk: string;
  /** Why it might be better to keep it. */
  whyKeep: string;
  /** What happens after it is removed (comes back? slower first run?). */
  afterRemoval: string;
  /** Newest change time in ms since 1970, 0 if unknown. */
  lastModified: number;
}

export interface Finding extends RawFinding {
  /** Apps or programs that normally use this item. */
  usedBy: string[];
  /** Apps or programs that are using it right now. Cleaning is blocked while this is not empty. */
  inUseBy: string[];
}

export type Preview =
  | { kind: 'image'; dataUrl: string }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'list'; total: number; items: { name: string; bytes: number; isDir: boolean }[]; more: number }
  | { kind: 'none'; note: string };

export interface TrashInfo {
  /** False when macOS does not let me look inside the Trash. Then the size is unknown. */
  readable: boolean;
  bytes: number | null;
  items: number | null;
}

export interface TidyGroup {
  /** Stable id for this plan only. The window sends ids, never paths. */
  id: string;
  /** The new folder's name. Says what is inside. */
  folderName: string;
  /** The folder the files are in now (and the new folder goes into). */
  sourceDir: string;
  description: string;
  /** Why these files were put together. */
  why: string;
  files: { name: string; bytes: number }[];
  totalBytes: number;
  /** True when a folder with this name is already there. Files are added to it. */
  folderExists: boolean;
}

export interface TidyPlan {
  groups: TidyGroup[];
  /** Folders that were looked at. */
  roots: string[];
  /** Files left alone (no clear group, hidden, still downloading, etc.). */
  leftAlone: number;
  /** Things that stopped a folder being used, in plain words. */
  notes: string[];
}

export interface TidyResult {
  movedFiles: number;
  madeFolders: number;
  failed: { file: string; reason: string }[];
}

export interface ScanProgress {
  step: string;
}

export interface CleanResult {
  movedIds: string[];
  freedBytes: number;
  failed: { id: string; reason: string }[];
}

export interface CleanerApi {
  scan(): Promise<Finding[]>;
  onProgress(cb: (p: ScanProgress) => void): () => void;
  clean(ids: string[]): Promise<CleanResult>;
  alwaysKeep(id: string): Promise<void>;
  reveal(id: string): Promise<void>;
  preview(id: string): Promise<Preview>;
  /** Looks at the running apps again. Returns, for every item, who is using it now. */
  recheck(): Promise<Record<string, string[]>>;
  trashInfo(): Promise<TrashInfo>;
  trashPreview(): Promise<Preview>;
  /** Asks the person to confirm in a native window, then empties the Trash for good. */
  emptyTrash(): Promise<{ ok: boolean; message: string }>;
  /** Looks at Downloads, Desktop and Documents (and a folder you pick) and plans folders. Moves nothing. */
  tidyScan(pickFolder: boolean): Promise<TidyPlan>;
  tidyApply(groupIds: string[]): Promise<TidyResult>;
  /** How many files the last tidy moved (0 = nothing to undo). */
  tidyUndoCount(): Promise<number>;
  tidyUndo(): Promise<{ ok: boolean; message: string }>;
}
