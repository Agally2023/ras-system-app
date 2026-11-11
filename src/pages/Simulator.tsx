import { useEffect, useMemo, useRef, useState } from 'react'
import { useSystem } from '../lib/useSystem'
import { expand, jarModel, qFor, Settings, status, stageMult } from '../lib/model'

// Port of the "Plumbing and water flow" simulator from McDonald_jar_flow_dashboard.html.
// Four jars share one header and one pump. Valve openings set each jar's flow.

const N = 4, NE = 100, BOT = 322, YS = 196
const CX = [85, 255, 425, 595]
const hwf = (y: number) => (y <= 290 ? 45 : 45 - (29 * (y - 290)) / 32)
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-')

const DEFAULTS: Settings = {
  pump_shutoff_head_m: 3, pump_free_flow_lpm: 60, valve_capacity_lpm_per_rm: 12,
  line_head_m: 2, header_diameter_mm: 50, jar_spacing_m: 0.25,
  egg_diameter_mm: 2, egg_density_kg_m3: 1050, water_temp_c: 29,
  max_egg_mass_g: 1200, target_bed_expansion: 1.3, stage34_flow_boost_pct: 10,
}
type Geom = { D: number; dp: number; Hs: number; m: number; st: number; h0: number }
const GEOM: Geom[] = [1, 2, 3, 4].map(st => ({ D: 12, dp: 20, Hs: 50, m: 1200, st, h0: 16.8 }))

// Pump on a shared header: total flow from the pump curve, split by valve conductance.
function hyd(open: number[], s: Settings) {
  const G = s.valve_capacity_lpm_per_rm, H0 = s.pump_shutoff_head_m, Qm = s.pump_free_flow_lpm
  const gi = open.map(o => G * Math.pow(o / 100, 1.5))
  const Sg = gi.reduce((a, b) => a + b, 0)
  const Qt = Sg > 1e-9 ? Math.sqrt(H0 / (1 / (Sg * Sg) + H0 / (Qm * Qm))) : 0
  return { Qt, H: H0 * (1 - Math.pow(Qt / Qm, 2)), Q: gi.map(x => (Sg > 1e-9 ? (x * Qt) / Sg : 0)) }
}

type Eggs = { f: number; x: number; y: number; vx: number; vy: number; m: number; ph: number }
type JS = { Hb: number; T: number; r: number; lost: number; eggs: Eggs[]; bub: any[]; drops: any[]; bc: number; st: [string, string]; Q: number; washout?: boolean }
const newJar = (i: number): JS => {
  const eggs: Eggs[] = []
  for (let k = 0; k < NE; k++) {
    const fr = Math.random()
    eggs.push({ f: fr, x: CX[i] + (Math.random() * 2 - 1) * 36, y: BOT - 4 - fr * 50, vx: 0, vy: 0, m: 0, ph: Math.random() * 6.28 })
  }
  return { Hb: 60, T: 0, r: 1, lost: 0, eggs, bub: [], drops: [], bc: 0, st: ['', 'ok'], Q: 0 }
}

