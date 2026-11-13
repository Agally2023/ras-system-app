import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useSystem } from '../lib/useSystem'
import { computeJars, Settings } from '../lib/model'
import { DEFAULTS, demoJars } from './Simulator'

// PLC and HMI connection view. Field sensors are wired (4-20 mA) to PLC input modules, the jar sensors reach the PLC
// over an RS-485 bus, and the PLC talks to the operator HMI over Ethernet. The HMI shows jar KPIs (flow, oxygen,
// pressure, temperature) and whole-RAS water quality (ammonia, hardness, pH, nitrite, nitrate) and raises alarms
// when a KPI leaves its limits. Values are simulated from the jar model; failures can be injected to test alarms.
// Assumed: egg oxygen uptake of 0.12 mg O2 per g eggs per hour at stage 1, rising to 2.2x at stage 4.

type Lim = [number | undefined, number | undefined]
type Tag = { tag: string; desc: string; io: 'AI' | 'AO' | 'DI' | 'DO' | 'BUS'; unit: string; lo: number; hi: number; alo?: number; ahi?: number; grp: string; addr: string; mod: string; ch: number; dec?: number }
type Rd = { v: number | null; mA: number | null; st: 'ok' | 'low' | 'high' | 'bad' }
type St = 'ok' | 'low' | 'high' | 'bad' | 'off'
type JK = { pos: number; on: boolean; Q: number | null; DO: number | null; P: number | null; T: number | null; target: number; s: { flow: St; DO: St; P: St; T: St } }
type Al = { id: string; text: string; val: string; st: 'low' | 'high' | 'bad'; src: string }

const GW = 250, PX = 440, PW = 200, ROW = 22, CH = 12, MOD_HEAD = 16, MOD_GAP = 8, TOP = 84, HMI_H = 740
const f = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '---' : x.toFixed(d))
const lname = (k: string) => k.replace('-', '')
const OUR0 = 0.12, STAGE_X = [1, 1.3, 1.7, 2.2]

const LIMDEF: { k: string; label: string; unit: string; std?: boolean }[] = [
  { k: 'nh3', label: 'Ammonia', unit: 'mg/L (ppm)', std: true }, { k: 'no2', label: 'Nitrite', unit: 'mg/L (ppm)', std: true },
  { k: 'no3', label: 'Nitrate', unit: 'mg/L (ppm)', std: true }, { k: 'alk', label: 'Alkalinity', unit: 'mg/L (ppm)', std: true },
  { k: 'turb', label: 'Turbidity', unit: 'NTU', std: true }, { k: 'cah', label: 'Calcium hardness', unit: 'mg/L (ppm)', std: true },
  { k: 'hard', label: 'Total hardness', unit: 'mg/L CaCO3' }, { k: 'ph', label: 'pH', unit: '' },
  { k: 'jflow', label: 'Jar flow', unit: '% of target' }, { k: 'jdo', label: 'Jar outlet oxygen', unit: 'mg/L' },
  { k: 'jp', label: 'Jar water pressure', unit: 'bar' }, { k: 'temp', label: 'Water temperature', unit: '°C' },
]
const LIM0: Record<string, Lim> = {
  nh3: [undefined, 0.25], no2: [undefined, 0], no3: [undefined, 0], alk: [undefined, 100], turb: [undefined, 15], cah: [undefined, 200],
  hard: [undefined, undefined], ph: [6.8, 8.2], jflow: [80, 120], jdo: [5, undefined], jp: [0.08, 0.6], temp: [26, 31],
}
const WQ = [
  { tag: 'AT-NH3', name: 'Ammonia', unit: 'mg/L', dec: 2, lim: 'nh3', rng: [0, 3], base: 0.12, fail: 2.6 },
  { tag: 'AT-NO2', name: 'Nitrite', unit: 'mg/L', dec: 2, lim: 'no2', rng: [0, 1.5], base: 0, fail: 1.3 },
  { tag: 'AT-NO3', name: 'Nitrate', unit: 'mg/L', dec: 1, lim: 'no3', rng: [0, 160], base: 0, fail: 135 },
  { tag: 'AT-PH', name: 'pH', unit: '', dec: 2, lim: 'ph', rng: [5.5, 9], base: 7.4, fail: 6.3 },
  { tag: 'AT-ALK', name: 'Alkalinity', unit: 'mg/L', dec: 0, lim: 'alk', rng: [0, 200], base: 80, fail: 160 },
  { tag: 'AT-TURB', name: 'Turbidity', unit: 'NTU', dec: 1, lim: 'turb', rng: [0, 50], base: 6, fail: 38 },
  { tag: 'AT-CAH', name: 'Calcium hardness', unit: 'mg/L', dec: 0, lim: 'cah', rng: [0, 300], base: 120, fail: 260 },
  { tag: 'AT-HARD', name: 'Total hardness', unit: 'mg/L CaCO3', dec: 0, lim: 'hard', rng: [0, 400], base: 150, fail: 150 },
]
const FAILS = [
  { k: 'nh3', label: 'Ammonia spike', tag: 'AT-NH3' }, { k: 'no2', label: 'Nitrite appears', tag: 'AT-NO2' }, { k: 'no3', label: 'Nitrate appears', tag: 'AT-NO3' },
  { k: 'ph', label: 'pH crash', tag: 'AT-PH' }, { k: 'alk', label: 'Alkalinity high', tag: 'AT-ALK' }, { k: 'turb', label: 'Turbid water', tag: 'AT-TURB' },
  { k: 'cah', label: 'Calcium hardness high', tag: 'AT-CAH' }, { k: 'heat', label: 'Water too warm' }, { k: 'lowdo', label: 'Low oxygen' }, { k: 'block', label: 'Jar S1-A #5 blocked' },
]

