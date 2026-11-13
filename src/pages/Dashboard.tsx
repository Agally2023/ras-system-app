import { useEffect, useMemo, useRef, useState } from 'react'
import { LIM0, type Lim } from '../lib/standards'
import { ATTRS, RANGES, series, tagOf, type Attr, type Pt, type Range } from '../lib/series'
import { fetchSeries, hasReadings } from '../lib/readings'
import { useSystem } from '../lib/useSystem'

// Live dashboard: one graph for every attribute on the HMI (whole-RAS water quality, pump and supply, the selected
// line, the selected jar), at live, hourly, daily, weekly (ISO weeks), monthly and yearly resolution.
// Standards are drawn on each graph. Once the PLC gateway has written readings the graphs show them; until then
// they come from a simulation and are marked as such.

const LINES = ['1-A', '1-B', '2-A', '2-B', '3-A', '3-B'], JARS = 18, JAR_TARGET = 4.28
const f = (x: number, d: number) => (Number.isFinite(x) ? x.toFixed(d) : '-')
const limOf = (a: Attr): Lim | undefined => {
  if (!a.lim) return undefined
  if (a.id === 'jflow') { const l = LIM0.jflow; return [l[0] != null ? (l[0] / 100) * JAR_TARGET : undefined, l[1] != null ? (l[1] / 100) * JAR_TARGET : undefined] }
  return LIM0[a.lim]
}
const limTxt = (l: Lim | undefined, d: number) => (!l || (l[0] == null && l[1] == null) ? 'no standard' : l[0] != null && l[1] != null ? `${f(l[0], d)} to ${f(l[1], d)}` : l[1] != null ? (l[1] === 0 ? 'none allowed' : `max ${f(l[1], d)}`) : `min ${f(l[0]!, d)}`)
// A limit of 0 means none detected: a value that rounds to 0 on the graph is not a breach.
const outside = (v: number, l?: Lim, dec = 2) => !!l && ((l[0] != null && v < l[0]) || (l[1] != null && v > l[1] + (l[1] === 0 ? 0.5 * Math.pow(10, -dec) : 0)))

const CSS = `
@keyframes dk{50%{opacity:.3}}
.dk-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.dk-live{display:inline-flex;align-items:center;gap:6px;font-weight:600}.dk-live i{width:9px;height:9px;border-radius:50%;background:var(--ok);animation:dk 1.4s infinite}.dk-live.p i{background:var(--mute);animation:none}
.dk-sim{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--warn);color:var(--warn)}
.dk-sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.dk-sum div{background:var(--panel);border-radius:8px;padding:8px 12px}.dk-sum b{display:block;font-size:22px}.dk-sum span{color:var(--mute);font-size:12px}
.dk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:10px}
.dk-card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:grid;gap:4px}
.dk-card.b{border-color:var(--bad)}.dk-card.w{border-color:var(--warn)}
.dk-h{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.dk-h h3{margin:0;font-size:14px}
.dk-v{font-size:22px;font-weight:700}.dk-v small{font-size:12px;color:var(--mute);font-weight:400}
.dk-chip{font-size:11px;font-weight:700;padding:1px 7px;border-radius:4px;color:#fff;background:var(--ok)}.dk-chip.b{background:var(--bad)}
.dk-m{font-size:12px;color:var(--mute);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.dk svg{width:100%;height:auto;display:block;touch-action:none}
.dk h2.sec{margin:18px 0 8px;font-size:17px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
`