function jarSVG(i: number, Q: number, Mj: any, x: any, Hs: number, col: string, o: number) {
  const cx = CX[i], bot = BOT, yS = YS, sc = (bot - yS) / Hs
  const d = Math.max(0.25, Math.min(3, 3 / Math.max(Q, 0.2)))
  const sh = `M${cx - 45} 170 L${cx - 45} 290 L${cx - 16} 322 L${cx + 16} 322 L${cx + 45} 290 L${cx + 45} 170`
  let s = `<polygon points="${cx - 45},${yS} ${cx + 45},${yS} ${cx + 45},290 ${cx + 16},322 ${cx - 16},322 ${cx - 45},290" fill="var(--water)" opacity=".7"/><path d="${sh}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round"/>`
  s += `<line x1="${cx - 45}" x2="${cx + 45}" y1="${bot - Mj.H0 * sc}" y2="${bot - Mj.H0 * sc}" stroke="var(--mute)" stroke-dasharray="3 3" stroke-width="1"/>`
  s += `<rect x="${cx - 5}" y="78" width="10" height="232" fill="var(--pipe)" stroke="var(--acc)" stroke-width="1"/>`
  if (Q > 0.02) s += `<line class="fl" style="--d:${d}s" x1="${cx}" x2="${cx}" y1="82" y2="308" stroke="var(--flow)" stroke-width="3" stroke-dasharray="6 8"/>`
  s += `<circle cx="${cx}" cy="86" r="4" fill="var(--acc)"/><circle cx="${cx}" cy="116" r="14" fill="var(--card)" stroke="var(--ink)" stroke-width="1.5"/><line x1="${cx}" x2="${cx}" y1="98" y2="134" stroke="${o > 0 ? 'var(--acc)' : 'var(--bad)'}" stroke-width="5" stroke-linecap="round" transform="rotate(${((1 - o / 100) * 90).toFixed(0)} ${cx} 116)"/><text x="${cx + 20}" y="120" font-size="12" font-weight="600" fill="var(--ink)">${o}%</text>`
  s += `<polygon points="${cx + 45},${yS - 6} ${cx + 64},${yS - 6} ${cx + 58},${yS + 4} ${cx + 45},${yS + 4}" fill="var(--panel)" stroke="var(--ink)" stroke-width="1"/>`
  if (Q > 0.02) s += `<line class="fl" style="--d:${d}s" x1="${cx + 58}" x2="${cx + 58}" y1="${yS + 6}" y2="410" stroke="var(--flow)" stroke-width="${Math.min(5, 1 + Q * 0.7).toFixed(1)}" stroke-dasharray="6 8"/>`
  s += `<path d="M${cx - 48} 350 L${cx - 38} 414 L${cx + 62} 414 L${cx + 72} 350" fill="none" stroke="var(--ink)" stroke-width="1.5" stroke-linejoin="round"/><line x1="${cx - 43}" x2="${cx - 35}" y1="382" y2="382" stroke="var(--ink)"/><text x="${cx - 46}" y="385" text-anchor="end" font-size="10" fill="var(--mute)">5 L</text><text x="${cx - 52}" y="353" text-anchor="end" font-size="10" fill="var(--mute)">10 L</text>`
  s += `<text x="${cx}" y="160" text-anchor="middle" font-size="13" font-weight="600" fill="var(--ink)">Jar ${i + 1}</text><text x="${cx}" y="452" text-anchor="middle" font-size="12" font-weight="600" fill="var(--${col})">${f(Q)} L/min</text>`
  return s
}

