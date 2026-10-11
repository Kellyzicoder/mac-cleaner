import { useEffect, useRef, useState } from 'react';
import type { DashInfo, NetSpeed } from '../shared/types';
import { DiskView } from './DiskView';
import { ago, gb2, speed } from './format';

const REFRESH_MS = 15_000;
const NET_MS = 2_000;

export function Dashboard({ onScan, onClean }: { onScan: () => void; onClean: () => void }) {
  const [info, setInfo] = useState<DashInfo | null>(null);
  const [net, setNet] = useState<NetSpeed>({ downBytesPerSec: 0, upBytesPerSec: 0 });
  const [view, setView] = useState<'home' | 'disk'>('home');
  const [error, setError] = useState('');
  const [test, setTest] = useState<{ busy: boolean; text: string }>({ busy: false, text: '' });
  const [msg, setMsg] = useState('');
  const alive = useRef(true);

  async function refresh() {
    try {
      const i = await window.cleaner.dashInfo();
      if (alive.current) setInfo(i);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Could not read your Mac.');
    }
  }

  useEffect(() => {
    alive.current = true;
    void refresh();
    const a = setInterval(() => void refresh(), REFRESH_MS);
    const b = setInterval(() => {
      void window.cleaner.netSpeed().then((n) => alive.current && setNet(n)).catch(() => undefined);
    }, NET_MS);
    return () => {
      alive.current = false;
      clearInterval(a);
      clearInterval(b);
    };
  }, []);

  async function runTest() {
    setTest({ busy: true, text: 'Testing…' });
    const r = await window.cleaner.speedTest();
    setTest({ busy: false, text: r.ok ? `Download: ${speed(r.bytesPerSec)} (${((r.bytesPerSec * 8) / 1_000_000).toFixed(0)} Mbit/s)` : r.message });
  }

  async function eject(id: string) {
    const r = await window.cleaner.eject(id);
    setMsg(r.message);
    void refresh();
  }

  if (error && !info) return <div className="banner error">{error}</div>;
  if (!info) {
    return (
      <div className="empty">
        <div className="spinner" />
        <p>Reading your Mac…</p>
      </div>
    );
  }
  if (view === 'disk') return <DiskView info={info} onBack={() => setView('home')} onClean={onClean} />;

  const availPct = (info.disk.availableBytes / info.disk.totalBytes) * 100;
  const b = info.battery;
  const mem = info.memoryPressure;
  const levelWord = info.health.level === 'good' ? 'Good' : info.health.level === 'okay' ? 'Okay' : 'Needs care';
  const secOn = info.security.filter((s) => s.on === true).length;
  const stale = info.lastScanAt === null || Date.now() - info.lastScanAt > 14 * 86_400_000;

  return (
    <div className="dash">
      <section className="glass hero">
        <div>
          <h2 className="herotitle">
            Mac Health: <span className={`level ${info.health.level}`}>{levelWord}</span>
          </h2>
          <div className="muted">{info.model}</div>
          {info.health.reasons.map((r) => (
            <div key={r} className="reason">• {r}</div>
          ))}
        </div>
        <div className="laptop" aria-hidden="true">💻</div>
      </section>

      <section className="glass">
        <div className="cardrow">
          <b>Mac security settings</b>
          <span className="muted">{secOn} of {info.security.length} on</span>
        </div>
        <div className="chips">
          {info.security.map((s) => (
            <span key={s.label} className={`chip ${s.on === true ? 'yes' : s.on === false ? 'no' : 'unk'}`} title={s.note}>
              {s.on === true ? '✓' : s.on === false ? '✗' : '?'} {s.label}
            </span>
          ))}
        </div>
        <div className="tiny muted">These are macOS settings that I can read. This app is not a virus scanner.</div>
      </section>

      <div className="grid2">
        <button className="glass tile" onClick={() => setView('disk')}>
          <div className="tilehead">💽 <b>Macintosh HD</b></div>
          <div className={availPct < 15 ? 'warnText' : 'okText'}>Available: {gb2(info.disk.availableBytes)}</div>
          <div className="tilefoot"><span className="link">See what uses it</span></div>
        </button>

        <div className="glass tile">
          <div className="tilehead">🧠 <b>Memory</b></div>
          <div>Pressure: {mem === null ? 'unknown' : `${mem}%`}</div>
          <div className="bar2"><i style={{ width: `${mem ?? 0}%` }} className={mem !== null && mem >= 85 ? 'hot' : ''} /></div>
        </div>

        <div className="glass tile">
          <div className="tilehead">🔋 <b>Battery</b>
            {b.present && b.percent !== null && <span className={`tr ${b.percent <= 20 && !b.pluggedIn ? 'warnText' : ''}`}>{b.percent}%</span>}
          </div>
          {!b.present ? <div>No battery in this Mac.</div> : (
            <>
              <div>{b.charging ? 'Charging' : b.pluggedIn ? 'Plugged in' : b.remaining ? `${b.remaining.replace(':', 'h ')}m remaining` : 'On battery'}</div>
              <div className="tiny muted">
                {b.healthPercent !== null ? `Health ${b.healthPercent}%` : ''}
                {b.cycles !== null ? ` · ${b.cycles} charge cycles` : ''}
                {b.condition ? ` · ${b.condition}` : ''}
              </div>
            </>
          )}
        </div>

        <div className="glass tile">
          <div className="tilehead">⚙️ <b>CPU</b><span className="tr">Load: {info.cpuLoadPercent}%</span></div>
          <div className="bar2"><i style={{ width: `${info.cpuLoadPercent}%` }} /></div>
          <div className="tiny muted">I cannot read the chip temperature. macOS only allows that with admin rights.</div>
        </div>

        <div className="glass tile">
          <div className="tilehead">📶 <b>Wi-Fi</b></div>
          <div>↑ {speed(net.upBytesPerSec)}</div>
          <div>↓ {speed(net.downBytesPerSec)}</div>
          <div className="tilefoot">
            {test.text && <span className="tiny muted">{test.text}</span>}
            <button className="link" onClick={runTest} disabled={test.busy}>Test Speed</button>
          </div>
        </div>

        <div className="glass tile">
          <div className="tilehead"><b>Connected Devices</b></div>
          {info.devices.length === 0 && <div className="muted">No drives plugged in.</div>}
          {info.devices.map((d) => (
            <div key={d.id} className="devrow">
              <span>💾 {d.name}</span>
              <span className="tiny muted">{d.bytesFree !== null ? `${gb2(d.bytesFree)} free` : ''}</span>
              <button className="link" onClick={() => eject(d.id)} title="Eject">⏏</button>
            </div>
          ))}
          {msg && <div className="tiny muted">{msg}</div>}
        </div>
      </div>

      <h3 className="recohead">Today's Recommendation</h3>
      <section className="glass reco">
        <div className="recoicon" aria-hidden="true">✨</div>
        <div className="recotext">
          <b>{stale ? "It's time to care for your Mac!" : 'Your Mac was checked recently.'}</b>
          <div className="muted">
            Last junk scan: {ago(info.lastScanAt)}. {stale ? 'Run a scan to find junk and see why each item can go.' : 'You can scan again any time.'}
          </div>
        </div>
        <button className="primary" onClick={onScan}>Scan my Mac</button>
      </section>
    </div>
  );
}