function buildTags(keys: string[], q: number, L: Record<string, Lim>, counts: Record<string, number>): Tag[] {
  const t: Tag[] = []
  let ai = 0
  const AI = (grp: string, tag: string, desc: string, unit: string, lo: number, hi: number, lim?: Lim | number[], dec = 1) => {
    t.push({ tag, desc, io: 'AI', unit, lo, hi, alo: lim?.[0], ahi: lim?.[1], grp, addr: `%IW${ai}`, mod: `AI-${Math.floor(ai / 8) + 1}`, ch: ai % 8, dec }); ai++
  }
  const dio = (grp: string, tag: string, desc: string, io: 'DI' | 'DO' | 'AO', addr: string) =>
    t.push({ tag, desc, io, unit: io === 'AO' ? '%' : '', lo: 0, hi: 100, grp, addr, mod: 'DIO', ch: 0 })
  const rt = keys.length * q
  AI('PUMP', 'PT-100', 'Pump discharge pressure', 'bar', 0, 4, [0.15, 1], 2)
  AI('PUMP', 'FT-100', 'Total supply flow', 'L/min', 0, 1000, [Math.round(0.8 * rt), Math.round(1.2 * rt)], 0)
  AI('PUMP', 'TT-100', 'Sump water temperature', 'C', 0, 50, L.temp)
  AI('PUMP', 'AT-100', 'Sump dissolved oxygen', 'mg/L', 0, 20, [L.jdo[0], 12])
  for (const k of keys) {
    const n = lname(k)
    AI(k, `PT-${n}`, `Line ${n} header pressure`, 'bar', 0, 2.5, L.jp, 2)
    AI(k, `FT-${n}`, `Line ${n} flow`, 'L/min', 0, 300, [Math.round(0.8 * q), Math.round(1.2 * q)], 0)
    AI(k, `TT-${n}`, `Line ${n} temperature`, 'C', 0, 50, L.temp)
    AI(k, `AT-${n}i`, `Line ${n} inlet dissolved oxygen`, 'mg/L', 0, 20, [6, 12])
    AI(k, `AT-${n}o`, `Line ${n} overflow dissolved oxygen`, 'mg/L', 0, 20, [L.jdo[0], 12])
  }
  for (const k of keys) AI(k, `ZT-${lname(k)}`, `Line ${lname(k)} mean valve position`, '%', 0, 100, undefined, 0)
  AI('WQ', 'AT-NH3', 'Ammonia', 'mg/L', 0, 10, L.nh3, 2)
  AI('WQ', 'AT-NO2', 'Nitrite', 'mg/L', 0, 5, L.no2, 2)
  AI('WQ', 'AT-NO3', 'Nitrate', 'mg/L', 0, 200, L.no3, 1)
  AI('WQ', 'AT-PH', 'pH', '', 0, 14, L.ph, 2)
  AI('WQ', 'AT-ALK', 'Alkalinity', 'mg/L', 0, 300, L.alk, 0)
  AI('WQ', 'AT-TURB', 'Turbidity', 'NTU', 0, 100, L.turb, 1)
  AI('WQ', 'AT-CAH', 'Calcium hardness', 'mg/L', 0, 500, L.cah, 0)
  AI('WQ', 'AT-HARD', 'Total water hardness', 'mg/L CaCO3', 0, 500, L.hard, 0)
  dio('PUMP', 'PUMP_RUN', 'Pump running feedback', 'DI', '%I0.0')
  dio('PUMP', 'PUMP_FAULT', 'Pump fault', 'DI', '%I0.1')
  dio('PUMP', 'SUMP_LOW', 'Sump low level', 'DI', '%I0.2')
  dio('PUMP', 'PUMP_CMD', 'Pump start command', 'DO', '%Q0.0')
  dio('PUMP', 'HORN', 'Alarm horn', 'DO', '%Q0.1')
  dio('PUMP', 'VFD_SPD', 'Pump drive speed', 'AO', '%QW0')
  let r = 0
  for (const x of t) if (x.mod === 'DIO') x.ch = r++
  keys.forEach((k, i) => t.push({ tag: `JAR-${lname(k)}`, desc: `Line ${lname(k)} jar sensor bus: flow, oxygen, pressure, temperature for ${counts[k] ?? 0} jars`, io: 'BUS', unit: '', lo: 0, hi: 0, grp: k, addr: `%MW${100 + i * 80}`, mod: 'BUS', ch: i }))
  return t
}

const CSS = `
@keyframes wd{to{stroke-dashoffset:-14}}@keyframes bl{50%{opacity:.35}}
.pw{fill:none;stroke-width:1.2;stroke-dasharray:5 4;animation:wd .9s linear infinite}
.pw.x{animation:none;stroke-dasharray:none}
.gsel{cursor:pointer}.gsel:hover rect.gb{stroke:var(--acc)}
.fch{display:flex;flex-wrap:wrap;gap:6px}.fch button.on{background:var(--bad);border-color:var(--bad);color:#fff}
.lim input{width:70px;padding:3px 6px}
.hmi{font:12px/1.3 system-ui,sans-serif;color:#d9eeee;background:#0a1819;height:100%;padding:8px;display:grid;grid-template-rows:auto auto auto minmax(0,1fr) auto;gap:6px;border-radius:6px}
.hmi button{font:700 11px system-ui;border:1px solid #2f5c5c;background:#16393a;color:#d9eeee;border-radius:4px;padding:5px 8px;cursor:pointer}
.hmi button:disabled{opacity:.4;cursor:default}.hmi .go{background:#1d7a52;border-color:#2fa874}.hmi .no{background:#8a2a1c;border-color:#c8503c}
.hmi .nav{display:flex;gap:4px}.hmi .nav button{flex:1;padding:6px 1px;font-size:10px}.hmi .nav button.on{background:#2a6f70;border-color:#6cc6ee}
.hmi .nav button.al{border-color:#e0583f;color:#ff9c88}
.hh{display:flex;justify-content:space-between;align-items:center;font-weight:700;letter-spacing:.04em}
.led{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.badge{background:#c8402c;color:#fff;border-radius:4px;padding:1px 7px;margin-right:8px;animation:bl 1s steps(2) infinite}
.hp{display:grid;grid-template-columns:repeat(4,1fr) auto;gap:6px;align-items:center;background:#102426;border:1px solid #234546;border-radius:6px;padding:5px 8px}
.hp small,.ht small{display:block;color:#7fa3a2;font-size:10px}.hp b{font-size:14px}
.pg{overflow:auto;min-height:0}
.hg{display:grid;grid-template-columns:1fr 1fr;gap:6px;align-content:start}
.ht{background:#102426;border:1px solid #234546;border-radius:6px;padding:6px 8px}.ht.warn{border-color:#d19a2e}.ht.bad{border-color:#e0583f}
.ht .big{font-size:20px;font-weight:700}.bar{height:5px;background:#1c3a3c;border-radius:3px;margin:3px 0 5px;overflow:hidden}.bar i{display:block;height:100%;background:#4fb3e0}
.hv{display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;font-size:11px}.hv span{display:flex;justify-content:space-between}
.jt{width:100%;border-collapse:collapse;font-size:11px}.jt th{color:#7fa3a2;font-weight:400;text-align:right;padding:2px 4px}.jt td{text-align:right;padding:2px 4px;border-top:1px solid #163133}.jt th:first-child,.jt td:first-child{text-align:left}
.jt .low,.jt .high{color:#f0b04a;font-weight:700}.jt .bad{color:#ff8b78;font-weight:700}.jt .off{color:#5d7776}
.wq{display:grid;grid-template-columns:1fr auto;gap:2px 8px;background:#102426;border:1px solid #234546;border-radius:6px;padding:6px 8px}
.wq.low,.wq.high{border-color:#d19a2e}.wq.bad{border-color:#e0583f}.wq .v{font-size:18px;font-weight:700}
.wq .rb{grid-column:1/3;position:relative;height:6px;background:#1c3a3c;border-radius:3px}.wq .rb i{position:absolute;top:0;height:6px;background:#1d5a45;border-radius:3px}.wq .rb b{position:absolute;top:-3px;width:3px;height:12px;background:#fff;border-radius:1px}
.chip{font-weight:700;font-size:10px;padding:1px 6px;border-radius:3px;background:#1d7a52;color:#fff}.chip.low,.chip.high{background:#a8650a}.chip.bad{background:#a8321f}
.al{background:#102426;border:1px solid #234546;border-radius:6px;padding:4px 8px;font-size:11px}
.al div{display:flex;gap:6px;justify-content:space-between;padding:1px 0}.al .c{color:#ff8b78}.al .a{color:#f0b04a}
`