function Chart({ a, pts, range, tag }: { a: Attr; pts: Pt[]; range: Range; tag: string }) {
  const [hov, setHov] = useState<number | null>(null)
  const ref = useRef<SVGSVGElement>(null)
  const W = 340, Hh = 140, L = 44, R = 12, T = 8, B = 22
  const ok = (p: Pt) => Number.isFinite(p.v)
  const valid = pts.filter(ok)
  if (valid.length === 0) {
    return (
      <div className="dk-card"><div className="dk-h"><h3>{a.label}</h3><small className="note">{tag}</small></div>
        <div className="dk-v">--- <small>{a.unit}</small></div><div className="dk-m"><span>No readings {range === 'live' ? 'in the last 10 minutes' : 'in this period'}</span></div></div>
    )
  }
  const lim = limOf(a), agg = range !== 'live'
  const lo = Math.min(...valid.map(p => p.lo), ...(lim ? [lim[0] ?? Infinity] : [])), hi = Math.max(...valid.map(p => p.hi), ...(lim ? [lim[1] ?? -Infinity] : []))
  const span = hi - lo || Math.max(0.1, Math.abs(hi) * 0.1), y0 = lo >= 0 ? Math.max(0, lo - span * 0.1) : lo - span * 0.1, y1 = hi + span * 0.1
  const X = (i: number) => L + (i / Math.max(1, pts.length - 1)) * (W - L - R)
  const Y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (Hh - T - B)
  const runs: number[][] = []
  let cur0: number[] = []
  pts.forEach((p, i) => { if (ok(p)) cur0.push(i); else if (cur0.length) { runs.push(cur0); cur0 = [] } })
  if (cur0.length) runs.push(cur0)
  const lineOf = (r: number[]) => r.map(i => `${X(i).toFixed(1)},${Y(pts[i].v).toFixed(1)}`).join(' ')
  const bandOf = (r: number[]) => r.map(i => `${X(i).toFixed(1)},${Y(pts[i].hi).toFixed(1)}`).join(' ') + ' ' + [...r].reverse().map(i => `${X(i).toFixed(1)},${Y(pts[i].lo).toFixed(1)}`).join(' ')
  const last = valid[valid.length - 1], cur = hov != null ? (ok(pts[hov]) ? pts[hov] : null) : last
  const bad = lim ? valid.filter(p => outside(p.v, lim, a.dec) || (agg && (outside(p.hi, lim, a.dec) || outside(p.lo, lim, a.dec)))).length : 0
  const nowBad = outside(last.v, lim, a.dec)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(k => Math.round(k * (pts.length - 1)))
  const mean = valid.reduce((s, p) => s + p.v, 0) / valid.length
  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * W
    setHov(Math.max(0, Math.min(pts.length - 1, Math.round(((x - L) / (W - L - R)) * (pts.length - 1)))))
  }
  const dec = a.dec
  return (
    <div className={`dk-card ${nowBad ? 'b' : bad ? 'w' : ''}`}>
      <div className="dk-h"><h3>{a.label}</h3><span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><small className="note">{tag}</small>{lim && <span className={`dk-chip ${nowBad ? 'b' : ''}`}>{nowBad ? (outside(last.v, [lim[0], undefined], a.dec) ? 'LOW' : 'HIGH') : 'OK'}</span>}</span></div>
      <div className="dk-v">{cur ? f(cur.v, dec) : '---'} <small>{a.unit}</small>{hov != null && <small> · {pts[hov].label}</small>}</div>
      <svg ref={ref} viewBox={`0 0 ${W} ${Hh}`} onPointerMove={move} onPointerLeave={() => setHov(null)} role="img" aria-label={`${a.label} graph`}>
        {[y0 + (y1 - y0) * 0.1, (y0 + y1) / 2, y1 - (y1 - y0) * 0.1].map((v, i) => (
          <g key={i}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="var(--line)" strokeWidth="1" /><text x={L - 4} y={Y(v) + 3} textAnchor="end" fontSize="9" fill="var(--mute)">{f(v, dec)}</text></g>
        ))}
        {lim && [lim[0], lim[1]].map((v, i) => v != null && (
          <g key={i}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="var(--warn)" strokeWidth="1.2" strokeDasharray="5 3" />
            <text x={W - R} y={Y(v) + (i === 1 ? -3 : 10)} textAnchor="end" fontSize="9" fill="var(--warn)">{i === 1 ? (v === 0 ? 'none allowed' : `max ${f(v, dec)}`) : `min ${f(v, dec)}`}</text></g>
        ))}
        {agg && runs.filter(r => r.length > 1).map((r, k) => <polygon key={k} points={bandOf(r)} fill="var(--flow)" opacity="0.16" />)}
        {runs.map((r, k) => r.length > 1 && <polyline key={k} points={lineOf(r)} fill="none" stroke="var(--flow)" strokeWidth="1.8" strokeLinejoin="round" />)}
        {agg && pts.length <= 30 && pts.map((p, i) => ok(p) && <circle key={i} cx={X(i)} cy={Y(p.v)} r={p.partial ? 3.4 : 2.2} fill={outside(p.v, lim, a.dec) ? 'var(--bad)' : outside(p.hi, lim, a.dec) || outside(p.lo, lim, a.dec) ? 'var(--warn)' : 'var(--flow)'} />)}
        {!agg && <circle cx={X(pts.lastIndexOf(last))} cy={Y(last.v)} r="3.5" fill={nowBad ? 'var(--bad)' : 'var(--flow)'} />}
        {ticks.map((i, k) => <text key={i} x={X(i)} y={Hh - 6} fontSize="9" fill="var(--mute)" textAnchor={k === 0 ? 'start' : k === ticks.length - 1 ? 'end' : 'middle'}>{pts[i].label}</text>)}
        {hov != null && cur && <g><line x1={X(hov)} x2={X(hov)} y1={T} y2={Hh - B} stroke="var(--mute)" strokeWidth="1" /><circle cx={X(hov)} cy={Y(cur.v)} r="4" fill="var(--acc)" /></g>}
      </svg>
      <div className="dk-m">
        <span>Standard: {limTxt(lim, dec)}</span>
        <span>{agg ? `avg ${f(mean, dec)} · min ${f(Math.min(...valid.map(p => p.lo)), dec)} · max ${f(Math.max(...valid.map(p => p.hi)), dec)}` : `avg ${f(mean, dec)}`}</span>
        {lim && <span style={{ color: bad ? 'var(--warn)' : undefined }}>{bad ? `${bad} of ${valid.length} ${agg ? 'periods' : 'readings'} outside` : 'all within standard'}</span>}
      </div>
    </div>
  )
}

