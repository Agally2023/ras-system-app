import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { canEdit, useAuth } from '../lib/auth'
import { useSystem } from '../lib/useSystem'
import { autoTune, computeJars, jarModel, Settings, solveLine } from '../lib/model'
import Hatchery3D, { type Line3 } from './Hatchery3D'

// Hatchery view: every jar drawn as it stands on the floor. One header pipe per line, a ball valve on each
// drop pipe, a clear McDonald jar with its egg bed, an overflow tray under each jar.
// Click a jar to adjust its valve or type a flow. The line head slider changes the flow of the whole line.

const DEFAULTS: Settings = {
  pump_shutoff_head_m: 3, pump_free_flow_lpm: 60, valve_capacity_lpm_per_rm: 12,
  line_head_m: 2, header_diameter_mm: 50, jar_spacing_m: 0.25,
  egg_diameter_mm: 2, egg_density_kg_m3: 1050, water_temp_c: 29,
  max_egg_mass_g: 1200, target_bed_expansion: 1.3, stage34_flow_boost_pct: 10,
}

// Same stage mix as the database seed (ras_seed_layout). Used when no system exists yet.
function demoJars(): any[] {
  const out: any[] = [], per = 18, a = Math.round(per * 0.5)
  for (let s = 1; s <= 3; s++) for (let l = 0; l < 2; l++) for (let k = 0; k < per; k++) {
    const stage = k < a / 2 ? 1 : k < a ? 2 : k < a + (per - a) / 2 ? 3 : 4
    out.push({ jar_id: `demo-${s}-${l}-${k}`, jar_code: `S${s}-${String.fromCharCode(65 + l)}-${k + 1}`, station: s,
      line: String.fromCharCode(65 + l), position: k + 1, stage, valve_open_pct: 40, is_on: true })
  }
  return out
}

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-')
const tone = (t: string) => `var(--${t})`

// geometry (SVG units = CSS pixels)
const P = 54, M0 = 30, H = 390, NE = 34
const SPOUT = 124, FLOOR = 262, HW = 17
const WATER_PX = FLOOR - SPOUT

type JP = { T: number; Hb: number; Q: number; washout: boolean; on: boolean }
type Egg = { f: number; x: number; y: number; vx: number; vy: number; m: number; ph: number }
type JS = { eggs: Egg[]; bub: { x: number; y: number; vy: number; r: number }[]; lost: number }

function newJS(cx: number): JS {
  const eggs: Egg[] = []
  for (let k = 0; k < NE; k++) {
    const fr = Math.random()
    eggs.push({ f: fr, x: cx + (Math.random() * 2 - 1) * (HW - 3), y: FLOOR - 3 - fr * 40, vx: 0, vy: 0, m: 0, ph: Math.random() * 6.28 })
  }
  return { eggs, bub: [], lost: 0 }
}