export default function PlcHmi() {
  const { system, settings } = useSystem()
  const [jars, setJars] = useState<any[]>(() => demoJars())
  const [tick, setTick] = useState(0)
  const [cmd, setCmd] = useState(true)
  const [speed, setSpeed] = useState(100)
  const [fault, setFault] = useState(false)
  const [sumpLow, setSumpLow] = useState(false)
  const [link, setLink] = useState(true)
  const [cuts, setCuts] = useState<string[]>([])
  const [acked, setAcked] = useState<string[]>([])
  const [sel, setSel] = useState('1-A')
  const [fails, setFails] = useState<string[]>([])
  const [ramp, setRamp] = useState<Record<string, number>>({})
  const [page, setPage] = useState<'ovr' | 'jar' | 'wq' | 'std' | 'alm'>('ovr')
  const [jl, setJl] = useState('1-A')
  const [lims, setLims] = useState<Record<string, Lim>>(LIM0)
  const hist = useRef<Record<string, number[]>>({})

  useEffect(() => {
    if (!system) return
    supabase.from('ras_jar_overview').select('*').eq('system_id', system.id).order('station').order('line').order('position')
      .then(({ data }) => { if (data && data.length) setJars(data) })
  }, [system])
  useEffect(() => { const i = setInterval(() => setTick(t => t + 1), 900); return () => clearInterval(i) }, [])
  useEffect(() => {
    setRamp(p => { const n: Record<string, number> = {}; for (const x of FAILS) { const c = p[x.k] ?? 0, tg = fails.includes(x.k) ? 1 : 0; n[x.k] = c + Math.max(-0.25, Math.min(0.2, tg - c)) } return n })
  }, [tick, fails])
  useEffect(() => { const dm = +(settings as any)?.do_min_mgl; if (dm) setLims(l => (l.jdo[0] === 5 ? { ...l, jdo: [dm, undefined] } : l)) }, [settings])

  const s: Settings = useMemo(() => ({ ...DEFAULTS, ...(settings ?? {}) } as Settings), [settings])
  const run = cmd && !fault && !sumpLow
  const spd = run ? speed / 100 : 0
  const blocked = (ramp.block ?? 0) > 0.5
  const jarsEff = useMemo(() => jars.map(j => (blocked && j.station === 1 && j.line === 'A' && j.position === 5 ? { ...j, valve_open_pct: 3 } : j)), [jars, blocked])
  const lines = useMemo(() => computeJars(jarsEff, { ...s, line_head_m: s.line_head_m * spd * spd }), [jarsEff, s, spd])
  const keys = lines.map(l => l.key)
  const counts = useMemo(() => Object.fromEntries(lines.map(l => [l.key, l.rows.length])), [lines])
  const tags = useMemo(() => buildTags(keys, 70, lims, counts), [keys.join(','), lims, counts])
  const groups = useMemo(() => ['PUMP', 'WQ', ...keys], [keys.join(',')])
  const sel2 = groups.includes(sel) ? sel : 'PUMP'
  const jl2 = keys.includes(jl) ? jl : keys[0]
  const rp = (k: string) => ramp[k] ?? 0

  // ---- field values, then the PLC's 4-20 mA scaling
  const rd = useMemo(() => {
    const o: Record<string, Rd> = {}
    const nz = (k: number, a: number) => Math.sin(tick * 0.7 + k * 1.9) * a + Math.cos(tick * 0.31 + k) * a * 0.5
    const lq: Record<string, any> = {}
    let total = 0
    lines.forEach(l => {
      const Q = run ? l.rows.reduce((a, r) => a + (r.jar.is_on ? r.Q : 0), 0) : 0, on = l.rows.filter(r => r.jar.is_on)
      total += Q
      lq[l.key] = { Q, head: l.rows[0]?.head ?? 0, valve: on.length ? on.reduce((a, r) => a + r.jar.valve_open_pct, 0) / on.length : 0 }
    })
    const temp = s.water_temp_c + 3.8 * rp('heat'), doIn = 7.2 + (-3.4) * rp('lowdo')
    const wq: Record<string, number> = Object.fromEntries(WQ.map(w => [w.tag, w.base + (w.fail - w.base) * (FAILS.find(x => x.tag === w.tag) ? rp(FAILS.find(x => x.tag === w.tag)!.k) : 0)]))
    const raw = (tg: Tag, k: number): number => {
      const n = tg.tag, g = lq[tg.grp]
      if (tg.grp === 'WQ') return wq[n] === 0 ? 0 : wq[n] + nz(k, Math.max(0.002, wq[n] * 0.006))
      if (tg.grp === 'PUMP') {
        if (n === 'PT-100') return run ? (s.line_head_m + 0.8) * spd * spd / 10.2 + nz(k, 0.004) : 0
        if (n === 'FT-100') return total + nz(k, 0.4)
        if (n === 'TT-100') return temp + nz(k, 0.08)
        return doIn + 0.2 + nz(k, 0.05)
      }
      if (n.startsWith('PT')) return run ? g.head / 10.2 + nz(k, 0.003) : 0
      if (n.startsWith('FT')) return g.Q + nz(k, 0.3)
      if (n.startsWith('TT')) return temp + nz(k, 0.1)
      if (n.startsWith('ZT')) return g.valve
      return n.endsWith('i') ? doIn + nz(k, 0.06) : doIn - 1 + nz(k, 0.08)
    }
    tags.forEach((tg, k) => {
      if (tg.io === 'BUS') return void (o[tg.tag] = { v: counts[tg.grp] ?? 0, mA: null, st: cuts.includes(tg.tag) ? 'bad' : 'ok' })
      if (tg.io !== 'AI') return
      let mA = 4 + 16 * (raw(tg, k) - tg.lo) / (tg.hi - tg.lo)
      mA = Math.max(0, Math.min(24, mA))
      if (cuts.includes(tg.tag)) mA = 0.1
      if (mA < 3.8 || mA > 20.5) return void (o[tg.tag] = { v: null, mA, st: 'bad' })
      const v = tg.lo + (mA - 4) / 16 * (tg.hi - tg.lo)
      const proc = run || tg.grp === 'WQ'
      const st = !proc ? 'ok' : tg.alo != null && v < tg.alo ? 'low' : tg.ahi != null && v > tg.ahi ? 'high' : 'ok'
      o[tg.tag] = { v, mA, st }
    })
    const di = (n: string, on: boolean, st: Rd['st'] = 'ok') => (o[n] = { v: on ? 1 : 0, mA: null, st })
    di('PUMP_RUN', run); di('PUMP_FAULT', fault, fault ? 'high' : 'ok'); di('SUMP_LOW', sumpLow, sumpLow ? 'low' : 'ok'); di('PUMP_CMD', cmd)
    o['VFD_SPD'] = { v: run ? speed : 0, mA: null, st: 'ok' }
    return o
  }, [tick, tags, lines, cuts, run, fault, sumpLow, cmd, speed, spd, s, ramp, counts])

  // ---- per-jar KPIs (flow, outlet oxygen from flow, pressure, temperature)
  const jarK = useMemo(() => {
    const out: Record<string, JK[]> = {}
    const [fl, fh] = lims.jflow, [dl, dh] = lims.jdo, [pl, ph] = lims.jp, [tl, th] = lims.temp
    const chk = (v: number, lo?: number, hi?: number): St => (lo != null && v < lo ? 'low' : hi != null && v > hi ? 'high' : 'ok')
    lines.forEach(l => {
      const n = lname(l.key), bus = cuts.includes(`JAR-${n}`), dIn = rd[`AT-${n}i`]?.v ?? 7.2, tLine = rd[`TT-${n}`]?.v ?? s.water_temp_c
      out[l.key] = l.rows.map((r, i) => {
        const on = !!r.jar.is_on
        const base = { pos: r.jar.position, on, target: r.target }
        if (!on) return { ...base, Q: null, DO: null, P: null, T: null, s: { flow: 'off', DO: 'off', P: 'off', T: 'off' } as JK['s'] }
        if (bus) return { ...base, Q: null, DO: null, P: null, T: null, s: { flow: 'bad', DO: 'bad', P: 'bad', T: 'bad' } as JK['s'] }
        const Q = run ? r.Q : 0, our = ((r.jar.egg_mass_g ?? 1200) * OUR0 * STAGE_X[Math.min(3, Math.max(0, (r.jar.stage ?? 1) - 1))]) / 60
        const DO = run ? (Q > 0.05 ? Math.max(0, dIn - our / Q) : 0) : 0
        const P = run ? r.head / 10.2 : 0, T = tLine + Math.sin(i * 1.7 + tick * 0.5) * 0.05
        const sFlow: St = run ? chk(Q, fl != null ? (fl / 100) * r.target : undefined, fh != null ? (fh / 100) * r.target : undefined) : 'ok'
        return { ...base, Q, DO, P, T, s: { flow: sFlow, DO: run ? chk(DO, dl, dh) : 'ok', P: run ? chk(P, pl, ph) : 'ok', T: chk(T, tl, th) } }
      })
    })
    return out
  }, [lines, rd, lims, cuts, run, tick, s])

  // ---- alarms: sensors / PLC tags, then jar KPIs
  const alarms: Al[] = useMemo(() => {
    const a: Al[] = []
    for (const t of tags) {
      const r = rd[t.tag]
      if (!r || r.st === 'ok') continue
      const val = r.st === 'bad' ? (t.io === 'BUS' ? 'COMM FAULT' : 'SENSOR FAULT') : t.io === 'AI' ? `${r.st.toUpperCase()} ${f(r.v, t.dec ?? 1)} ${t.unit}` : r.st.toUpperCase()
      a.push({ id: `${t.tag}:${r.st}`, text: `${t.tag} · ${t.desc}`, val, st: r.st, src: t.grp === 'WQ' ? 'wq' : 'tag' })
    }
    const nm = { flow: 'flow', DO: 'oxygen', P: 'pressure', T: 'temperature' } as const
    const un = { flow: 'L/min', DO: 'mg/L', P: 'bar', T: '°C' } as const
    const dc = { flow: 1, DO: 1, P: 2, T: 1 } as const
    for (const k of keys) {
      if (cuts.includes(`JAR-${lname(k)}`)) continue
      ;(jarK[k] ?? []).forEach(j => {
        for (const m of ['flow', 'DO', 'P', 'T'] as const) {
          const st = j.s[m]
          if (st === 'low' || st === 'high') {
            const v = m === 'flow' ? j.Q : m === 'DO' ? j.DO : m === 'P' ? j.P : j.T
            a.push({ id: `J|${k}|${j.pos}|${m}|${st}`, text: `S${k.split('-')[0]}·${k.split('-')[1]} jar ${j.pos} · ${nm[m]}`, val: `${st.toUpperCase()} ${f(v, dc[m])} ${un[m]}`, st, src: 'jar' })
          }
        }
      })
    }
    return a.sort((x, y) => (y.st === 'bad' ? 1 : 0) - (x.st === 'bad' ? 1 : 0) || x.id.localeCompare(y.id))
  }, [tags, rd, jarK, keys.join(','), cuts])
  const unacked = alarms.filter(a => !acked.includes(a.id)).length
  const horn = unacked > 0
  const ids = alarms.map(a => a.id).join('|')
  useEffect(() => { const live = new Set(ids.split('|')); setAcked(p => { const n = p.filter(i => live.has(i)); return n.length === p.length ? p : n }) }, [ids])
  rd['HORN'] = { v: horn ? 1 : 0, mA: null, st: 'ok' }

  useEffect(() => { for (const w of WQ) { const v = rd[w.tag]?.v; if (v != null) hist.current[w.tag] = [...(hist.current[w.tag] ?? []), v].slice(-40) } }, [tick])

  // ---- diagram layout
  const nAI = Math.ceil(tags.filter(t => t.io === 'AI').length / 8)
  const modH = MOD_HEAD + 8 * CH
  const modY = (m: number) => TOP + m * (modH + MOD_GAP)
  const dioN = tags.filter(t => t.mod === 'DIO').length, busN = keys.length
  const dioY = modY(nAI), busY = dioY + MOD_HEAD + dioN * CH + MOD_GAP
  const plcBottom = busY + MOD_HEAD + busN * CH
  const term = (t: Tag) => {
    if (t.mod === 'DIO') return { x: PX - 4, y: dioY + MOD_HEAD + t.ch * CH + CH / 2 }
    if (t.mod === 'BUS') return { x: PX - 4, y: busY + MOD_HEAD + t.ch * CH + CH / 2 }
    return { x: PX - 4, y: modY(+t.mod.slice(3) - 1) + MOD_HEAD + t.ch * CH + CH / 2 }
  }
  let gy = 4
  const gpos: Record<string, { y: number; h: number; rows: Tag[] }> = {}
  for (const g of groups) {
    const rows = tags.filter(t => t.grp === g)
    const h = g === sel2 ? 30 + rows.length * ROW : 40
    gpos[g] = { y: gy, h, rows }; gy += h + 8
  }
  const H = Math.max(plcBottom + 16, gy + 8, HMI_H + 20)
  const gtitle = (g: string) => (g === 'PUMP' ? 'Pump and sump' : g === 'WQ' ? 'Water quality · whole RAS' : `Station ${g.split('-')[0]} · line ${g.split('-')[1]}`)
  const stCol = (st: string) => (st === 'bad' ? 'var(--bad)' : st === 'ok' ? 'var(--ok)' : 'var(--warn)')
  const worst = (g: string) => { const l = gpos[g].rows.map(t => rd[t.tag]?.st ?? 'ok'); return l.includes('bad') ? 'bad' : l.some(x => x !== 'ok') ? 'warn' : 'ok' }
  const cutTog = (tg: string) => setCuts(c => (c.includes(tg) ? c.filter(x => x !== tg) : [...c, tg]))
  const selTags = gpos[sel2].rows
  const valTxt = (t: Tag, r?: Rd) => (t.io === 'AI' ? `${f(r?.v, t.dec ?? 1)} ${t.unit}` : t.io === 'BUS' ? (r?.st === 'bad' ? 'no comm' : `${r?.v} jars`) : t.io === 'AO' ? `${f(r?.v, 0)} %` : r?.v ? 'ON' : 'off')

  // ---- HMI
  const hv = (n: string) => (link ? rd[n] : undefined)
  const jarAlarmCount = (k: string) => alarms.filter(a => a.src === 'jar' && a.id.startsWith(`J|${k}|`)).length
  const tile = (k: string) => {
    const n = lname(k), ft = hv(`FT-${n}`), tt = hv(`TT-${n}`), di = hv(`AT-${n}i`), dout = hv(`AT-${n}o`), pt = hv(`PT-${n}`), zt = hv(`ZT-${n}`), bus = hv(`JAR-${n}`)
    const ws = [ft, tt, di, dout, pt, zt, bus].map(x => x?.st ?? 'ok'), ja = link ? jarAlarmCount(k) : 0
    const cls = ws.includes('bad') ? 'bad' : ws.some(x => x !== 'ok') || ja ? 'warn' : ''
    return (
      <div key={k} className={`ht ${cls}`} style={{ cursor: 'pointer' }} onClick={() => { setJl(k); setPage('jar') }}>
        <small>S{k.split('-')[0]} · LINE {k.split('-')[1]}{ws.includes('bad') ? ' · FAULT' : ja ? ` · ${ja} JAR ALARM${ja > 1 ? 'S' : ''}` : ''}</small>
        <span className="big">{f(ft?.v, 0)}</span> <small style={{ display: 'inline' }}>L/min</small>
        <div className="bar"><i style={{ width: `${Math.min(100, (ft?.v ?? 0))}%` }} /></div>
        <div className="hv">
          <span><small>Temp</small>{f(tt?.v)} °C</span><span><small>Press</small>{f(pt?.v, 2)} bar</span>
          <span><small>DO in</small>{f(di?.v)}</span><span><small>DO out</small>{f(dout?.v)}</span>
        </div>
        <small style={{ marginTop: 3, color: '#5d8584' }}>Limits: temp {limTxt('temp')} · DO out {limTxt('jdo')}</small>
      </div>
    )
  }
  const limTxt = (k: string, u = '') => {
    const [lo, hi] = lims[k] ?? []
    return lo != null && hi != null ? `${lo}–${hi}${u}` : hi != null ? (hi === 0 ? 'none allowed' : `≤ ${hi}${u}`) : lo != null ? `≥ ${lo}${u}` : 'no limit'
  }
  const jarOut = (m: string) => alarms.filter(a => a.src === 'jar' && a.id.split('|')[3] === m).length
  const jc = (st: St, txt: string) => <td className={st === 'ok' ? '' : st}>{st === 'off' ? '-' : st === 'bad' ? '---' : txt}{st === 'low' ? ' ▼' : st === 'high' ? ' ▲' : ''}</td>
  const spark = (a: number[], lo: number, hi: number, col: string) => {
    if (a.length < 2) return null
    const mn = Math.min(...a, lo), mx = Math.max(...a, hi), pts = a.map((v, i) => `${(i / 39) * 60},${22 - ((v - mn) / (mx - mn || 1)) * 20}`).join(' ')
    return <svg width="60" height="24"><polyline points={pts} fill="none" stroke={col} strokeWidth="1.5" /></svg>
  }
  const wqTile = (w: typeof WQ[number]) => {
    const r = hv(w.tag), L = lims[w.lim], pos = (v: number) => `${Math.max(0, Math.min(100, ((v - w.rng[0]) / (w.rng[1] - w.rng[0])) * 100))}%`
    const st = r?.st ?? 'ok', col = st === 'ok' ? '#5fcf9b' : st === 'bad' ? '#ff8b78' : '#f0b04a'
    const lo = L[0] ?? w.rng[0], hi = L[1] ?? w.rng[1]
    return (
      <div key={w.tag} className={`wq ${st}`}>
        <div><small style={{ color: '#7fa3a2' }}>{w.name}</small><div><span className="v" style={{ color: col }}>{f(r?.v, w.dec)}</span> <small style={{ display: 'inline', color: '#7fa3a2' }}>{w.unit}</small></div></div>
        <div style={{ textAlign: 'right' }}><span className={`chip ${st}`}>{!link ? 'NO LINK' : st === 'ok' ? 'OK' : st === 'bad' ? 'SENSOR FAULT' : st.toUpperCase()}</span><div>{link ? spark(hist.current[w.tag] ?? [], lo, hi, col) : null}</div></div>
        <div className="rb"><i style={{ left: pos(lo), width: `calc(${pos(hi)} - ${pos(lo)})` }} />{r?.v != null && <b style={{ left: pos(r.v) }} />}</div>
        <small style={{ gridColumn: '1/3', color: '#7fa3a2' }}>{L[0] == null && L[1] == null ? 'no limit' : `limit ${L[0] != null ? 'min ' + L[0] : ''}${L[0] != null && L[1] != null ? ' · ' : ''}${L[1] != null ? (L[1] === 0 ? 'none allowed' : 'max ' + L[1]) : ''}`}</small>
      </div>
    )
  }
  const jr = jarK[jl2] ?? [], jbus = rd[`JAR-${lname(jl2)}`]
  const pumpTxt = !link ? '---' : fault ? 'FAULT' : sumpLow ? 'LOW SUMP' : rd['PUMP_RUN']?.v ? 'RUN' : 'STOP'

  return (
    <>
      <style>{CSS}</style>
      <div className="panel">
        <h2>Sensors to PLC to HMI</h2>
        <p className="note">Left: field sensors on 4-20 mA pairs, plus one RS-485 jar sensor bus per line. Middle: PLC modules with the terminal each one lands on. Right: the operator HMI, linked by Ethernet, showing jar KPIs and whole-RAS water quality with alarms. Values are simulated from the jar model.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={() => setCmd(c => !c)}>{cmd ? 'Stop pump' : 'Start pump'}</button>
          <label className="slider">Pump speed <input type="range" min={40} max={100} value={speed} onChange={e => setSpeed(+e.target.value)} /> {speed}%</label>
          <button className="ghost" onClick={() => setFault(x => !x)}>{fault ? 'Clear pump fault' : 'Trip pump (fault)'}</button>
          <button className="ghost" onClick={() => setSumpLow(x => !x)}>{sumpLow ? 'Refill sump' : 'Sump low level'}</button>
          <button className="ghost" onClick={() => setLink(x => !x)}>{link ? 'Unplug Ethernet' : 'Plug in Ethernet'}</button>
          <button className="ghost" onClick={() => setCuts([])} disabled={!cuts.length}>Reconnect all sensors</button>
        </div>
        <div>
          <small className="note">Make a KPI fail and watch the HMI alarm:</small>
          <div className="fch" style={{ marginTop: 4 }}>
            {FAILS.map(x => <button key={x.k} className={`ghost ${fails.includes(x.k) ? 'on' : ''}`} onClick={() => setFails(a => (a.includes(x.k) ? a.filter(y => y !== x.k) : [...a, x.k]))}>{x.label}</button>)}
            <button className="ghost" onClick={() => setFails([])} disabled={!fails.length}>Clear all failures</button>
          </div>
        </div>
      </div>
      <div className="panel sc">
        <svg viewBox={`0 0 1190 ${H}`} style={{ width: '100%', minWidth: 980, display: 'block' }} role="img" aria-label="Sensor to PLC to HMI wiring">
          {tags.map(t => {
            const g = gpos[t.grp], isSel = t.grp === sel2, i = g.rows.indexOf(t)
            const x0 = GW, y0 = isSel ? g.y + 30 + i * ROW + ROW / 2 : g.y + g.h / 2, p = term(t)
            const r = rd[t.tag], cut = cuts.includes(t.tag), mx = (x0 + p.x) / 2
            const d = `M${x0},${y0} C${mx},${y0} ${mx},${p.y} ${p.x},${p.y}`
            const outp = t.io === 'DO' || t.io === 'AO'
            return (
              <g key={t.tag + 'w'} opacity={isSel ? 1 : 0.28}>
                <path d={d} className={`pw ${cut || outp ? 'x' : ''}`} stroke={r?.st === 'bad' ? 'var(--bad)' : t.io === 'BUS' ? 'var(--egg)' : 'var(--flow)'} strokeDasharray={cut ? '60 400' : undefined} />
                {cut && isSel && <text x={mx} y={(y0 + p.y) / 2} fill="var(--bad)" fontSize="11" textAnchor="middle" fontWeight="700">cut</text>}
              </g>
            )
          })}
          {groups.map(g => {
            const p = gpos[g], on = g === sel2
            return (
              <g key={g} className="gsel" onClick={() => setSel(g)}>
                <rect className="gb" x={2} y={p.y} width={GW - 2} height={p.h} rx={7} fill="var(--panel)" stroke={on ? 'var(--acc)' : 'var(--line)'} strokeWidth={on ? 2 : 1} />
                <circle cx={16} cy={p.y + 16} r={5} fill={stCol(worst(g))} />
                <text x={28} y={p.y + 20} fill="var(--ink)" fontSize="13" fontWeight="700">{gtitle(g)}</text>
                {!on && p.rows.map((t, i) => <rect key={t.tag} x={14 + i * 14} y={p.y + 28} width={9} height={7} rx={2} fill={stCol(rd[t.tag]?.st ?? 'ok')} opacity={0.85} />)}
                {on && p.rows.map((t, i) => {
                  const y = p.y + 30 + i * ROW, r = rd[t.tag]
                  return (
                    <g key={t.tag}>
                      <text x={14} y={y + 15} fill="var(--ink)" fontSize="11" fontWeight="700">{t.tag}</text>
                      <text x={84} y={y + 15} fill="var(--mute)" fontSize="11">{t.io === 'AI' ? `${f(r?.mA, 1)} mA` : t.io === 'BUS' ? 'RS-485' : t.io}</text>
                      <text x={GW - 10} y={y + 15} fill={stCol(r?.st ?? 'ok')} fontSize="11" textAnchor="end">{valTxt(t, r)}</text>
                    </g>
                  )
                })}
              </g>
            )
          })}
          <rect x={PX - 14} y={2} width={PW + 28} height={TOP - 14} rx={8} fill="#26373a" stroke="#0e1b1d" />
          <text x={PX} y={24} fill="#e3f1ef" fontSize="14" fontWeight="700">PLC · CPU</text>
          <text x={PX} y={42} fill="#9db8b5" fontSize="11">Scan 20 ms · {tags.length} tags</text>
          <circle cx={PX + 12} cy={58} r={4} fill="#5fcf9b" /><text x={PX + 22} y={62} fill="#9db8b5" fontSize="10">RUN</text>
          <circle cx={PX + 62} cy={58} r={4} fill={alarms.length ? '#f0b04a' : '#2c4645'} /><text x={PX + 72} y={62} fill="#9db8b5" fontSize="10">ALM</text>
          <circle cx={PX + 112} cy={58} r={4} fill={link ? '#5fcf9b' : '#ff8b78'} /><text x={PX + 122} y={62} fill="#9db8b5" fontSize="10">ETH</text>
          {Array.from({ length: nAI }, (_, m) => (
            <g key={m}>
              <rect x={PX - 8} y={modY(m)} width={PW + 16} height={modH} rx={4} fill="#26373a" stroke="#0e1b1d" />
              <text x={PX + 4} y={modY(m) + 11} fill="#e3f1ef" fontSize="10" fontWeight="700">AI-{m + 1} · 8 ch · 4-20 mA</text>
            </g>
          ))}
          <rect x={PX - 8} y={dioY} width={PW + 16} height={MOD_HEAD + dioN * CH} rx={4} fill="#26373a" stroke="#0e1b1d" />
          <text x={PX + 4} y={dioY + 11} fill="#e3f1ef" fontSize="10" fontWeight="700">DI / DO / AO · pump interface</text>
          <rect x={PX - 8} y={busY} width={PW + 16} height={MOD_HEAD + busN * CH} rx={4} fill="#26373a" stroke="#0e1b1d" />
          <text x={PX + 4} y={busY + 11} fill="#e3f1ef" fontSize="10" fontWeight="700">RS-485 · jar sensor bus (Modbus RTU)</text>
          {tags.map(t => {
            const p = term(t), r = rd[t.tag], hot = t.grp === sel2
            return (
              <g key={t.tag + 'm'}>
                <rect x={p.x - 2} y={p.y - 4} width={8} height={8} rx={2} fill={r?.st === 'bad' ? '#ff8b78' : hot ? '#6cc6ee' : '#5b7476'} />
                <text x={PX + 12} y={p.y + 3.5} fill={hot ? '#e3f1ef' : '#8ea8a6'} fontSize="9">{t.addr}</text>
                <text x={PX + 62} y={p.y + 3.5} fill={hot ? '#e3f1ef' : '#8ea8a6'} fontSize="9">{t.tag}</text>
                <text x={PX + PW} y={p.y + 3.5} fill={hot ? '#e3f1ef' : '#8ea8a6'} fontSize="9" textAnchor="end">{t.io === 'AI' ? `${f(r?.mA, 1)} mA` : valTxt(t, r)}</text>
              </g>
            )
          })}
          <path d={`M${PX + PW + 14},32 H800`} stroke="#0e1b1d" strokeWidth={7} fill="none" strokeLinecap="round" />
          <path d={`M${PX + PW + 14},32 H800`} stroke={link ? 'var(--flow)' : 'var(--bad)'} fill="none" strokeDasharray={link ? '10 6' : '3 30'} className={link ? 'pw' : 'pw x'} style={{ strokeWidth: 3 }} />
          <text x={(PX + PW + 14 + 800) / 2} y={22} fill="var(--mute)" fontSize="11" textAnchor="middle">Ethernet · Modbus TCP</text>
          <rect x={800} y={2} width={386} height={HMI_H} rx={14} fill="#1b2829" stroke="#0e1b1d" strokeWidth={2} />
          <foreignObject x={810} y={12} width={366} height={HMI_H - 20}>
            <div className="hmi">
              <div className="hh"><span>RAS HATCHERY · HMI</span>
                <span>{link && unacked > 0 && <span className="badge">ALARM {unacked}</span>}<span className="led" style={{ background: link ? '#5fcf9b' : '#ff8b78' }} />{link ? 'PLC ONLINE' : 'NO PLC LINK'}</span></div>
              <div className="hp">
                <div><small>PUMP</small><b style={{ color: link ? (rd['PUMP_RUN']?.v ? '#5fcf9b' : fault ? '#ff8b78' : '#9db8b5') : '#7fa3a2' }}>{pumpTxt}</b></div>
                <div><small>Speed</small><b>{link ? f(rd['VFD_SPD']?.v, 0) : '---'}%</b></div>
                <div><small>Discharge</small><b>{link ? f(rd['PT-100']?.v, 2) : '---'}</b></div>
                <div><small>Total L/min</small><b>{link ? f(rd['FT-100']?.v, 0) : '---'}</b></div>
                <div style={{ display: 'grid', gap: 3 }}>
                  <button className="go" disabled={!link || cmd} onClick={() => setCmd(true)}>START</button>
                  <button className="no" disabled={!link || !cmd} onClick={() => setCmd(false)}>STOP</button>
                </div>
              </div>
              <div className="nav">
                {([['ovr', 'OVERVIEW'], ['jar', 'JARS'], ['wq', 'WATER'], ['std', 'LIMITS'], ['alm', `ALARMS${link && alarms.length ? ' ' + alarms.length : ''}`]] as const).map(([k, l]) =>
                  <button key={k} className={`${page === k ? 'on' : ''} ${k === 'alm' && link && alarms.length ? 'al' : ''}`} onClick={() => setPage(k)}>{l}</button>)}
              </div>
              <div className="pg">
                {!link ? <div className="al"><div className="c"><span>PLC COMMUNICATION LOST · values not updating</span></div></div> : null}
                {link && page === 'ovr' && <div className="hg">{keys.map(tile)}</div>}
                {link && page === 'jar' && (
                  <div>
                    <div style={{ display: 'flex', gap: 3, marginBottom: 5 }}>
                      {keys.map(k => <button key={k} className={k === jl2 ? '' : ''} style={{ flex: 1, background: k === jl2 ? '#2a6f70' : undefined, borderColor: jarAlarmCount(k) ? '#e0583f' : undefined }} onClick={() => setJl(k)}>{k.replace('-', '·')}</button>)}
                    </div>
                    {jbus?.st === 'bad' && <div className="al"><div className="c"><span>JAR SENSOR BUS FAULT · line {lname(jl2)} jar values unavailable</span></div></div>}
                    <table className="jt"><thead><tr><th>Jar</th><th>Flow L/min</th><th>O₂ out mg/L</th><th>Press bar</th><th>Temp °C</th></tr><tr><th>Standard</th><th>{limTxt('jflow', '%')}</th><th>{limTxt('jdo')}</th><th>{limTxt('jp')}</th><th>{limTxt('temp')}</th></tr></thead>
                      <tbody>{jr.map(j => <tr key={j.pos}><td>{j.pos}</td>{jc(j.s.flow, f(j.Q))}{jc(j.s.DO, f(j.DO))}{jc(j.s.P, f(j.P, 2))}{jc(j.s.T, f(j.T))}</tr>)}</tbody></table>
                    <small style={{ color: '#7fa3a2', display: 'block', marginTop: 4 }}>Oxygen out = inlet oxygen minus egg uptake ÷ jar flow. ▼ below limit, ▲ above.</small>
                  </div>
                )}
                {link && page === 'std' && (
                  <table className="jt"><thead><tr><th>KPI</th><th>Standard</th><th>Now</th><th>State</th></tr></thead>
                    <tbody>
                      {WQ.map(w => { const r = rd[w.tag], st = r?.st ?? 'ok'; return <tr key={w.tag}><td>{w.name}</td><td>{limTxt(w.lim)}</td><td className={st === 'ok' ? '' : st === 'bad' ? 'bad' : 'low'}>{f(r?.v, w.dec)} {w.unit}</td><td className={st === 'ok' ? '' : st === 'bad' ? 'bad' : 'low'}>{st === 'ok' ? 'OK' : st === 'bad' ? 'FAULT' : st.toUpperCase()}</td></tr> })}
                      {([['jflow', 'Jar flow', 'flow', '% of target'], ['jdo', 'Jar oxygen out', 'DO', ''], ['jp', 'Jar pressure', 'P', ' bar']] as const).map(([k, n, m, u]) => { const c = jarOut(m); return <tr key={k}><td>{n}</td><td>{limTxt(k, u === '% of target' ? '%' : '')}{u && u !== '% of target' ? u : u ? ' of target' : ''}</td><td className={c ? 'low' : ''}>{c ? `${c} jar${c > 1 ? 's' : ''} out` : 'all in range'}</td><td className={c ? 'low' : ''}>{c ? 'ALARM' : 'OK'}</td></tr> })}
                      {(() => { const r = rd['TT-100'], st = r?.st ?? 'ok'; return <tr><td>Water temperature</td><td>{limTxt('temp', ' °C')}</td><td className={st === 'ok' ? '' : 'low'}>{f(r?.v)} °C</td><td className={st === 'ok' ? '' : 'low'}>{st === 'ok' ? 'OK' : st.toUpperCase()}</td></tr> })()}
                    </tbody></table>
                )}
                {link && page === 'wq' && <div className="hg">{WQ.map(wqTile)}</div>}
                {link && page === 'alm' && (
                  <div className="al" style={{ maxHeight: '100%', overflow: 'auto' }}>
                    {alarms.length === 0 ? <div><span style={{ color: '#5fcf9b' }}>No active alarms</span></div> : alarms.slice(0, 80).map(a => (
                      <div key={a.id} className={a.st === 'bad' ? 'c' : 'a'} style={{ opacity: acked.includes(a.id) ? 0.55 : 1 }}><span>{a.text}</span><span style={{ whiteSpace: 'nowrap' }}>{a.val}</span></div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="al">
                  {!link ? <div className="c"><span>PLC COMMUNICATION LOST</span></div>
                    : alarms.length === 0 ? <div><span style={{ color: '#5fcf9b' }}>No active alarms</span></div>
                    : alarms.slice(0, 2).map(a => <div key={a.id} className={a.st === 'bad' ? 'c' : 'a'} style={{ opacity: acked.includes(a.id) ? 0.55 : 1 }}><span>{a.text}</span><span style={{ whiteSpace: 'nowrap' }}>{a.val}</span></div>)}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 5 }}>
                  <span><span className="led" style={{ background: link && horn ? '#e0583f' : '#2c4645' }} />HORN {link && alarms.length > 2 ? ` · +${alarms.length - 2} more` : ''}</span>
                  <button disabled={!link || !alarms.length} onClick={() => setAcked(alarms.map(a => a.id))}>ACK ALL</button>
                </div>
              </div>
            </div>
          </foreignObject>
        </svg>
      </div>
      <div className="panel">
        <h2>{gtitle(sel2)} · wiring</h2>
        <div className="sc"><table className="tbl">
          <thead><tr><th>Tag</th><th>Description</th><th>Type</th><th>PLC address</th><th>Module / channel</th><th>Signal</th><th>Value</th><th>State</th><th></th></tr></thead>
          <tbody>{selTags.map(t => {
            const r = rd[t.tag], cls = r?.st === 'bad' ? 'bad' : r?.st === 'ok' ? 'ok' : 'warn'
            return (
              <tr key={t.tag}><td>{t.tag}</td><td>{t.desc}</td><td>{t.io}</td><td>{t.addr}</td>
                <td>{t.mod === 'DIO' ? 'DIO' : t.mod === 'BUS' ? `RS-485 / drop ${t.ch + 1}` : `${t.mod} / ch ${t.ch}`}</td>
                <td>{t.io === 'AI' ? `${f(r?.mA, 2)} mA` : t.io === 'AO' ? '4-20 mA out' : t.io === 'BUS' ? 'Modbus RTU' : '24 V dry contact'}</td>
                <td>{valTxt(t, r)}</td>
                <td className={cls}>{r?.st === 'bad' ? (t.io === 'BUS' ? 'Comm fault' : 'Wire break / fault') : r?.st === 'ok' ? 'OK' : r?.st}</td>
                <td>{t.io === 'AI' || t.io === 'BUS' ? <button className="ghost" onClick={() => cutTog(t.tag)}>{cuts.includes(t.tag) ? 'Reconnect' : 'Cut wire'}</button> : ''}</td></tr>
            )
          })}</tbody>
        </table></div>
        <p className="note">A signal under 3.8 mA or over 20.5 mA is treated as a broken wire or failed sensor, as in ras_tag_readings. A real PLC reaches this app through a gateway that writes readings to the database.</p>
      </div>
      <div className="panel lim">
        <h2>HMI alarm limits and farm standards</h2>
        <div className="sc"><table className="tbl">
          <thead><tr><th>KPI</th><th>Unit</th><th>Alarm below</th><th>Alarm above</th><th>Source</th></tr></thead>
          <tbody>{LIMDEF.map(d => (
            <tr key={d.k}><td>{d.label}</td><td>{d.unit}</td>
              {[0, 1].map(i => <td key={i}><input type="number" step="any" value={lims[d.k][i] ?? ''} placeholder="none"
                onChange={e => setLims(l => { const n: Lim = [...l[d.k]] as Lim; n[i] = e.target.value === '' ? undefined : +e.target.value; return { ...l, [d.k]: n } })} /></td>)}
              <td className={d.std ? 'ok' : 'muted'}>{d.std ? 'Farm standard' : 'Starting guide'}</td></tr>
          ))}</tbody>
        </table></div>
        <button className="ghost" style={{ width: 'fit-content' }} onClick={() => setLims(LIM0)}>Reset to standards</button>
        <p className="note">Farm standards: ammonia 0.25 or less, nitrite 0, nitrate 0, alkalinity 100 or less, turbidity 15 or less, calcium hardness 200 or less. The other limits are starting guides only. Changes apply to this view only.</p>
      </div>
    </>
  )
}
