import { useMemo, useState } from 'react';
import type { TidyPlan, TidyResult } from '../shared/types';

function human(bytes: number): string {
  const MB = 1024 * 1024;
  if (bytes >= 1024 * MB) return (bytes / (1024 * MB)).toFixed(1) + ' GB';
  if (bytes >= MB) return Math.round(bytes / MB) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function short(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}

export function Tidy() {
  const [plan, setPlan] = useState<TidyPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<TidyResult | null>(null);
  const [message, setMessage] = useState('');
  const [undoCount, setUndoCount] = useState(0);

  async function refreshUndo() {
    setUndoCount(await window.cleaner.tidyUndoCount());
  }

  async function scan(pick: boolean) {
    setBusy(true);
    setResult(null);
    setMessage('');
    try {
      const p = await window.cleaner.tidyScan(pick);
      setPlan(p);
      setSelected(new Set(p.groups.map((g) => g.id)));
      setOpen(new Set());
      await refreshUndo();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!plan) return;
    setBusy(true);
    try {
      const r = await window.cleaner.tidyApply([...selected]);
      setResult(r);
      setPlan(null);
      await refreshUndo();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    setBusy(true);
    try {
      const r = await window.cleaner.tidyUndo();
      setMessage(r.message);
      setResult(null);
      setPlan(null);
      await refreshUndo();
    } finally {
      setBusy(false);
    }
  }

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  const chosen = useMemo(() => (plan ? plan.groups.filter((g) => selected.has(g.id)) : []), [plan, selected]);
  const fileCount = chosen.reduce((n, g) => n + g.files.length, 0);

  return (
    <div className="tidy">
      <p className="tidyintro">
        Puts loose files into folders with clear names. Each new folder gets a short note that says what is inside and
        why. Nothing is deleted, and you can undo it.
      </p>
      <div className="tidybtns">
        <button className="primary" onClick={() => scan(false)} disabled={busy}>
          {plan ? 'Look again' : 'Look at Downloads, Desktop and Documents'}
        </button>
        <button onClick={() => scan(true)} disabled={busy}>
          Pick another folder…
        </button>
        {undoCount > 0 && (
          <button onClick={undo} disabled={busy}>
            Undo last tidy ({undoCount} file{undoCount === 1 ? '' : 's'})
          </button>
        )}
      </div>

      {message && <div className="banner ok">{message}</div>}
      {busy && !plan && (
        <div className="empty">
          <div className="spinner" />
          <p>Working…</p>
        </div>
      )}

      {result && (
        <div className="banner ok">
          Moved {result.movedFiles} file{result.movedFiles === 1 ? '' : 's'} into {result.madeFolders} new folder
          {result.madeFolders === 1 ? '' : 's'}. Press <b>Undo last tidy</b> if you change your mind.
          {result.failed.length > 0 && (
            <ul className="fails">
              {result.failed.map((f, i) => (
                <li key={i}>
                  <b>{f.file}:</b> {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {plan && (
        <>
          {plan.notes.map((n, i) => (
            <div key={i} className="banner warn">{n}</div>
          ))}
          <div className="summary">
            Looked at {plan.roots.map(short).join(', ') || 'nothing'}.{' '}
            {plan.groups.length === 0 ? 'Nothing needs tidying.' : `${plan.groups.length} folder${plan.groups.length === 1 ? '' : 's'} suggested.`}
            <span className="muted"> {plan.leftAlone} file{plan.leftAlone === 1 ? '' : 's'} left where they are (single files, hidden, or still downloading).</span>
          </div>
          <main className="list">
            {plan.groups.map((g) => (
              <div key={g.id} className="group">
                <div className="rowtop">
                  <input
                    type="checkbox"
                    checked={selected.has(g.id)}
                    onChange={() => setSelected((s) => toggle(s, g.id))}
                    aria-label={`Tidy ${g.folderName}`}
                  />
                  <div className="rowmain" onClick={() => setOpen((o) => toggle(o, g.id))}>
                    <div className="gtitle">📁 {g.folderName}</div>
                    <div className="path">{short(g.sourceDir)}</div>
                  </div>
                  <span className="size">{g.files.length} files · {human(g.totalBytes)}</span>
                </div>
                {open.has(g.id) && (
                  <div className="detail">
                    <p><b>What is in it:</b> {g.description}</p>
                    <p><b>Why these go together:</b> {g.why}</p>
                    {g.folderExists && <p className="muted">A folder with this name is already there. The files are added to it, and nothing is replaced.</p>}
                    <ul className="gfiles">
                      {g.files.map((f) => (
                        <li key={f.name}>
                          <span className="pname">{f.name}</span>
                          <span className="muted">{human(f.bytes)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </main>
          <footer className="bar">
            <span>
              {chosen.length} folder{chosen.length === 1 ? '' : 's'} chosen, <b>{fileCount}</b> files will move
            </span>
            <button className="primary" onClick={apply} disabled={busy || chosen.length === 0}>
              {busy ? 'Moving…' : 'Tidy selected'}
            </button>
          </footer>
        </>
      )}
    </div>
  );
}