export default function Simulator() {
  const { system, settings } = useSystem()
  const { role } = useAuth()
  const [dbJars, setDbJars] = useState<any[] | null>(null)
  const [jars, setJars] = useState<any[]>(() => demoJars())
  const [saved, setSaved] = useState<any[]>([])
  const [lineKey, setLineKey] = useState('1-A')
  const [selPos, setSelPos] = useState(1)
  const [head, setHead] = useState<number | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'2d' | '3d'>('3d')

  const s: Settings = useMemo(() => {
    const base = { ...DEFAULTS, ...(settings ?? {}) } as Settings
    return head == null ? base : { ...base, line_head_m: head }
  }, [settings, head])
  const baseHead = ({ ...DEFAULTS, ...(settings ?? {}) } as Settings).line_head_m

  useEffect(() => {
    if (!system) return
    supabase.from('ras_jar_overview').select('*').eq('system_id', system.id)
      .order('station').order('line').order('position')
      .then(({ data }) => { if (data && data.length) { setDbJars(data); setJars(data); setSaved(data) } })
  }, [system])

  const isDemo = !dbJars
  const lines = useMemo(() => computeJars(jars, s), [jars, s])
  const cur = lines.find(l => l.key === lineKey) ?? lines[0]
  const rows = cur?.rows ?? []
  const n = rows.length
  const sel = Math.min(Math.max(selPos, 1), Math.max(n, 1)) - 1
  const W = M0 * 2 + n * P

  const all = lines.flatMap(l => l.rows)
  const total = all.reduce((a, r) => a + r.Q, 0)
  const active = all.filter(r => r.st[1] !== 'off').length
  const inTarget = all.filter(r => r.st[1] === 'ok').length

  // per-jar drawing data for the selected line
  const drawAll = useMemo(() => lines.map(l => l.rows.map(r => {
    const M = jarModel(r.jar, s), Hs = r.jar.spout_depth_cm ?? 50, sc = WATER_PX / Hs
    const wash = r.x.r === Infinity
    const T = !r.jar.is_on ? 0 : wash ? 1 : Math.max(0, Math.min(1, (r.u / M.ut - 0.17) / 0.35))
    const bedPx = Math.min((wash ? 9 : r.x.r) * M.H0 * sc, WATER_PX - 4)
    return { M, Hs, sc, T, wash, bedPx, settledPx: M.H0 * sc }
  })), [lines, s])
  const li = Math.max(0, lines.findIndex(l => l.key === cur?.key))
  const draw = drawAll[li] ?? []
  const lines3: Line3[] = useMemo(() => lines.map((l, k) => ({
    key: l.key, station: +l.key.split('-')[0], idx: l.key.split('-')[1].charCodeAt(0) - 65,
    jars: l.rows.map((r, i) => {
      const d = drawAll[k][i]
      return { Q: r.Q, T: d.T, bed: d.bedPx / d.sc / 100, settled: d.M.H0 / 100, water: d.Hs / 100, valve: +r.jar.valve_open_pct || 0,
        on: !!r.jar.is_on, tone: r.st[1], stage: r.jar.stage, wash: d.wash, code: r.jar.jar_code, status: r.st[0] }
    }),
  })), [lines, drawAll])

  // ---------- animation (refs so the loop never re-renders React)
  const wrap = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null)
  const JSr = useRef<JS[]>([]), JPr = useRef<JP[]>([])
  useEffect(() => {
    JSr.current = Array.from({ length: n }, (_, i) => newJS(M0 + P * (i + 0.5)))
  }, [n, lineKey])
  useEffect(() => {
    JPr.current = draw.map((d, i) => ({ T: d.T, Hb: d.bedPx, Q: rows[i].Q, washout: d.wash, on: !!rows[i].jar.is_on }))
  }, [draw, rows])
  const [lostN, setLostN] = useState<number[]>([])

  useEffect(() => {
    const c = cv.current
    if (!c || !n) return
    const c2 = c.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    c.width = W * dpr; c.height = H * dpr
    c2.setTransform(dpr, 0, 0, dpr, 0, 0)
    const REDUCE = window.matchMedia('(prefers-reduced-motion:reduce)').matches
    let eggCol = '#d98a1c', flowCol = '#2a8fbd', tick = 0, last = performance.now(), raf = 0

    function step(dt: number, time: number) {
      JSr.current.forEach((j, i) => {
        const p = JPr.current[i]; if (!p) return
        const cx = M0 + P * (i + 0.5), T = p.T, sc = Math.max(p.Hb - 5, 1)
        const gentle = p.washout ? 0 : Math.min(1, Math.max(0, (p.Hb / Math.max(1, 40)) - 0.8))
        if (T > 0.05) {
          if (Math.random() < T * 40 * dt) j.bub.push({ x: cx + (Math.random() - 0.5) * 6, y: FLOOR - 4, vy: -(50 + Math.random() * 40), r: 0.8 + Math.random() * 1.4 })
        }
        j.bub = j.bub.filter(b => { b.y += b.vy * dt; return b.y > SPOUT })
        for (const e of j.eggs) {
          if (e.m === 2) continue
          if (REDUCE) { e.m = 0; e.y = FLOOR - 3 - e.f * sc; continue }
          if (e.m === 1) {
            e.vy += 380 * dt; e.x += e.vx * dt; e.y += e.vy * dt
            if (e.y >= 300) { e.m = 2; e.x = Math.max(cx - 13, Math.min(cx + 13, e.x)); e.y = 298 + Math.random() * 4; e.vx = e.vy = 0; j.lost++ }
            continue
          }
          const yT = FLOOR - 3 - e.f * sc, k = 18 * (1 - T) * (1 - T) + 0.4, dx = e.x - cx, adx = Math.abs(dx)
          let ay = k * (yT - e.y) - 4 * e.vy + 40 * gentle * Math.sin(time * 1.3 + e.ph) + (Math.random() - 0.5) * T * 1600
          const ax = -4 * e.vx + 10 * gentle * Math.sin(time * 1.7 + e.ph * 1.3) + (Math.random() - 0.5) * T * 1200
          if (adx < 11) ay -= T * 200 * (1 - adx / 11); else if (adx > 12) ay += T * 50
          if (p.washout) ay -= 200
          e.vx += ax * dt; e.vy += ay * dt; e.x += e.vx * dt; e.y += e.vy * dt
          if (adx < 5 && e.y < FLOOR - 8) { e.x = cx + (dx < 0 ? -5 : 5); e.vx *= -0.3 }
          if (e.x < cx - (HW - 2)) { e.x = cx - (HW - 2); e.vx = Math.abs(e.vx) * 0.5 }
          if (e.x > cx + (HW - 2)) { e.x = cx + (HW - 2); e.vx = -Math.abs(e.vx) * 0.5 }
          if (e.y > FLOOR - 2) { e.y = FLOOR - 2; e.vy = -Math.abs(e.vy) * 0.3 }
          if (e.y < SPOUT + 2) {
            if (T > 0.3) { e.m = 1; e.x = cx + HW + 2; e.vx = 12 + Math.random() * 14; e.vy = -(20 + T * 70 * Math.random()) }
            else { e.y = SPOUT + 2; e.vy = Math.abs(e.vy) * 0.2 }
          }
        }
      })
    }

    function paint(time: number) {
      c2.clearRect(0, 0, W, H)
      JSr.current.forEach((j, i) => {
        const p = JPr.current[i]; if (!p) return
        const cx = M0 + P * (i + 0.5)
        if (p.T > 0.05) {
          c2.globalAlpha = 0.16; c2.fillStyle = flowCol
          c2.beginPath(); c2.moveTo(cx - 2, FLOOR); c2.lineTo(cx + 2, FLOOR); c2.lineTo(cx + 4 + p.T * 12, FLOOR - 30 - p.T * 70); c2.lineTo(cx - 4 - p.T * 12, FLOOR - 30 - p.T * 70); c2.fill()
          c2.globalAlpha = 1; c2.strokeStyle = flowCol; c2.lineWidth = 1.5; c2.beginPath()
          for (let x = -HW; x <= HW; x += 3) {
            const y = SPOUT + Math.sin(x * 0.4 + time * 8) * p.T * 2 + Math.sin(x * 0.9 - time * 11) * p.T
            if (x === -HW) c2.moveTo(cx + x, y); else c2.lineTo(cx + x, y)
          }
          c2.stroke()
        }
        c2.strokeStyle = flowCol; c2.lineWidth = 0.8; c2.globalAlpha = 0.7
        for (const b of j.bub) { c2.beginPath(); c2.arc(b.x, b.y, b.r, 0, 6.283); c2.stroke() }
        c2.globalAlpha = 1; c2.fillStyle = eggCol
        for (const e of j.eggs) { c2.beginPath(); c2.arc(e.x, e.y, 1.7, 0, 6.283); c2.fill() }
      })
    }

    function frame(now: number) {
      const dt = Math.min(0.033, (now - last) / 1000); last = now; tick++
      if (tick % 90 === 1) {
        const st = getComputedStyle(document.documentElement)
        eggCol = st.getPropertyValue('--egg').trim() || eggCol; flowCol = st.getPropertyValue('--flow').trim() || flowCol
      }
      step(dt, now / 1000); paint(now / 1000)
      if (tick % 15 === 0) setLostN(JSr.current.map(j => j.lost))
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [n, W, lineKey, view])

  // ---------- controls
  const setValve = (pos: number, v: number) =>
    setJars(p => p.map(j => (j.station + '-' + j.line === lineKey && j.position === pos ? { ...j, valve_open_pct: v } : j)))
  const setAllValves = (v: number) =>
    setJars(p => p.map(j => (j.station + '-' + j.line === lineKey ? { ...j, valve_open_pct: v } : j)))

  function setFlow(q: number) {
    if (!(q >= 0) || !rows.length) return
    const at = (o: number) => solveLine(rows.map((r, k) => (r.jar.is_on ? s.valve_capacity_lpm_per_rm * Math.pow((k === sel ? o : r.jar.valve_open_pct) / 100, 1.5) : 0)), s).Q[sel]
    const pos = rows[sel].jar.position
    if (at(100) < q) { setValve(pos, 100); setMsg(`This jar cannot reach ${f(q)} L/min with the line as it is. Fully open it gives ${f(at(100))} L/min. Raise the line head.`); return }
    let lo = 0, hi = 100
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (at(mid) < q) lo = mid; else hi = mid }
    setValve(pos, Math.round(((lo + hi) / 2) * 10) / 10); setMsg('')
  }

  function auto() {
    const opens = autoTune(rows, s)
    setJars(p => p.map(j => {
      if (j.station + '-' + j.line !== lineKey) return j
      const i = rows.findIndex(r => r.jar.jar_id === j.jar_id)
      return i >= 0 ? { ...j, valve_open_pct: opens[i] } : j
    }))
    setMsg(`Valves set so every jar on this line reaches its target flow at ${f(s.target_bed_expansion)}x expansion.`)
  }

  async function save() {
    setBusy(true)
    const res = await Promise.all(rows.map(r => supabase.from('ras_jars')
      .update({ valve_open_pct: r.jar.valve_open_pct, updated_at: new Date().toISOString() }).eq('id', r.jar.jar_id)))
    const bad = res.find(r => r.error)
    setMsg(bad ? `Could not save: ${bad.error!.message}` : 'Valve settings saved to the database.')
    if (!bad) setSaved(p => p.map(j => (j.station + '-' + j.line === lineKey ? jars.find(x => x.jar_id === j.jar_id) ?? j : j)))
    setBusy(false)
  }
  const reset = () => { setJars(isDemo ? demoJars() : saved); setHead(null); setMsg('Back to the saved settings.') }

  const r = rows[sel], d = draw[sel]
  const dirty = !isDemo && JSON.stringify(rows.map(x => x.jar.valve_open_pct)) !==
    JSON.stringify(saved.filter(j => j.station + '-' + j.line === lineKey).map(j => j.valve_open_pct))

  if (!n) return <p className="note">Loading the hatchery...</p>
  const [stn, lin] = cur.key.split('-')

  return (
    <>
      <div className="kpis">
        <div className="k"><span>Whole RAS</span><b>{f(total, 0)}</b> <small>L/min</small></div>
        <div className="k"><span>Line {cur.key}</span><b>{f(rows.reduce((a, x) => a + x.Q, 0), 1)}</b> <small>L/min</small></div>
        <div className="k"><span>Jars in target range</span><b>{inTarget}</b> <small>of {active}</small></div>
        <div className="k"><span>Line head</span><b>{f(s.line_head_m, 1)}</b> <small>m</small></div>
      </div>
      {isDemo && <p className="note">Showing the default layout (3 stations, 2 lines, 18 jars each). Once your system exists, its own jars and measurements appear here.</p>}

      <div className="panel">
        <h2>Floor plan: click a line</h2>
        <div className="plan">
          {lines.map(l => (
            <button key={l.key} className={'planrow' + (l.key === cur.key ? ' on' : '')} onClick={() => { setLineKey(l.key); setSelPos(1) }}
              aria-label={`Station ${l.key.split('-')[0]} line ${l.key.split('-')[1]}`}>
              <span className="pl">S{l.key.split('-')[0]} · {l.key.split('-')[1]}</span>
              <span className="pc">{l.rows.map(x => <i key={x.jar.jar_id} style={{ background: tone(x.st[1]) }} title={`${x.jar.jar_code}: ${x.st[0]}`} />)}</span>
              <span className="pq">{f(l.rows.reduce((a, x) => a + x.Q, 0), 0)} L/min</span>
            </button>
          ))}
        </div>
        <p className="note">Each square is one jar: green in target, amber too gentle or vigorous, red washout or bed still, grey off.</p>
      </div>

      <div className="panel">
        <div className="row" style={{ alignItems: 'center', gap: 14 }}>
          <h2 style={{ margin: 0, flex: 1 }}>Station {stn}, line {lin}</h2>
          <div className="seg" role="group" aria-label="View">
            <button className={view === '3d' ? 'on' : ''} aria-pressed={view === '3d'} onClick={() => setView('3d')}>3D view</button>
            <button className={view === '2d' ? 'on' : ''} aria-pressed={view === '2d'} onClick={() => setView('2d')}>2D elevation</button>
          </div>
          <label style={{ minWidth: 220 }}>Line head: {f(s.line_head_m, 1)} m (all jars)
            <input type="range" min={0.3} max={6} step={0.1} value={s.line_head_m} onChange={e => setHead(+e.target.value)} /></label>
          <label style={{ minWidth: 160 }}>All valves on this line
            <input type="range" min={0} max={100} step={1} value={Math.round(rows.reduce((a, x) => a + (+x.jar.valve_open_pct || 0), 0) / n)} onChange={e => setAllValves(+e.target.value)} /></label>
          <button className="ghost" onClick={auto}>Auto-set valves</button>
          <button className="ghost" onClick={reset}>Reset</button>
          {!isDemo && <button disabled={!canEdit(role) || busy || !dirty} onClick={save}>Save line</button>}
        </div>
        {msg && <p className="note" role="status">{msg}</p>}

        {view === '3d' ? (
          <Hatchery3D lines={lines3} selKey={cur.key} selPos={sel} spacing={Math.max(0.22, +s.jar_spacing_m || 0.25)}
            onSelect={(k, i) => { setLineKey(k); setSelPos(i + 1) }} />
        ) : (<>
        <div className="sc">
          <div ref={wrap} style={{ position: 'relative', width: W, height: H }}>
            <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Station ${stn} line ${lin}: ${n} jars on one header`}>
              <defs>
                <pattern id="stripe" width="6" height="14" patternUnits="userSpaceOnUse">
                  <rect width="6" height="14" fill="var(--ink)" /><rect y="0" width="6" height="5" fill="#e0902a" />
                </pattern>
              </defs>
              {/* header pipe */}
              <rect x={8} y={12} width={W - 16} height={18} rx={4} fill="var(--pipe)" stroke="var(--acc)" />
              {rows.reduce((a, x) => a + x.Q, 0) > 0.05 && <line className="fl" style={{ ['--d' as any]: '0.8s' }} x1={14} x2={W - 14} y1={21} y2={21} stroke="var(--flow)" strokeWidth={2.5} strokeDasharray="6 8" />}
              <text x={14} y={9} fontSize={10} fill="var(--mute)">Supply header, {f(s.line_head_m, 1)} m head</text>
              {/* drain channel */}
              <rect x={8} y={322} width={W - 16} height={12} rx={3} fill="var(--panel)" stroke="var(--line)" />
              <text x={14} y={346} fontSize={10} fill="var(--mute)">Drain to sump</text>

              {rows.map((row, i) => {
                const cx = M0 + P * (i + 0.5), dd = draw[i], on = !!row.jar.is_on, o = +row.jar.valve_open_pct || 0
                const Q = row.Q, sc = tone(row.st[1]), isSel = i === sel
                const fall = Math.max(0.25, Math.min(3, 3 / Math.max(Q, 0.2)))
                return (
                  <g key={row.jar.jar_id} role="button" tabIndex={0} aria-label={`Jar ${row.jar.jar_code}, ${f(Q)} litres per minute, ${row.st[0]}`}
                    onClick={() => setSelPos(row.jar.position)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelPos(row.jar.position) } }}
                    style={{ cursor: 'pointer', outline: 'none' }}>
                    {isSel && <rect x={cx - 27} y={34} width={54} height={H - 40} rx={8} fill="var(--acc)" opacity={0.08} stroke="var(--acc)" strokeWidth={1.5} />}
                    {/* tee and ball valve */}
                    <rect x={cx - 4} y={30} width={8} height={30} fill="var(--pipe)" stroke="var(--acc)" strokeWidth={0.8} />
                    <rect x={cx - 8} y={52} width={16} height={18} rx={3} fill="var(--card)" stroke="var(--ink)" strokeWidth={1.2} />
                    <line x1={cx} x2={cx} y1={38} y2={64} stroke={on ? (o > 0 ? '#d9322a' : 'var(--mute)') : 'var(--line)'} strokeWidth={4.5} strokeLinecap="round"
                      transform={`rotate(${((1 - o / 100) * 90).toFixed(0)} ${cx} 61)`} />
                    <text x={cx + 12} y={64} fontSize={9} fontWeight={600} fill="var(--ink)">{Math.round(o)}%</text>
                    {/* striped drop pipe */}
                    <rect x={cx - 4} y={70} width={8} height={FLOOR - 70 - 4} fill="url(#stripe)" stroke="var(--ink)" strokeWidth={0.8} opacity={on ? 1 : 0.45} />
                    {Q > 0.02 && <line className="fl" style={{ ['--d' as any]: `${fall}s` }} x1={cx} x2={cx} y1={72} y2={FLOOR - 8} stroke="var(--flow)" strokeWidth={1.6} strokeDasharray="5 7" />}
                    {/* jar: cap, clear body with water */}
                    <rect x={cx - HW - 4} y={SPOUT - 14} width={HW * 2 + 8} height={9} rx={3} fill="var(--card)" stroke="var(--ink)" strokeWidth={1.2} />
                    <path d={`M${cx - HW} ${SPOUT - 5} V${FLOOR - 8} Q${cx - HW} ${FLOOR + 4} ${cx - HW + 8} ${FLOOR + 4} H${cx + HW - 8} Q${cx + HW} ${FLOOR + 4} ${cx + HW} ${FLOOR - 8} V${SPOUT - 5}`}
                      fill="none" stroke="var(--ink)" strokeWidth={1.6} />
                    <rect x={cx - HW + 1} y={SPOUT} width={HW * 2 - 2} height={WATER_PX + 2} rx={6} fill="var(--water)" opacity={on ? 0.6 : 0.25} />
                    <rect x={cx - HW + 1} y={FLOOR - dd.bedPx} width={HW * 2 - 2} height={dd.bedPx + 2} rx={5} fill={sc} opacity={0.2} />
                    <line x1={cx - HW} x2={cx + HW} y1={FLOOR - dd.settledPx} y2={FLOOR - dd.settledPx} stroke="var(--mute)" strokeWidth={0.8} strokeDasharray="2 2" />
                    <line x1={cx - HW + 1} x2={cx + HW - 1} y1={FLOOR - dd.bedPx} y2={FLOOR - dd.bedPx} stroke={sc} strokeWidth={1.4} strokeDasharray="4 2" />
                    <text x={cx + 7} y={SPOUT - 20} fontSize={9} fill="var(--mute)">stage {row.jar.stage}</text>
                    {/* overflow lip and tray */}
                    <rect x={cx + HW - 1} y={SPOUT - 3} width={9} height={4} fill="var(--card)" stroke="var(--ink)" strokeWidth={1} />
                    {Q > 0.02 && <line className="fl" style={{ ['--d' as any]: `${fall}s` }} x1={cx + HW + 7} x2={cx + HW + 7} y1={SPOUT + 2} y2={296} stroke="var(--flow)" strokeWidth={Math.min(3.5, 1 + Q * 0.4)} strokeDasharray="5 7" />}
                    <path d={`M${cx - 26} 286 H${cx + 26} L${cx + 15} 314 H${cx - 15} Z`} fill="var(--panel)" stroke="var(--ink)" strokeWidth={1.1} />
                    {Q > 0.02 && <rect x={cx - 20} y={296} width={40} height={4} fill="var(--water)" opacity={0.8} />}
                    {/* status strip and labels */}
                    <rect x={cx - 18} y={352} width={36} height={4} rx={2} fill={sc} />
                    <text x={cx} y={369} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--ink)">{row.jar.position}</text>
                    <text x={cx} y={383} textAnchor="middle" fontSize={9} fill={sc}>{f(Q, 1)}</text>
                  </g>
                )
              })}
            </svg>
            <canvas ref={cv} style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, pointerEvents: 'none' }} />
          </div>
        </div>
        <p className="note">Numbers under each jar: position on the header, then flow in L/min. Dashed line in a jar is the settled egg height. In target the eggs tumble gently, too strong and they wash into the tray.</p>
        </>)}
      </div>

      {r && d && (
        <div className="panel">
          <div className="row" style={{ alignItems: 'center', gap: 12 }}>
            <button className="ghost" aria-label="Previous jar" disabled={sel === 0} onClick={() => setSelPos(r.jar.position - 1)}>&larr;</button>
            <h2 style={{ margin: 0 }}>Jar {r.jar.jar_code}</h2>
            <span className="chip" style={{ color: tone(r.st[1]) }}>{r.st[0]}</span>
            <button className="ghost" aria-label="Next jar" disabled={sel === n - 1} onClick={() => setSelPos(r.jar.position + 1)}>&rarr;</button>
          </div>
          <div className="insp">
            <label>Valve opening: <b>{Math.round(r.jar.valve_open_pct)}%</b>
              <input type="range" min={0} max={100} step={1} value={r.jar.valve_open_pct} onChange={e => setValve(r.jar.position, +e.target.value)} /></label>
            <label>Set flow, L/min
              <input type="number" min={0} step={0.1} placeholder={f(r.Q)} key={`${r.jar.jar_id}-${f(r.Q)}`}
                onKeyDown={e => { if (e.key === 'Enter') setFlow(+e.currentTarget.value) }}
                onBlur={e => { if (e.currentTarget.value !== '') { setFlow(+e.currentTarget.value); e.currentTarget.value = '' } }} /></label>
            <label className="chk"><input type="checkbox" checked={!!r.jar.is_on} onChange={e => setJars(p => p.map(j => (j.jar_id === r.jar.jar_id ? { ...j, is_on: e.target.checked } : j)))} /> Jar on</label>
          </div>
          <div className="dl4">
            <div><span>Flow</span><b>{f(r.Q)} L/min</b></div>
            <div><span>Target for stage {r.jar.stage}</span><b>{f(r.target)} L/min</b></div>
            <div><span>Rise speed in jar</span><b>{f(r.u)} cm/s</b></div>
            <div><span>Bed expansion</span><b>{r.x.r === Infinity ? 'washout' : f(r.x.r) + 'x'}</b></div>
            <div><span>Fluidised from / washout at</span><b>{f(d.M.umf * d.M.A * 0.06)} / {f(d.M.ut * d.M.A * 0.06)} L/min</b></div>
            {view === '2d' && <div><span>Eggs splashed into tray</span><b>{lostN[sel] ?? 0} of {NE}</b></div>}
          </div>
        </div>
      )}
    </>
  )
}
