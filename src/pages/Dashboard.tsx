import { useEffect, useMemo, useState } from 'react'
import { Chart, CHART_CSS, limOf, outside, f } from '../components/Chart'
import { ATTRS, RANGES, series, tagOf, type Attr, type Pt, type Range } from '../lib/series'
import { fetchSeries, hasReadings } from '../lib/readings'
import { useSystem } from '../lib/useSystem'
import { SoundToggle, useAlarmSound } from '../lib/alarmSound'
import { GatewayBadge } from '../lib/gateway'

// Live dashboard: one graph for every attribute on the HMI (whole-RAS water quality, pump and supply, the selected
// line, the selected jar), at live, hourly, daily, weekly (ISO weeks), monthly and yearly resolution.
// Standards are drawn on each graph. Once the PLC gateway has written readings the graphs show them; until then
// they come from a simulation and are marked as such.

const LINES = ['1-A', '1-B', '2-A', '2-B', '3-A', '3-B'], JARS = 18
const CSS = `
@keyframes dk{50%{opacity:.3}}
.dk-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.dk-live{display:inline-flex;align-items:center;gap:6px;font-weight:600}.dk-live i{width:9px;height:9px;border-radius:50%;background:var(--ok);animation:dk 1.4s infinite}.dk-live.p i{background:var(--mute);animation:none}
.dk-sim{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--warn);color:var(--warn)}
.dk-sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.dk-sum div{background:var(--panel);border-radius:8px;padding:8px 12px}.dk-sum b{display:block;font-size:22px}.dk-sum span{color:var(--mute);font-size:12px}
.dk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:10px}
.dk h2.sec{margin:18px 0 8px;font-size:17px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
`

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
  const outList = ATTRS.filter(a => a.lim && Number.isFinite(lastV(a.id)) && outside(lastV(a.id), limOf(a), a.dec))
  const outNow = outList.length, outKey = outList.map(a => a.id).join(',')
  const [silenced, setSilenced] = useState('')
  useEffect(() => { if (!outKey) setSilenced('') }, [outKey])
  const sounding = useAlarmSound(outNow > 0 && silenced !== outKey, outNow >= 3)
  const total = lastV('ptot')
  const rinfo = RANGES.find(r => r.k === range)!
  const sec = (s: Attr['scope']) => ATTRS.filter(a => a.scope === s).map(a => <Chart key={a.id + range + (s === 'line' ? line : s === 'jar' ? line + jar : '')} a={a} pts={data[a.id] ?? []} range={range} tag={tagOf(a, ctx)} />)
  const upd = new Date(plc && realAt ? realAt : now)

  return (
    <div className="dk">
      <style>{CHART_CSS}{CSS}</style>
      <div className="panel">
        <div className="dk-bar">
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map(r => <button key={r.k} className={range === r.k ? 'on' : ''} title={r.title} onClick={() => setRange(r.k)}>{r.label}</button>)}
          </div>
          <span className={`dk-live ${paused ? 'p' : ''}`}><i />{paused ? 'Paused' : 'Live'} · {upd.toLocaleTimeString()}</span>
          <button className="ghost" onClick={() => setPaused(p => !p)}>{paused ? 'Resume' : 'Pause'}</button>
          <SoundToggle />
          {sounding && <button style={{ background: 'var(--bad)', borderColor: 'var(--bad)', color: '#fff' }} onClick={() => setSilenced(outKey)}>Silence alarm</button>}
          <GatewayBadge />
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