export default function Dashboard() {
  const { system } = useSystem()
  const [plc, setPlc] = useState(false)
  const [real, setReal] = useState<Record<string, Pt[]> | null>(null)
  const [realAt, setRealAt] = useState(0)
  const [err, setErr] = useState('')
  const [range, setRange] = useState<Range>('live')
  const [line, setLine] = useState('1-A')
  const [jar, setJar] = useState(1)
  const [now, setNow] = useState(() => Date.now())
  const [paused, setPaused] = useState(false)
  useEffect(() => { if (paused) return; const i = setInterval(() => setNow(Date.now()), 2000); return () => clearInterval(i) }, [paused])

  const sysId = system?.id
  useEffect(() => { if (sysId) hasReadings().then(setPlc).catch(() => setPlc(false)) }, [sysId])
  const li = LINES.indexOf(line)
  const ctx = useMemo(() => ({ li, pos: jar }), [li, jar])
  useEffect(() => {
    if (!plc || !sysId) return
    let dead = false
    setReal(null)
    const load = async () => {
      const t = Date.now()
      try { const r = await fetchSeries(sysId, ATTRS, range, t, ctx); if (!dead) { setReal(r); setRealAt(t); setErr('') } }
      catch (e: any) { if (!dead) setErr(e?.message ?? String(e)) }
    }
    load()
    if (paused) return () => { dead = true }
    const i = setInterval(load, range === 'live' ? 5000 : 30000)
    return () => { dead = true; clearInterval(i) }
  }, [plc, sysId, range, ctx, paused])
  const key = range === 'live' ? now : Math.floor(now / 15000)
  const simData = useMemo(() => (plc ? null : Object.fromEntries(ATTRS.map(a => [a.id, series(a, range, now, ctx)]))), [plc, range, ctx, key])
  const data: Record<string, Pt[]> = plc ? real ?? {} : simData!
  const lastV = (id: string) => { const s = data[id] ?? []; for (let i = s.length - 1; i >= 0; i--) if (Number.isFinite(s[i].v)) return s[i].v; return NaN }
  const outNow = ATTRS.filter(a => a.lim && Number.isFinite(lastV(a.id)) && outside(lastV(a.id), limOf(a), a.dec)).length
  const total = lastV('ptot')
  const rinfo = RANGES.find(r => r.k === range)!
  const sec = (s: Attr['scope']) => ATTRS.filter(a => a.scope === s).map(a => <Chart key={a.id + range + (s === 'line' ? line : s === 'jar' ? line + jar : '')} a={a} pts={data[a.id] ?? []} range={range} tag={tagOf(a, ctx)} />)
  const upd = new Date(plc && realAt ? realAt : now)

  return (
    <div className="dk">
      <style>{CSS}</style>
      <div className="panel">
        <div className="dk-bar">
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map(r => <button key={r.k} className={range === r.k ? 'on' : ''} title={r.title} onClick={() => setRange(r.k)}>{r.label}</button>)}
          </div>
          <span className={`dk-live ${paused ? 'p' : ''}`}><i />{paused ? 'Paused' : 'Live'} · {upd.toLocaleTimeString()}</span>
          <button className="ghost" onClick={() => setPaused(p => !p)}>{paused ? 'Resume' : 'Pause'}</button>
          {plc ? <span className="dk-sim" style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }} title="Readings written by the PLC gateway">PLC data</span>
            : <span className="dk-sim" title="No PLC gateway is writing readings yet, so these graphs come from a model of the hatchery.">Simulated data</span>}
          {err && <span className="dk-sim" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }} title={err}>Read error</span>}
        </div>
        <div className="dk-bar">
          <label>Line <select value={line} onChange={e => setLine(e.target.value)}>{LINES.map(l => <option key={l} value={l}>Station {l.replace('-', ' line ')}</option>)}</select></label>
          <label>Jar <select value={jar} onChange={e => setJar(+e.target.value)}>{Array.from({ length: JARS }, (_, i) => <option key={i + 1} value={i + 1}>Jar {i + 1}</option>)}</select></label>
          <span className="note">{rinfo.title}. The shaded band is the lowest to highest reading in each period. Dashed lines are the standards.</span>
        </div>
        <div className="dk-sum">
          <div><b style={{ color: outNow ? 'var(--bad)' : 'var(--ok)' }}>{outNow}</b><span>graphs outside standard now</span></div>
          <div><b>{f(total, 0)}</b><span>L/min total supply now</span></div>
          <div><b>{ATTRS.length}</b><span>live graphs</span></div>
        </div>
      </div>
      <h2 className="sec">Whole RAS water quality</h2>
      <div className="dk-grid">{sec('ras')}</div>
      <h2 className="sec">Pump and supply</h2>
      <div className="dk-grid">{sec('pump')}</div>
      <h2 className="sec">Station {line.replace('-', ' line ')}</h2>
      <div className="dk-grid">{sec('line')}</div>
      <h2 className="sec">Jar {jar} on station {line.replace('-', ' line ')}</h2>
      <div className="dk-grid">{sec('jar')}</div>
    </div>
  )
}
