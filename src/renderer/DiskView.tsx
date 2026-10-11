import { useEffect, useState } from 'react';
import type { DashInfo, DiskAnalysis, DiskEntry, TrashInfo } from '../shared/types';
import { gb2, human } from './format';

const COLORS: Record<string, string> = {
  documents: '#7d82ff',
  applications: '#ff7b7b',
  desktop: '#58e0b0',
  downloads: '#e47cff',
  other: '#ededf7',
};

function Donut({ total, available, parts }: { total: number; available: number; parts: { key: string; bytes: number }[] }) {
  const R = 92;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg viewBox="0 0 260 260" className="donut" role="img" aria-label={`${gb2(available)} of ${gb2(total)} available`}>
      <circle cx="130" cy="130" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="34" />
      {parts.map((p) => {
        const len = (p.bytes / total) * C;
        const el = (
          <circle
            key={p.key}
            cx="130" cy="130" r={R} fill="none" stroke={COLORS[p.key] ?? '#fff'} strokeWidth="34"
            strokeDasharray={`${Math.max(0, len - 2)} ${C - Math.max(0, len - 2)}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 130 130)"
          />
        );
        offset += len;
        return el;
      })}
      <text x="130" y="128" textAnchor="middle" className="donutnum">{(available / 1024 ** 3).toFixed(2)} <tspan className="donutunit">GB</tspan></text>
      <text x="130" y="152" textAnchor="middle" className="donutsub">of {(total / 1024 ** 3).toFixed(2)} GB</text>
      <text x="130" y="170" textAnchor="middle" className="donutsub">available</text>
    </svg>
  );
}

export function DiskView({ info, onBack, onClean }: { info: DashInfo; onBack: () => void; onClean: () => void }) {
  const [a, setA] = useState<DiskAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [error, setError] = useState('');
  const [trail, setTrail] = useState<{ name: string; entries: DiskEntry[] }[]>([]);
  const [loadingKids, setLoadingKids] = useState(false);
  const [trash, setTrash] = useState<TrashInfo | null>(null);
  const [trashMsg, setTrashMsg] = useState('');

  useEffect(() => {
    void window.cleaner.trashInfo().then(setTrash).catch(() => undefined);
    return window.cleaner.onProgress((p) => setStep(p.step));
  }, []);

  async function analyze() {
    setBusy(true);
    setError('');
    setTrail([]);
    try {
      setA(await window.cleaner.diskAnalyze());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not measure the disk.');
    } finally {
      setBusy(false);
    }
  }

  async function open(e: DiskEntry) {
    if (!e.isDir) return;
    setLoadingKids(true);
    try {
      const kids = await window.cleaner.diskChildren(e.id);
      setTrail((t) => [...t, { name: e.name, entries: kids }]);
    } finally {
      setLoadingKids(false);
    }
  }

  async function emptyTrash() {
    const r = await window.cleaner.emptyTrash();
    setTrashMsg(r.message);
    setTrash(await window.cleaner.trashInfo());
  }

  const total = info.disk.totalBytes;
  const avail = info.disk.availableBytes;
  const parts = a ? a.categories.map((c) => ({ key: c.key, bytes: c.bytes })) : [{ key: 'other', bytes: total - avail }];
  const shown = trail.length ? trail[trail.length - 1].entries : a?.other ?? [];
  const shownTotal = shown.reduce((n, e) => n + e.bytes, 0) || 1;
  const trashPct = trash && trash.bytes !== null ? Math.min(100, (trash.bytes / (2 * 1024 ** 3)) * 100) : 0;

  return (
    <div className="dash">
      <div className="crumbs">
        <button className="link" onClick={onBack}>‹ Overview</button>
        <h2 className="herotitle">Macintosh HD</h2>
      </div>

      <section className="glass diskhero">
        <Donut total={total} available={avail} parts={parts} />
        <div className="legend">
          {a ? (
            a.categories.map((c) => (
              <div key={c.key} className="lg">
                <i style={{ background: COLORS[c.key] }} />
                <div>
                  <div>{c.label}</div>
                  <b>{c.bytes >= 1024 ** 3 ? gb2(c.bytes) : human(c.bytes)}</b>
                </div>
              </div>
            ))
          ) : (
            <div>
              <p className="muted">
                The ring shows used space. To see what is inside it, press <b>Measure</b>. This reads the sizes of your folders and can take a few minutes.
              </p>
              <button className="primary" onClick={analyze} disabled={busy}>{busy ? 'Measuring…' : 'Measure what uses my space'}</button>
              {busy && <div className="tiny muted">{step}…</div>}
            </div>
          )}
          {a && <button className="link" onClick={analyze} disabled={busy}>{busy ? 'Measuring…' : 'Measure again'}</button>}
        </div>
      </section>
      {error && <div className="banner error">{error}</div>}

      {a && (
        <section className="glass">
          <div className="cardrow">
            <b>
              {trail.length ? (
                <>
                  <button className="link" onClick={() => setTrail([])}>Other</button>
                  {trail.map((t, i) => (
                    <span key={i}> / <button className="link" onClick={() => setTrail(trail.slice(0, i + 1))}>{t.name}</button></span>
                  ))}
                </>
              ) : (
                'Everything in "Other"'
              )}
            </b>
            <span className="muted">{human(shown.reduce((n, e) => n + e.bytes, 0))}</span>
          </div>
          <div className="tiny muted">Click a folder to look inside it. Hidden folders (starting with a dot) are included.</div>
          {loadingKids && <div className="tiny muted">Measuring…</div>}
          <div className="dlist">
            {shown.map((e) => (
              <div key={e.id} className={`drow ${e.isDir ? 'dir' : ''}`} onClick={() => open(e)}>
                <span className="dname">{e.isDir ? '📁' : '📄'} {e.name}</span>
                <span className="dbar"><i style={{ width: `${Math.max(1, (e.bytes / shownTotal) * 100)}%` }} /></span>
                <span className="dsize">{human(e.bytes)}</span>
                {!e.id.startsWith('system:') && (
                  <button className="link" onClick={(ev: { stopPropagation(): void }) => { ev.stopPropagation(); void window.cleaner.diskReveal(e.id); }}>Show</button>
                )}
              </div>
            ))}
            {shown.length === 0 && <div className="muted">Nothing here, or macOS did not let me look.</div>}
          </div>
          <div className="tiny muted">
            "Show" opens Finder. To remove things safely with reasons, use <button className="link" onClick={onClean}>Clean up junk</button>.
            The last line is space macOS keeps for itself. I cannot list it.
          </div>
        </section>
      )}

      <div className="grid2">
        <section className="glass tile">
          <div className="tilehead">🩺 <b>Drive status</b><span className="tr">{info.driveStatus ?? 'Unknown'}</span></div>
          <div className="muted tiny">
            {info.driveStatus && /verified/i.test(info.driveStatus)
              ? 'macOS checked the drive and it reports no problems.'
              : 'macOS did not give a clear answer for this drive.'}
          </div>
        </section>
        <section className="glass tile">
          <div className="tilehead">🗑 <b>Trash</b></div>
          <div className="bar2"><i style={{ width: `${trashPct}%` }} className={trashPct > 60 ? 'hot' : ''} /></div>
          <div className="tiny">
            {trash === null ? '…' : trash.items === 0 ? 'Empty' : trash.bytes !== null ? `Used: ${gb2(trash.bytes)}` : `${trash.items} items`}
          </div>
          {trashMsg && <div className="tiny muted">{trashMsg}</div>}
          <div className="tilefoot"><button className="link" onClick={emptyTrash} disabled={trash?.items === 0}>Free Up</button></div>
        </section>
      </div>
    </div>
  );
}
