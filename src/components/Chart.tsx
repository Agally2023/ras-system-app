import { useRef, useState } from 'react'
import { LIM0, type Lim } from '../lib/standards'
import type { Attr, Pt, Range } from '../lib/series'

// Shared graph card used by the Dashboard and SCADA. Draws the line, the lowest-to-highest band, the standards,
// breaches, gaps where readings are missing, and a hover read-out.
export const JAR_TARGET = 4.28
export const f = (x: number, d: number) => (Number.isFinite(x) ? x.toFixed(d) : '-')
export const limOf = (a: Attr): Lim | undefined => {
  if (!a.lim) return undefined
  if (a.id === 'jflow') { const l = LIM0.jflow; return [l[0] != null ? (l[0] / 100) * JAR_TARGET : undefined, l[1] != null ? (l[1] / 100) * JAR_TARGET : undefined] }
  return LIM0[a.lim]
}
export const limTxt = (l: Lim | undefined, d: number) => (!l || (l[0] == null && l[1] == null) ? 'no standard' : l[0] != null && l[1] != null ? `${f(l[0], d)} to ${f(l[1], d)}` : l[1] != null ? (l[1] === 0 ? 'none allowed' : `max ${f(l[1], d)}`) : `min ${f(l[0]!, d)}`)
// A limit of 0 means none detected: a value that rounds to 0 on the graph is not a breach.
export const outside = (v: number, l?: Lim, dec = 2) => !!l && ((l[0] != null && v < l[0]) || (l[1] != null && v > l[1] + (l[1] === 0 ? 0.5 * Math.pow(10, -dec) : 0)))


export const CHART_CSS = `
@keyframes dk{50%{opacity:.3}}
.dk-card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:grid;gap:4px}
.dk-card.b{border-color:var(--bad)}.dk-card.w{border-color:var(--warn)}
.dk-h{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.dk-h h3{margin:0;font-size:14px}
.dk-v{font-size:22px;font-weight:700}.dk-v small{font-size:12px;color:var(--mute);font-weight:400}
.dk-chip{font-size:11px;font-weight:700;padding:1px 7px;border-radius:4px;color:#fff;background:var(--ok)}.dk-chip.b{background:var(--bad)}
.dk-m{font-size:12px;color:var(--mute);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.dk svg{width:100%;height:auto;display:block;touch-action:none}`

export function Chart({ a, pts, range, tag }: { a: Attr; pts: Pt[]; range: Range; tag: string }) {
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

