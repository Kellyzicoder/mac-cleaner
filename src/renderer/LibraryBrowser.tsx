import { useEffect, useState } from 'react';
import type { LibBrowse, LibEntry } from '../shared/types';
import { human } from './format';

const WORD = { safe: 'Safe', careful: 'Careful', never: 'Do not delete' } as const;
const CLS = { safe: 'yes', careful: 'unk', never: 'no' } as const;

export function LibraryBrowser() {
  const [data, setData] = useState<LibBrowse | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  async function go(id: string | null) {
    setData(null);
    setPicked(new Set());
    setOpen(null);
    setConfirm(false);
    setData(await window.cleaner.libBrowse(id));
  }
  useEffect(() => { void go(null); }, []);

  function toggle(id: string) {
    const n = new Set(picked);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setPicked(n);
    setConfirm(false);
  }

  const chosen = (data?.entries ?? []).filter((e) => picked.has(e.id));
  const risky = chosen.some((e) => e.verdict === 'careful');
  const bytes = chosen.reduce((a, e) => a + e.bytes, 0);
  const here = data?.crumbs[data.crumbs.length - 1];

  async function trash() {
    if (risky && !confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    const r = await window.cleaner.libTrash(chosen.map((e) => e.id));
    setMsg(`Moved ${r.movedIds.length} to the Trash (${human(r.freedBytes)}). You can put them back from the Trash.` + (r.failed.length ? ` Skipped ${r.failed.length}: ${r.failed[0].reason}` : ''));
    setBusy(false);
    await go(here?.id ?? null);
  }

  function row(e: LibEntry) {
    return (
      <div key={e.id} className="libitem">
        <div className="librow">
          <input type="checkbox" disabled={!e.canTrash} checked={picked.has(e.id)} onChange={() => toggle(e.id)} aria-label={`Pick ${e.name}`} />
          <span className="libname">
            {e.isDir ? <button className="link" onClick={() => void go(e.id)}>{e.name} ›</button> : e.name}
            {e.orphan && <em className="chip unk"> possible leftover</em>}
          </span>
          <span className={`chip ${CLS[e.verdict]}`}>{WORD[e.verdict]}</span>
          <span className="tiny">{human(e.bytes)}</span>
          <button className="link" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'Hide' : 'Why?'}</button>
        </div>
        {open === e.id && (
          <div className="libwhy">
            <div><b>What it is:</b> {e.what}</div>
            <div><b>Delete it?</b> {e.why}</div>
            <button className="link" onClick={() => void window.cleaner.libReveal(e.id)}>Show in Finder</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="dash">
      <section className="glass libsec">
        <div className="cardrow"><b>Library files</b></div>
        <div className="tiny muted">
          The Library folder holds settings, saved data and caches for your apps. Tap <b>Why?</b> to see what each item is and whether it is safe to delete,
          based on general knowledge about macOS. I cannot be sure about every app. Anything I mark <b>Do not delete</b> cannot be picked.
          Picked items go to the Trash, not deleted for good.
        </div>
        {data && (
          <div className="crumbs">
            {data.crumbs.map((c, i) => (
              <span key={c.id}>{i > 0 && ' › '}{i < data.crumbs.length - 1 ? <button className="link" onClick={() => void go(c.id)}>{c.name}</button> : <b>{c.name}</b>}</span>
            ))}
          </div>
        )}
        {!data && <div className="muted">Measuring… folders with a lot in them take a moment.</div>}
        {data?.note && <div className="banner warn">{data.note}</div>}
        {data && data.entries.length === 0 && !data.note && <div className="muted">Nothing here.</div>}
        <div className="liblist">{data?.entries.map(row)}</div>
        {data && data.entries.length > 0 && (
          <div className="cardrow">
            <span className="muted">
              {chosen.length} picked · {human(bytes)}
              {confirm && <b className="warnText"> Some picks are marked Careful. Press again to confirm.</b>}
            </span>
            <button className="primary" disabled={chosen.length === 0 || busy} onClick={() => void trash()}>
              {busy ? 'Moving…' : confirm ? 'Yes, move to Trash' : `Move ${chosen.length} to Trash`}
            </button>
          </div>
        )}
        {msg && <div className="tiny muted">{msg}</div>}
      </section>
    </div>
  );
}
