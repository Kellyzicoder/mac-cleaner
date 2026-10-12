import { useEffect, useMemo, useState } from 'react';
import type { AppRow, ExtRow, UpdatesInfo } from '../shared/types';
import { human } from './format';

interface Item {
  id: string;
  title: string;
  sub: string;
  /** The date that the year range and "not opened for" use. */
  dateMs: number | null;
  bytes: number;
  badge?: string;
}

function dateText(ms: number | null): string {
  return ms === null ? 'no record' : new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function PickList({
  title, intro, items, dateLabel, onTrash, empty,
}: {
  title: string;
  intro: string;
  items: Item[];
  dateLabel: string;
  onTrash: (ids: string[]) => Promise<string>;
  empty: string;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const years = useMemo(() => {
    const ys = items.map((i) => (i.dateMs === null ? null : new Date(i.dateMs).getFullYear())).filter((y): y is number => y !== null);
    return ys.length ? Array.from({ length: Math.max(...ys) - Math.min(...ys) + 1 }, (_, k) => Math.min(...ys) + k) : [];
  }, [items]);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const f = from ?? years[0];
  const t = to ?? years[years.length - 1];

  function pickYears() {
    setPicked(new Set(items.filter((i) => i.dateMs !== null && new Date(i.dateMs).getFullYear() >= f && new Date(i.dateMs).getFullYear() <= t).map((i) => i.id)));
  }
  function pickOlder(days: number) {
    const cut = Date.now() - days * 86_400_000;
    setPicked(new Set(items.filter((i) => (i.dateMs ?? 0) < cut).map((i) => i.id)));
  }
  function toggle(id: string) {
    const n = new Set(picked);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setPicked(n);
  }
  const chosen = items.filter((i) => picked.has(i.id));
  const bytes = chosen.reduce((a, i) => a + i.bytes, 0);

  async function go() {
    setBusy(true);
    setMsg(await onTrash(chosen.map((i) => i.id)));
    setPicked(new Set());
    setBusy(false);
  }

  return (
    <section className="glass libsec">
      <div className="cardrow"><b>{title}</b><span className="muted">{items.length} found</span></div>
      <div className="tiny muted">{intro}</div>
      {items.length === 0 ? <div className="muted">{empty}</div> : (
        <>
          <div className="libtools">
            <span className="tiny muted">Pick by {dateLabel}:</span>
            <select value={f} onChange={(e) => setFrom(Number(e.target.value))} aria-label="From year">
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <span className="tiny muted">to</span>
            <select value={t} onChange={(e) => setTo(Number(e.target.value))} aria-label="To year">
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={pickYears}>Pick these years</button>
            <button onClick={() => pickOlder(180)}>Older than 6 months</button>
            <button onClick={() => pickOlder(365)}>Older than 1 year</button>
            <button className="link" onClick={() => setPicked(new Set())}>Clear</button>
          </div>
          <div className="liblist">
            {items.map((i) => (
              <label key={i.id} className="librow">
                <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} />
                <span className="libname">{i.title}{i.badge && <em className="chip unk"> {i.badge}</em>}<span className="tiny muted"> {i.sub}</span></span>
                <span className="tiny muted">{dateText(i.dateMs)}</span>
                <span className="tiny">{human(i.bytes)}</span>
              </label>
            ))}
          </div>
          <div className="cardrow">
            <span className="muted">{chosen.length} picked · {human(bytes)}</span>
            <button className="primary" disabled={chosen.length === 0 || busy} onClick={() => void go()}>
              {busy ? 'Moving…' : `Move ${chosen.length} to Trash`}
            </button>
          </div>
        </>
      )}
      {msg && <div className="tiny muted">{msg}</div>}
    </section>
  );
}

export function Library() {
  const [apps, setApps] = useState<AppRow[] | null>(null);
  const [exts, setExts] = useState<ExtRow[] | null>(null);
  const [upd, setUpd] = useState<UpdatesInfo | null>(null);
  const [checking, setChecking] = useState(false);

  async function load() {
    setApps(await window.cleaner.libApps());
    setExts(await window.cleaner.libExtensions());
  }
  useEffect(() => { void load(); }, []);

  async function trash(ids: string[]): Promise<string> {
    const r = await window.cleaner.libTrash(ids);
    await load();
    const bad = r.failed.map((x) => x.reason);
    return `Moved ${r.movedIds.length} to the Trash (${human(r.freedBytes)}). You can put them back from the Trash.` + (bad.length ? ` Skipped ${bad.length}: ${bad[0]}` : '');
  }
  async function check() {
    setChecking(true);
    try {
      setUpd(await window.cleaner.checkUpdates());
    } finally {
      setChecking(false);
    }
  }

  const appItems: Item[] = (apps ?? []).map((a) => ({
    id: a.id,
    title: a.name,
    sub: a.lastOpenedMs === null ? '(macOS has no record you opened it)' : a.fromStore ? '(App Store)' : '',
    dateMs: a.lastOpenedMs ?? a.addedMs,
    bytes: a.bytes,
  }));
  const extItems: Item[] = (exts ?? []).map((e) => ({
    id: e.id,
    title: e.name,
    sub: `${e.version} · ${e.editor}`,
    dateMs: e.installedMs,
    bytes: e.bytes,
    badge: e.oldCopy ? 'old copy' : undefined,
  }));

  return (
    <div className="dash">
      <PickList
        title="Apps"
        intro="Apps you installed yourself, oldest first. The date is when you last opened it. Apps that came with macOS are not listed. Nothing moves until you press the button."
        items={appItems}
        dateLabel="last opened year"
        onTrash={trash}
        empty={apps === null ? 'Looking at your apps…' : 'No apps found.'}
      />

      <section className="glass libsec">
        <div className="cardrow">
          <b>Check for updates</b>
          <button onClick={() => void check()} disabled={checking}>{checking ? 'Checking… (can take a minute)' : 'Check now'}</button>
        </div>
        <div className="tiny muted">I only look. I never install anything.</div>
        {upd && (
          <div className="updres">
            <div>macOS: {upd.macos === null ? 'could not check' : upd.macos.length === 0 ? 'up to date' : upd.macos.join(', ')}
              {upd.macos && upd.macos.length > 0 && <button className="link" onClick={() => void window.cleaner.openSoftwareUpdate()}>Open Software Update</button>}</div>
            <div>App Store apps: {!upd.hasMas ? 'open the App Store > Updates (I can only read this if you have the "mas" tool)' : upd.store === null ? 'could not check' : upd.store.length === 0 ? 'up to date' : upd.store.length + ' waiting'}</div>
            <div>Homebrew apps: {!upd.hasBrew ? 'Homebrew is not installed' : upd.brew === null ? 'could not check' : upd.brew.length === 0 ? 'up to date' : `${upd.brew.length} waiting (${upd.brew.slice(0, 6).join(', ')}). Run: brew upgrade`}</div>
            <div className="tiny muted">Other apps update themselves. Open the app and choose its menu &gt; Check for Updates.</div>
          </div>
        )}
      </section>

      <PickList
        title="Editor extensions (VS Code, Cursor)"
        intro="VS Code does not record when you last used an extension, so the date is when it was installed. Pick a range of years, then untick anything you still want. Close the editor first. Old copies are earlier versions the editor no longer uses."
        items={extItems}
        dateLabel="year installed"
        onTrash={trash}
        empty={exts === null ? 'Looking for extensions…' : 'No VS Code or Cursor extensions found.'}
      />
    </div>
  );
}
