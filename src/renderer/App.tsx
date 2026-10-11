import { useEffect, useMemo, useState } from 'react';
import { Tidy } from './Tidy';
import { Dashboard } from './Dashboard';
import type { CleanResult, Finding, Preview, TrashInfo } from '../shared/types';
import { inUseText } from '../shared/text';
import { Logo } from './Logo';

function human(bytes: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) return (bytes / GB).toFixed(1) + ' GB';
  if (bytes >= MB) return Math.round(bytes / MB) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function ago(ms: number): string {
  if (!ms) return 'unknown';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}

type Phase = 'idle' | 'scanning' | 'review' | 'cleaning' | 'done';
type Tab = 'safe' | 'ask';

function PreviewBox({ load }: { load: () => Promise<Preview> }) {
  const [p, setP] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    load()
      .then((r) => {
        if (alive) setP(r);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) return <div className="preview muted">No preview available.</div>;
  if (!p) return <div className="preview muted">Loading preview…</div>;

  if (p.kind === 'image') {
    return (
      <div className="preview">
        <img className="pimg" src={p.dataUrl} alt="Preview of the item" />
      </div>
    );
  }
  if (p.kind === 'text') {
    return (
      <div className="preview">
        <pre className="ptext">
          {p.text}
          {p.truncated ? '\n…' : ''}
        </pre>
      </div>
    );
  }
  if (p.kind === 'list') {
    return (
      <div className="preview">
        <div className="plist">
          {p.items.map((it, i) => (
            <div className="prow" key={i}>
              <span className="pname">
                {it.isDir ? '📁 ' : ''}
                {it.name}
              </span>
              <span className="muted">{human(it.bytes)}</span>
            </div>
          ))}
          {p.more > 0 && <div className="muted">and {p.more} more</div>}
        </div>
      </div>
    );
  }
  return <div className="preview muted">{p.note}</div>;
}

export function App() {
  const [mode, setMode] = useState<'dash' | 'clean' | 'tidy'>('dash');
  const [phase, setPhase] = useState<Phase>('idle');
  const [tab, setTab] = useState<Tab>('safe');
  const [step, setStep] = useState('');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<CleanResult | null>(null);
  const [error, setError] = useState('');
  const [rechecking, setRechecking] = useState(false);
  const [trash, setTrash] = useState<TrashInfo | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashBusy, setTrashBusy] = useState(false);
  const [trashMsg, setTrashMsg] = useState('');

  useEffect(() => window.cleaner.onProgress((p) => setStep(p.step)), []);

  async function refreshTrash() {
    try {
      setTrash(await window.cleaner.trashInfo());
    } catch {
      setTrash(null);
    }
  }
  useEffect(() => {
    void refreshTrash();
  }, []);

  async function emptyTrash() {
    setTrashBusy(true);
    setTrashMsg('');
    try {
      const r = await window.cleaner.emptyTrash();
      setTrashMsg(r.message);
      setTrashOpen(false);
    } catch (e) {
      setTrashMsg((e as Error).message);
    } finally {
      setTrashBusy(false);
      void refreshTrash();
    }
  }

  const inUse = (f: Finding) => f.inUseBy.length > 0;

  async function scan() {
    setError('');
    setResult(null);
    setPhase('scanning');
    setStep('Starting');
    try {
      const list = await window.cleaner.scan();
      setFindings(list);
      // Only the ones we are sure about start ticked. "Not sure" items and items in use start unticked.
      setSelected(new Set(list.filter((f) => f.safety === 'safe' && f.inUseBy.length === 0).map((f) => f.id)));
      setOpen(new Set());
      setTab(list.some((f) => f.safety === 'safe') || !list.some((f) => f.safety === 'ask') ? 'safe' : 'ask');
      setPhase('review');
    } catch (e) {
      setError((e as Error).message);
      setPhase('idle');
    }
  }

  async function recheck() {
    setRechecking(true);
    setError('');
    try {
      const map = await window.cleaner.recheck();
      setFindings((list) => list.map((f) => ({ ...f, inUseBy: map[f.id] ?? [] })));
      setSelected((s) => new Set([...s].filter((id) => (map[id] ?? []).length === 0)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRechecking(false);
    }
  }

  const safeList = useMemo(() => findings.filter((f) => f.safety === 'safe'), [findings]);
  const askList = useMemo(() => findings.filter((f) => f.safety === 'ask'), [findings]);
  const shown = tab === 'safe' ? safeList : askList;

  const chosen = useMemo(() => findings.filter((f) => selected.has(f.id) && f.inUseBy.length === 0), [findings, selected]);
  const chosenBytes = chosen.reduce((a, f) => a + f.sizeBytes, 0);
  const sum = (list: Finding[]) => list.reduce((a, f) => a + f.sizeBytes, 0);
  const inUseCount = findings.filter(inUse).length;

  const groups = useMemo(() => {
    const map = new Map<string, Finding[]>();
    for (const f of shown) map.set(f.category, [...(map.get(f.category) ?? []), f]);
    return [...map.entries()]
      .map(([name, items]) => ({ name, items, bytes: items.reduce((a, f) => a + f.sizeBytes, 0) }))
      .sort((a, b) => b.bytes - a.bytes);
  }, [shown]);

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleOpen(id: string) {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const selectable = shown.filter((f) => f.inUseBy.length === 0);
  const allTicked = selectable.length > 0 && selectable.every((f) => selected.has(f.id));
  function toggleAllInTab() {
    setSelected((s) => {
      const n = new Set(s);
      for (const f of selectable) {
        if (allTicked) n.delete(f.id);
        else n.add(f.id);
      }
      return n;
    });
  }

  async function clean() {
    const ask = chosen.filter((f) => f.safety === 'ask').length;
    const apps = chosen.filter((f) => f.category === 'Unused apps').length;
    const msg =
      `Move ${chosen.length} item${chosen.length === 1 ? '' : 's'} (${human(chosenBytes)}) to the Trash?\n\n` +
      (ask ? `${ask} of them are ones I was not sure about, and you chose to include them.\n\n` : '') +
      (apps ? `${apps} of them ${apps === 1 ? 'is an app' : 'are apps'} you have not opened for a long time.\n\n` : '') +
      'I will check once more that no app is using them. Nothing is deleted for good until you empty the Trash.';
    if (!window.confirm(msg)) return;
    setPhase('cleaning');
    try {
      const r = await window.cleaner.clean(chosen.map((f) => f.id));
      setResult(r);
      const moved = new Set(r.movedIds);
      setFindings((list) => list.filter((f) => !moved.has(f.id)));
      setSelected((s) => new Set([...s].filter((id) => !moved.has(id))));
      setPhase('done');
      void refreshTrash();
      if (r.failed.length > 0) void recheck();
    } catch (e) {
      setError((e as Error).message);
      setPhase('review');
    }
  }

  async function keepForever(f: Finding) {
    await window.cleaner.alwaysKeep(f.id);
    setFindings((list) => list.filter((x) => x.id !== f.id));
    setSelected((s) => {
      const n = new Set(s);
      n.delete(f.id);
      return n;
    });
  }

  const showList = phase === 'review' || phase === 'done' || phase === 'cleaning';

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Logo size={44} />
          <div>
            <h1>Mac Purificator</h1>
            <p className="sub">Finds junk, tells you why it can go, and asks when it is not sure.</p>
          </div>
        </div>
        <div className="topbtns" style={{ visibility: mode === 'clean' ? 'visible' : 'hidden' }}>
          {showList && (
            <button onClick={recheck} disabled={rechecking || phase === 'cleaning'}>
              {rechecking ? 'Checking…' : 'Re-check apps'}
            </button>
          )}
          <button className="primary" onClick={scan} disabled={phase === 'scanning' || phase === 'cleaning'}>
            {phase === 'idle' ? 'Scan my Mac' : 'Scan again'}
          </button>
        </div>
      </header>

      <nav className="modes" role="tablist">
        <button role="tab" aria-selected={mode === 'dash'} className={`mode ${mode === 'dash' ? 'on' : ''}`} onClick={() => setMode('dash')}>
          Overview
        </button>
        <button role="tab" aria-selected={mode === 'clean'} className={`mode ${mode === 'clean' ? 'on' : ''}`} onClick={() => setMode('clean')}>
          Clean up junk
        </button>
        <button role="tab" aria-selected={mode === 'tidy'} className={`mode ${mode === 'tidy' ? 'on' : ''}`} onClick={() => setMode('tidy')}>
          Tidy my files
        </button>
      </nav>

      {mode === 'dash' && (
        <Dashboard
          onClean={() => setMode('clean')}
          onScan={() => {
            setMode('clean');
            void scan();
          }}
        />
      )}

      {mode === 'tidy' && <Tidy />}

      {mode === 'clean' && (
        <>
      <div className="trashbar">
        <div className="trashrow">
          <span className="trashicon" aria-hidden="true">🗑</span>
          <span className="trashtext">
            {trash === null
              ? 'Trash bin'
              : trash.items === 0
                ? 'Trash bin is empty.'
                : trash.readable && trash.bytes !== null
                  ? `Trash bin: ${human(trash.bytes)} in ${trash.items} item${trash.items === 1 ? '' : 's'}.`
                  : `Trash bin: ${trash.items ?? 'some'} item${trash.items === 1 ? '' : 's'}. macOS does not let me see the size.`}
            <span className="muted"> Emptying it deletes everything in it for good.</span>
          </span>
          {trash !== null && trash.items !== 0 && (
            <button className="link" onClick={() => setTrashOpen((o) => !o)}>
              {trashOpen ? 'Hide' : 'Look inside'}
            </button>
          )}
          <button className="danger" onClick={emptyTrash} disabled={trashBusy || trash?.items === 0}>
            {trashBusy ? 'Emptying…' : 'Empty Trash'}
          </button>
        </div>
        {trashMsg && <div className="muted trashmsg">{trashMsg}</div>}
        {trashOpen && <PreviewBox key="trash" load={() => window.cleaner.trashPreview()} />}
      </div>

      {error && <div className="banner error">{error}</div>}

      {phase === 'idle' && (
        <div className="empty">
          <p>
            Press <b>Scan my Mac</b>. Nothing is changed during a scan. You review everything first, and approved items
            go to the Trash, not straight to deletion.
          </p>
        </div>
      )}

      {phase === 'scanning' && (
        <div className="empty">
          <div className="spinner" />
          <p>{step}…</p>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="banner ok">
          Moved {result.movedIds.length} item{result.movedIds.length === 1 ? '' : 's'} to the Trash ({human(result.freedBytes)}).
          Press Empty Trash at the top to get the space back.
          {result.failed.length > 0 && (
            <ul className="fails">
              {result.failed.map((f) => (
                <li key={f.id}>
                  <b>{findings.find((x) => x.id === f.id)?.title ?? 'One item'}:</b> {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showList && (
        <>
          {inUseCount > 0 && (
            <div className="banner warn">
              {inUseCount} item{inUseCount === 1 ? ' is' : 's are'} being used by an open app, so I will not move{' '}
              {inUseCount === 1 ? 'it' : 'them'}. Quit the app, then press <b>Re-check apps</b>.
            </div>
          )}

          <nav className="tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === 'safe'}
              className={`tab safe ${tab === 'safe' ? 'on' : ''}`}
              onClick={() => setTab('safe')}
            >
              Safe to remove <span className="count">{safeList.length}</span>
              <span className="tabsize">{human(sum(safeList))}</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === 'ask'}
              className={`tab ask ${tab === 'ask' ? 'on' : ''}`}
              onClick={() => setTab('ask')}
            >
              Not sure. Your call <span className="count">{askList.length}</span>
              <span className="tabsize">{human(sum(askList))}</span>
            </button>
          </nav>

          <div className="tabintro">
            <span>
              {tab === 'safe'
                ? 'I am confident about these. They start ticked.'
                : 'I could not decide these myself. Open each one, read the reasons and look at the preview first. They start unticked.'}
            </span>
            {selectable.length > 0 && (
              <button className="link" onClick={toggleAllInTab}>
                {allTicked ? 'Untick all' : 'Tick all'}
              </button>
            )}
          </div>

          <main className="list">
            {shown.length === 0 && (
              <div className="empty">
                <p>{findings.length === 0 ? 'Nothing left to clean.' : 'Nothing in this tab.'}</p>
              </div>
            )}
            {groups.map((g) => (
              <section key={g.name}>
                <h2>
                  {g.name} <span className="muted">{human(g.bytes)}</span>
                </h2>
                {g.items.map((f) => {
                  const isOpen = open.has(f.id);
                  const busy = inUse(f);
                  return (
                    <div key={f.id} className={`row ${f.safety} ${busy ? 'busy' : ''}`}>
                      <div className="rowtop">
                        <input
                          type="checkbox"
                          checked={selected.has(f.id) && !busy}
                          disabled={busy}
                          onChange={() => toggle(f.id)}
                          aria-label={`Select ${f.title}`}
                        />
                        <div className="rowmain" onClick={() => toggleOpen(f.id)}>
                          <div className="title">{f.title}</div>
                          <div className="path">{f.displayPath}</div>
                        </div>
                        {busy && <span className="badge busy">In use: {f.inUseBy.slice(0, 2).join(', ')}</span>}
                        <span className="size">{human(f.sizeBytes)}</span>
                        <button className="link" onClick={() => toggleOpen(f.id)}>
                          {isOpen ? 'Hide' : 'Why?'}
                        </button>
                      </div>
                      {isOpen && (
                        <div className="detail">
                          {busy && <p className="inuse">{inUseText(f.inUseBy)}</p>}
                          <p><b>Why it can go:</b> {f.whyJunk}</p>
                          <p><b>Why it might be better to stay:</b> {f.whyKeep}</p>
                          <p><b>After removing it:</b> {f.afterRemoval}</p>
                          {f.usedBy.length > 0 && (
                            <p className="muted">
                              Normally used by: {f.usedBy.slice(0, 5).join(', ')}
                              {f.usedBy.length > 5 ? ` and ${f.usedBy.length - 5} more` : ''}
                            </p>
                          )}
                          <p className="muted">Last changed: {ago(f.lastModified)}</p>
                          <PreviewBox load={() => window.cleaner.preview(f.id)} />
                          <div className="actions">
                            <button onClick={() => window.cleaner.reveal(f.id)}>Show in Finder</button>
                            <button onClick={() => keepForever(f)}>Always keep this</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            ))}
          </main>

          <footer className="bar">
            <span>
              {chosen.length} selected, <b>{human(chosenBytes)}</b>
              {chosen.some((f) => f.safety === 'ask') && (
                <span className="muted"> ({chosen.filter((f) => f.safety === 'ask').length} from "Not sure")</span>
              )}
            </span>
            <button className="primary" onClick={clean} disabled={chosen.length === 0 || phase === 'cleaning'}>
              {phase === 'cleaning' ? 'Moving…' : 'Move selected to Trash'}
            </button>
          </footer>
        </>
      )}
        </>
      )}
    </div>
  );
}