export default function Simulator() {
  const { settings } = useSystem()
  const [cfg, setCfg] = useState<Settings>(DEFAULTS)
  const [geom, setGeom] = useState<Geom[]>(GEOM)
  const [open, setOpen] = useState<number[]>([45, 45, 45, 45])
  const [R, setR] = useState(1.3)
  const [msg, setMsg] = useState('Drag a valve slider under any jar, type a flow in L/min, or auto-tune every valve to the target. Valves share one header, so opening one lowers the flow in the others.')
  const [spd, setSpd] = useState(10)
  const [live, setLive] = useState<{ lost: number; st: [string, string] }[]>(() => Array(N).fill({ lost: 0, st: ['', 'ok'] }))
  const [bk, setBk] = useState<{ vol: number; el: number; sp: number }[]>(() => Array(N).fill({ vol: 0, el: 0, sp: 0 }))

  // Load the real system's settings once they arrive.
  useEffect(() => {
    if (settings) { setCfg({ ...DEFAULTS, ...settings }); setR(+settings.target_bed_expansion || 1.3) }
  }, [settings])

  const sim = useMemo(() => {
    const h = hyd(open, cfg)
    const jars = geom.map((g, i) => {
      const M = jarModel({ jar_diameter_cm: g.D, drop_pipe_id_mm: g.dp, egg_mass_g: g.m, settled_height_cm: g.h0 }, cfg)
      const Q = h.Q[i], u = (Q * 1000) / 60 / M.A, x = expand(u, M)
      return { M, Q, u, x, st: status(Q, M, x, g.Hs, cfg.max_egg_mass_g), Hs: g.Hs }
    })
    return { h, jars }
  }, [open, geom, cfg])

  // ---- animation state lives in refs so the 60 fps loop never triggers React renders
  const J = useRef<JS[]>([])
  if (!J.current.length) J.current = [0, 1, 2, 3].map(newJar)
  const BK = useRef([0, 1, 2, 3].map(() => ({ run: true, el: 0, vol: 0, sp: 0 })))
  const spdRef = useRef(spd); spdRef.current = spd
  const box = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    sim.jars.forEach((o, i) => {
      const j = J.current[i], Hs = o.Hs
      j.washout = o.x.r === Infinity
      j.T = j.washout ? 1 : Math.max(0, Math.min(1, (o.u / o.M.ut - 0.17) / 0.35))
      j.r = j.washout ? 9 : o.x.r
      j.Hb = Math.min((j.r * o.M.H0 * (BOT - YS)) / Hs, BOT - YS - 4)
      j.st = o.st; j.Q = o.Q
    })
  }, [sim])

  useEffect(() => {
    const c = cv.current, host = box.current
    if (!c || !host) return
    const c2 = c.getContext('2d')!
    const REDUCE = window.matchMedia('(prefers-reduced-motion:reduce)').matches
    let col = { egg: '#d98a1c', flow: '#2a8fbd', ink: '#10302f' }
    let tick = 0, last = performance.now(), raf = 0

    const fit = () => {
      const w = host.clientWidth, h = host.clientHeight, d = window.devicePixelRatio || 1
      if (!w || !h) return
      c.style.width = w + 'px'; c.style.height = h + 'px'; c.width = w * d; c.height = h * d
      c2.setTransform((d * w) / 680, 0, 0, (d * w) / 680, 0, 0)
    }
    const ro = new ResizeObserver(fit); ro.observe(host); fit()

    function step(dt: number, time: number) {
      for (let i = 0; i < N; i++) {
        const j = J.current[i], cx = CX[i], T = j.T, sc = Math.max(j.Hb - 6, 1)
        const gentle = j.washout ? 0 : Math.min(1, (j.r - 1) * 3)
        if (T > 0.05) {
          j.bc += T * 50 * dt
          while (j.bc >= 1) { j.bc--; j.bub.push({ x: cx + (Math.random() - 0.5) * 10, y: 314, vy: -(70 + Math.random() * 60), r: 1 + Math.random() * 2 }) }
        }
        j.bub = j.bub.filter(b => { b.y += b.vy * dt; b.x += (Math.random() - 0.5) * 40 * dt; return b.y > YS })
        j.drops = j.drops.filter(d => { d.vy += 420 * dt; d.x += d.vx * dt; d.y += d.vy * dt; return d.y < 350 && !(d.y > YS && Math.abs(d.x - cx) < 45) })
        for (const e of j.eggs) {
          if (e.m === 2) continue
          if (REDUCE) { e.m = 0; e.y = BOT - 4 - e.f * sc; continue }
          if (e.m === 1) { // airborne over the spout
            const px = e.x
            e.vy += 420 * dt; e.x += e.vx * dt; e.y += e.vy * dt
            const wasIn = Math.abs(px - cx) < 45, nowIn = Math.abs(e.x - cx) < 45
            if (wasIn && !nowIn && e.y > 170 && e.y < BOT && !(e.x > cx && e.y > YS - 6 && e.y < YS + 4)) { e.x = px; e.vx *= -0.4 }
            else if (nowIn && e.y >= YS && e.y < BOT) { e.m = 0; e.vy *= 0.3; e.vx *= 0.3 }
            else if (e.y >= 408) { e.x = Math.max(cx - 34, Math.min(cx + 58, e.x)); e.m = 2; e.y = 406 + Math.random() * 4; e.vx = e.vy = 0; j.lost++ }
            continue
          }
          const yT = BOT - 4 - e.f * sc, k = 20 * (1 - T) * (1 - T) + 0.4, dx = e.x - cx, adx = Math.abs(dx)
          const ay0 = k * (yT - e.y) - 4 * e.vy + 60 * gentle * Math.sin(time * 1.3 + e.ph) + (Math.random() - 0.5) * T * 2500
          const ax = -4 * e.vx + 14 * gentle * Math.sin(time * 1.7 + e.ph * 1.3) + (Math.random() - 0.5) * T * 2000
          let ay = ay0
          if (adx < 18) ay -= T * 300 * (1 - adx / 18); else if (adx > 26) ay += T * 70
          if (j.washout) ay -= 250
          e.vx += ax * dt; e.vy += ay * dt; e.x += e.vx * dt; e.y += e.vy * dt
          if (adx < 7.5 && e.y < 312) { e.x = cx + (dx < 0 ? -7.5 : 7.5); e.vx *= -0.3 }
          const hv = hwf(e.y) - 3
          if (e.x < cx - hv) { e.x = cx - hv; e.vx = Math.abs(e.vx) * 0.5 }
          if (e.x > cx + hv) { e.x = cx + hv; e.vx = -Math.abs(e.vx) * 0.5 }
          if (e.y > BOT - 3) { e.y = BOT - 3; e.vy = -Math.abs(e.vy) * 0.3 }
          if (e.y < YS + 1) {
            if (T > 0.3) {
              e.m = 1; e.vy = -(40 + T * 150 * Math.random()); e.vx = (Math.random() - 0.35) * 40 * T + (e.x > cx + 10 ? 15 : 0)
              for (let q = 0; q < 3; q++) j.drops.push({ x: e.x, y: YS, vx: (Math.random() - 0.5) * 50, vy: -(20 + Math.random() * 60) })
            } else { e.y = YS + 1; e.vy = Math.abs(e.vy) * 0.2 }
          }
        }
      }
    }

    function drawBucket(i: number, cx: number) {
      const b = BK.current[i], j = J.current[i]
      if (b.vol > 0) {
        const y = 414 - 6.4 * b.vol, k = ((414 - y) / 64) * 10
        c2.globalAlpha = 0.75; c2.fillStyle = col.flow
        c2.beginPath(); c2.moveTo(cx - 38 - k, y); c2.lineTo(cx + 62 + k, y); c2.lineTo(cx + 62, 414); c2.lineTo(cx - 38, 414); c2.fill()
        c2.globalAlpha = 1
      }
      if (b.vol >= 10 && j.Q > 0.02) {
        const off = (performance.now() / 25) % 14
        c2.globalAlpha = 0.5; c2.fillStyle = col.flow
        c2.beginPath(); c2.ellipse(cx + 12, 416, Math.min(75, 30 + b.sp * 3), 3, 0, 0, 6.283); c2.fill()
        c2.globalAlpha = 1; c2.strokeStyle = col.flow; c2.lineWidth = Math.min(4, 1.5 + j.Q * 0.4)
        c2.setLineDash([6, 8]); c2.lineDashOffset = -off
        c2.beginPath(); c2.moveTo(cx - 51, 352); c2.lineTo(cx - 41, 414); c2.moveTo(cx + 75, 352); c2.lineTo(cx + 65, 414); c2.stroke()
        c2.setLineDash([]); c2.lineDashOffset = 0
      }
      if (b.el > 0) {
        c2.font = '600 12px system-ui,sans-serif'; c2.fillStyle = b.vol >= 10 ? '#d9482f' : col.ink; c2.textAlign = 'center'
        c2.fillText(b.vol >= 10 ? `FULL, ${b.sp.toFixed(1)} L spilled` : `${b.vol.toFixed(1)} L in ${b.el.toFixed(0)} s`, cx + 12, 436)
        c2.textAlign = 'start'
      }
    }

    function draw(time: number) {
      c2.clearRect(0, 0, 680, 460)
      for (let i = 0; i < N; i++) {
        const j = J.current[i], cx = CX[i], T = j.T
        if (T > 0.05) {
          c2.globalAlpha = 0.18; c2.fillStyle = col.flow
          c2.beginPath(); c2.moveTo(cx - 3, 316); c2.lineTo(cx + 3, 316); c2.lineTo(cx + 8 + T * 30, 316 - (30 + T * 110)); c2.lineTo(cx - 8 - T * 30, 316 - (30 + T * 110)); c2.fill()
          c2.globalAlpha = 1; c2.strokeStyle = col.flow; c2.lineWidth = 2; c2.beginPath()
          for (let x = -45; x <= 45; x += 3) {
            const y = YS + Math.sin(x * 0.35 + time * 8) * T * 3 + Math.sin(x * 0.9 - time * 11) * T * 1.5
            if (x === -45) c2.moveTo(cx + x, y); else c2.lineTo(cx + x, y)
          }
          c2.stroke()
        }
        c2.strokeStyle = col.flow; c2.lineWidth = 1; c2.globalAlpha = 0.7
        for (const b of j.bub) { c2.beginPath(); c2.arc(b.x, b.y, b.r, 0, 6.283); c2.stroke() }
        c2.globalAlpha = 1; c2.fillStyle = col.flow
        for (const d of j.drops) { c2.beginPath(); c2.arc(d.x, d.y, 1.6, 0, 6.283); c2.fill() }
        drawBucket(i, cx)
        c2.fillStyle = col.egg
        for (const e of j.eggs) { c2.beginPath(); c2.arc(e.x, e.y, 2.6, 0, 6.283); c2.fill() }
      }
    }

    function frame(now: number) {
      const dt = Math.min(0.033, (now - last) / 1000); last = now; tick++
      if (tick % 90 === 1) {
        const s = getComputedStyle(document.documentElement)
        col = { egg: s.getPropertyValue('--egg').trim() || col.egg, flow: s.getPropertyValue('--flow').trim() || col.flow, ink: s.getPropertyValue('--ink').trim() || col.ink }
      }
      BK.current.forEach((b, k) => {
        if (!b.run) return
        const d = (J.current[k].Q * dt * spdRef.current) / 60
        b.el += dt * spdRef.current
        if (b.vol < 10) b.vol = Math.min(10, b.vol + d); else b.sp += d
      })
      step(dt, now / 1000); draw(now / 1000)
      if (tick % 10 === 0) {
        setLive(J.current.map(j => ({ lost: j.lost, st: j.T > 0.3 && j.lost > 0 ? ['Splashing out', 'bad'] : j.st } as any)))
        setBk(BK.current.map(b => ({ vol: b.vol, el: b.el, sp: b.sp })))
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])

  // ---- schematic (static SVG; the canvas above it draws eggs, bubbles and buckets)
  const svg = useMemo(() => {
    const { h, jars } = sim
    const dh = Math.max(0.25, Math.min(3, 3 / Math.max(h.Qt / 2, 0.2)))
    let s = `<svg viewBox="0 0 680 460" role="img" aria-label="Plumbing schematic of four egg jars fed from a shared header"><rect x="30" y="62" width="620" height="16" rx="3" fill="var(--pipe)" stroke="var(--acc)"/>`
    if (h.Qt > 0.02) s += `<line class="fl" style="--d:${dh}s" x1="40" x2="640" y1="70" y2="70" stroke="var(--flow)" stroke-width="3" stroke-dasharray="6 8"/>`
    s += `<rect x="20" y="4" width="160" height="42" rx="6" fill="var(--panel)" stroke="var(--acc)"/><text x="30" y="21" font-size="13" font-weight="600" fill="var(--ink)">RAS pump</text><text x="30" y="38" font-size="12" fill="var(--mute)">${f(h.Qt)} L/min at ${f(h.H, 1)} m</text><rect x="60" y="46" width="10" height="16" fill="var(--pipe)" stroke="var(--acc)"/>`
    jars.forEach((o, i) => { s += jarSVG(i, o.Q, o.M, o.x, o.Hs, o.st[1], open[i]) })
    return s + '</svg>'
  }, [sim, open])

  // ---- controls
  const setValve = (i: number, v: number) => setOpen(p => p.map((o, k) => (k === i ? v : o)))
  const setGeomF = (i: number, k: keyof Geom, v: number) => setGeom(p => p.map((g, n) => (n === i ? { ...g, [k]: v } : g)))
  const setCfgF = (k: keyof Settings, v: number) => setCfg(p => ({ ...p, [k]: v }))

  // Find the valve opening that gives jar i a chosen flow, with the other valves unchanged.
  function setFlow(i: number, q: number) {
    if (!(q >= 0)) return
    let lo = 0, hi = 100
    const at = (o: number) => hyd(open.map((x, k) => (k === i ? o : x)), cfg).Q[i]
    if (at(100) < q) { setValve(i, 100); setMsg(`Jar ${i + 1} cannot reach ${f(q)} L/min with the other valves as they are. Fully open it gives ${f(at(100))} L/min.`); return }
    for (let n = 0; n < 40; n++) { const mid = (lo + hi) / 2; if (at(mid) < q) lo = mid; else hi = mid }
    setValve(i, Math.round((lo + hi) / 2 * 10) / 10)
    setMsg(`Jar ${i + 1} valve set to give ${f(q)} L/min.`)
  }

  function auto() {
    const Qs = geom.map((g, i) => qFor(R, sim.jars[i].M) * stageMult(g.st, cfg.stage34_flow_boost_pct))
    const Qt = Qs.reduce((a, b) => a + b, 0), Qm = cfg.pump_free_flow_lpm, G = cfg.valve_capacity_lpm_per_rm
    if (Qt >= Qm * 0.995) { setOpen(open.map(() => 100)); setMsg(`Pump too small. ${N} jars need ${f(Qt, 1)} L/min but the pump gives at most ${f(Qm, 1)} L/min.`); return }
    const H = cfg.pump_shutoff_head_m * (1 - Math.pow(Qt / Qm, 2))
    const os = Qs.map(q => Math.pow(q / Math.sqrt(H) / G, 2 / 3) * 100)
    if (Math.max(...os) > 100) { setOpen(open.map(() => 100)); setMsg('Valves are too small for this flow even fully open. Use larger valves or a stronger pump.'); return }
    const r = os.map(Math.round); setOpen(r)
    setMsg(`Valves set from the target. Jar 1 needs ${f(Qs[0])} L/min at ${r[0]}% open. Confirm with a bucket test and by watching the eggs.`)
  }
  const resetBucket = (i: number) => { BK.current[i] = { run: true, el: 0, vol: 0, sp: 0 } }
  const refill = () => { J.current = [0, 1, 2, 3].map(newJar); BK.current.forEach((_, i) => resetBucket(i)) }

  const sum = sim.jars.reduce((a, o) => a + o.Q, 0)
  const inTarget = sim.jars.filter(o => o.st[1] === 'ok').length
  const bucketS = sum > 0.05 ? (60 * 10) / (sum / N) : NaN

  return (
    <>
      <div className="kpis">
        <div className="k"><span>Pump supply</span><b>{f(sim.h.Qt)}</b> <small>L/min</small></div>
        <div className="k"><span>Header head</span><b>{f(sim.h.H, 1)}</b> <small>m</small></div>
        <div className="k"><span>Jars in target range</span><b>{inTarget}</b> <small>of {N}</small></div>
        <div className="k"><span>10 L bucket (average jar)</span><b>{f(bucketS, 0)}</b> <small>s</small></div>
      </div>

      <div className="panel">
        <div className="row" style={{ alignItems: 'center', gap: 16 }}>
          <label style={{ flex: 1, minWidth: 200 }}><b>Target bed expansion: {f(R)}x</b>
            <input type="range" min={1.1} max={1.8} step={0.05} value={R} onChange={e => setR(+e.target.value)} /></label>
          <button onClick={auto}>Auto-tune all valves</button>
          <button className="ghost" onClick={() => { setOpen([100, 15, 15, 15]); setMsg('Surge test: Jar 1 wide open, the others nearly closed. Watch Jar 1 turn turbulent and throw eggs into its tray.') }}>Surge test</button>
          <button className="ghost" onClick={refill}>Refill eggs</button>
          <label>Bucket fill speed
            <select value={spd} onChange={e => setSpd(+e.target.value)}>
              <option value={1}>1x real time</option><option value={10}>10x</option><option value={30}>30x</option>
            </select></label>
        </div>
        <p className="note" role="status">{msg}</p>
      </div>

      <div className="panel">
        <h2>Plumbing and water flow</h2>
        <div ref={box} style={{ position: 'relative' }}>
          <div dangerouslySetInnerHTML={{ __html: svg }} />
          <canvas ref={cv} className="cv" />
        </div>
        <p className="note">Supply header, valve, drop pipe through the jar, egg bed, overflow spout, then a 10 L bucket under each jar that fills at the jar's modelled flow. Eggs tumble gently in the target range. At high flow the jet churns the whole jar and eggs splash over the spout.</p>
      </div>

      <div className="jars">
        {sim.jars.map((o, i) => {
          const c = live[i]?.st?.[1] || o.st[1]
          const Re = (o.M.rho * ((o.Q * 1000) / 60 / o.M.Ap / 100) * (geom[i].dp / 1000)) / o.M.mu
          return (
            <div className="j" key={i} style={{ borderTopColor: `var(--${c})` }}>
              <header><b>Jar {i + 1}</b><span className="chip" style={{ color: `var(--${c})` }}>{live[i]?.st?.[0] || o.st[0]}</span></header>
              <label className="chip" style={{ color: 'var(--mute)' }}>Valve opening {open[i]}%
                <input type="range" min={0} max={100} step={1} value={open[i]} onChange={e => setValve(i, +e.target.value)} /></label>
              <div className="q">{f(o.Q)} <small>L/min</small></div>
              <label className="chip" style={{ color: 'var(--mute)' }}>Set flow (L/min)
                <input type="number" min={0} step={0.1} placeholder={f(o.Q)} key={`${i}-${f(o.Q)}`}
                  onKeyDown={e => { if (e.key === 'Enter') setFlow(i, +e.currentTarget.value) }}
                  onBlur={e => { if (e.currentTarget.value !== '') { setFlow(i, +e.currentTarget.value); e.currentTarget.value = '' } }} /></label>
              <dl>
                <dt>Rise speed in jar</dt><dd>{f(o.u)} cm/s</dd>
                <dt>Speed in drop pipe</dt><dd>{f((o.Q * 1000) / 60 / o.M.Ap, 1)} cm/s</dd>
                <dt>Bed expansion</dt><dd>{o.x.r === Infinity ? 'washout' : f(o.x.r) + 'x'}</dd>
                <dt>Jet Reynolds number</dt><dd>{f(Re, 0)}</dd>
                <dt>Required for stage</dt><dd>{f(qFor(R, o.M) * stageMult(geom[i].st, cfg.stage34_flow_boost_pct))} L/min</dd>
                <dt>Eggs splashed into bucket</dt><dd>{live[i]?.lost ?? 0} of {NE}</dd>
              </dl>
              <div className="bt">
                <div>10 L bucket fills in <b>{o.Q > 0.02 ? f((60 * 10) / o.Q, 0) + ' s' : '-'}</b>
                  {bk[i] && bk[i].el > 0 ? <> · {f(bk[i].vol, 1)} L</> : null}</div>
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="ghost" onClick={() => { BK.current[i].run = !BK.current[i].run }}>Start / stop</button>
                  <button className="ghost" onClick={() => resetBucket(i)}>Reset</button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <details className="panel">
        <summary>Pump, valve, egg and jar settings (what-if, not saved)</summary>
        <div className="set">
          {([
            ['pump_shutoff_head_m', 'Pump shutoff head, m'], ['pump_free_flow_lpm', 'Pump free flow, L/min'],
            ['valve_capacity_lpm_per_rm', 'Valve capacity open, L/min per root m'], ['stage34_flow_boost_pct', 'Stage 3 and 4 flow increase, % (max 10)'],
            ['egg_diameter_mm', 'Egg diameter, mm'], ['egg_density_kg_m3', 'Egg density, kg/m3'],
            ['water_temp_c', 'Water temperature, C'], ['max_egg_mass_g', 'Maximum egg mass per jar, g'],
          ] as [keyof Settings, string][]).map(([k, label]) => (
            <label key={k}>{label}<input type="number" step="any" value={cfg[k]} onChange={e => setCfgF(k, +e.target.value)} /></label>
          ))}
        </div>
        <div className="sc" style={{ marginTop: 12 }}>
          <table className="tbl">
            <thead><tr><th>Per jar</th>{[1, 2, 3, 4].map(n => <th key={n}>Jar {n}</th>)}</tr></thead>
            <tbody>
              {([['D', 'Jar diameter at egg bed, cm'], ['dp', 'Feeder pipe ID, mm'], ['Hs', 'Water depth to spout, cm'], ['m', 'Egg mass, g'], ['st', 'Egg stage (1 to 4)'], ['h0', 'Settled egg height, cm']] as [keyof Geom, string][]).map(([k, label]) => (
                <tr key={k}><td>{label}</td>
                  {geom.map((g, i) => <td key={i}><input type="number" step="any" value={g[k]} onChange={e => setGeomF(i, k, +e.target.value)} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  )
}
