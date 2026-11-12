import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useSystem } from '../lib/useSystem'
import { computeJars, Settings } from '../lib/model'
import { DEFAULTS, demoJars } from './Simulator'

// PLC and HMI connection view. Every field sensor is wired (4-20 mA) to a terminal on a PLC input module, and the
// PLC talks to the operator HMI over Ethernet. Values come from the jar simulator, so cutting a wire, tripping
// the pump or unplugging the cable shows what the operator would see. Tag names and %IW addresses follow
// ras_seed_plc_tags; the ZT valve-position tags are added after the seeded analog inputs.

type Tag = { tag: string; desc: string; io: 'AI' | 'AO' | 'DI' | 'DO'; unit: string; lo: number; hi: number; alo?: number; ahi?: number; grp: string; addr: string; mod: string; ch: number }
type Rd = { v: number | null; mA: number | null; st: 'ok' | 'low' | 'high' | 'bad' }

const GW = 250, PX = 440, PW = 200, ROW = 22, CH = 12, MOD_HEAD = 16, MOD_GAP = 8, TOP = 84
const f = (x: number | null, d = 1) => (x == null || !Number.isFinite(x) ? '---' : x.toFixed(d))
const lname = (k: string) => k.replace('-', '')

function buildTags(keys: string[], q: number, doMin: number): Tag[] {
  const t: Tag[] = []
  let ai = 0
  const AI = (grp: string, tag: string, desc: string, unit: string, lo: number, hi: number, alo?: number, ahi?: number) => {
    t.push({ tag, desc, io: 'AI', unit, lo, hi, alo, ahi, grp, addr: `%IW${ai}`, mod: `AI-${Math.floor(ai / 8) + 1}`, ch: ai % 8 }); ai++
  }
  const dio = (grp: string, tag: string, desc: string, io: 'DI' | 'DO' | 'AO', addr: string) =>
    t.push({ tag, desc, io, unit: io === 'AO' ? '%' : '', lo: 0, hi: 100, grp, addr, mod: 'DIO', ch: 0 })
  const rt = keys.length * q
  AI('PUMP', 'PT-100', 'Pump discharge pressure', 'bar', 0, 4, 0.15, 1)
  AI('PUMP', 'FT-100', 'Total supply flow', 'L/min', 0, 1000, Math.round(0.8 * rt), Math.round(1.2 * rt))
  AI('PUMP', 'TT-100', 'Sump water temperature', 'C', 0, 50, 26, 31)
  AI('PUMP', 'AT-100', 'Sump dissolved oxygen', 'mg/L', 0, 20, doMin, 12)
  for (const k of keys) {
    const n = lname(k), g = k
    AI(g, `PT-${n}`, `Line ${n} header pressure`, 'bar', 0, 2.5, 0.1, 0.6)
    AI(g, `FT-${n}`, `Line ${n} flow`, 'L/min', 0, 300, Math.round(0.8 * q), Math.round(1.2 * q))
    AI(g, `TT-${n}`, `Line ${n} temperature`, 'C', 0, 50, 26, 31)
    AI(g, `AT-${n}i`, `Line ${n} inlet dissolved oxygen`, 'mg/L', 0, 20, 6, 12)
    AI(g, `AT-${n}o`, `Line ${n} overflow dissolved oxygen`, 'mg/L', 0, 20, doMin, 12)
  }
  for (const k of keys) AI(k, `ZT-${lname(k)}`, `Line ${lname(k)} mean valve position`, '%', 0, 100)
  dio('PUMP', 'PUMP_RUN', 'Pump running feedback', 'DI', '%I0.0')
  dio('PUMP', 'PUMP_FAULT', 'Pump fault', 'DI', '%I0.1')
  dio('PUMP', 'SUMP_LOW', 'Sump low level', 'DI', '%I0.2')
  dio('PUMP', 'PUMP_CMD', 'Pump start command', 'DO', '%Q0.0')
  dio('PUMP', 'HORN', 'Alarm horn', 'DO', '%Q0.1')
  dio('PUMP', 'VFD_SPD', 'Pump drive speed', 'AO', '%QW0')
  let r = 0
  for (const x of t) if (x.mod === 'DIO') x.ch = r++
  return t
}

const CSS = `
@keyframes wd{to{stroke-dashoffset:-14}}
.pw{fill:none;stroke-width:1.2;stroke-dasharray:5 4;animation:wd .9s linear infinite}
.pw.x{animation:none;stroke-dasharray:none}
.gsel{cursor:pointer}.gsel:hover rect.gb{stroke:var(--acc)}
.hmi{font:12px/1.3 system-ui,sans-serif;color:#d9eeee;background:#0a1819;height:100%;padding:8px;display:grid;grid-template-rows:auto auto 1fr auto;gap:8px;border-radius:6px}
.hmi button{font:700 11px system-ui;border:1px solid #2f5c5c;background:#16393a;color:#d9eeee;border-radius:4px;padding:5px 9px;cursor:pointer}
.hmi button:disabled{opacity:.4;cursor:default}.hmi .go{background:#1d7a52;border-color:#2fa874}.hmi .no{background:#8a2a1c;border-color:#c8503c}
.hh{display:flex;justify-content:space-between;align-items:center;font-weight:700;letter-spacing:.04em}
.led{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.hp{display:grid;grid-template-columns:repeat(4,1fr) auto;gap:6px;align-items:center;background:#102426;border:1px solid #234546;border-radius:6px;padding:6px 8px}
.hp small,.ht small{display:block;color:#7fa3a2;font-size:10px}.hp b{font-size:15px}
.hg{display:grid;grid-template-columns:1fr 1fr;gap:6px;align-content:start}
.ht{background:#102426;border:1px solid #234546;border-radius:6px;padding:6px 8px}.ht.warn{border-color:#d19a2e}.ht.bad{border-color:#e0583f}
.ht .big{font-size:20px;font-weight:700}.bar{height:5px;background:#1c3a3c;border-radius:3px;margin:3px 0 5px;overflow:hidden}.bar i{display:block;height:100%;background:#4fb3e0}
.hv{display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;font-size:11px}.hv span{display:flex;justify-content:space-between}
.al{background:#102426;border:1px solid #234546;border-radius:6px;padding:6px 8px;max-height:120px;overflow:auto;font-size:11px}
.al div{display:flex;gap:6px;justify-content:space-between;padding:1px 0}.al .c{color:#e0583f}.al .a{color:#d19a2e}
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

  useEffect(() => {
    if (!system) return
    supabase.from('ras_jar_overview').select('*').eq('system_id', system.id).order('station').order('line').order('position')
      .then(({ data }) => { if (data && data.length) setJars(data) })
  }, [system])
  useEffect(() => { const i = setInterval(() => setTick(t => t + 1), 900); return () => clearInterval(i) }, [])

  const s: Settings = useMemo(() => ({ ...DEFAULTS, ...(settings ?? {}) } as Settings), [settings])
  const run = cmd && !fault && !sumpLow
  const spd = run ? speed / 100 : 0
  const lines = useMemo(() => computeJars(jars, { ...s, line_head_m: s.line_head_m * spd * spd }), [jars, s, spd])
  const keys = lines.map(l => l.key)
  const tags = useMemo(() => buildTags(keys, 70, +(settings as any)?.do_min_mgl || 5), [keys.join(','), settings])
  const groups = useMemo(() => ['PUMP', ...keys], [keys.join(',')])
  const sel2 = groups.includes(sel) ? sel : 'PUMP'

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
    const raw = (tg: Tag, k: number): number => {
      const n = tg.tag, g = lq[tg.grp]
      if (tg.grp === 'PUMP') {
        if (n === 'PT-100') return run ? (s.line_head_m + 0.8) * spd * spd / 10.2 + nz(k, 0.004) : 0
        if (n === 'FT-100') return total + nz(k, 0.4)
        if (n === 'TT-100') return s.water_temp_c + nz(k, 0.08)
        return 7.4 + nz(k, 0.05)
      }
      if (n.startsWith('PT')) return run ? g.head / 10.2 + nz(k, 0.003) : 0
      if (n.startsWith('FT')) return g.Q + nz(k, 0.3)
      if (n.startsWith('TT')) return s.water_temp_c + nz(k, 0.1)
      if (n.startsWith('ZT')) return g.valve
      return n.endsWith('i') ? 7.2 + nz(k, 0.06) : 6.2 + nz(k, 0.08)
    }
    tags.forEach((tg, k) => {
      if (tg.io !== 'AI') return
      let mA = 4 + 16 * (raw(tg, k) - tg.lo) / (tg.hi - tg.lo)
      mA = Math.max(0, Math.min(24, mA))
      if (cuts.includes(tg.tag)) mA = 0.1
      if (mA < 3.8 || mA > 20.5) return void (o[tg.tag] = { v: null, mA, st: 'bad' })
      const v = tg.lo + (mA - 4) / 16 * (tg.hi - tg.lo)
      const st = !run || tg.alo == null ? 'ok' : v < tg.alo ? 'low' : tg.ahi != null && v > tg.ahi ? 'high' : 'ok'
      o[tg.tag] = { v, mA, st }
    })
    const di = (n: string, on: boolean, st: Rd['st'] = 'ok') => (o[n] = { v: on ? 1 : 0, mA: null, st })
    di('PUMP_RUN', run); di('PUMP_FAULT', fault, fault ? 'high' : 'ok'); di('SUMP_LOW', sumpLow, sumpLow ? 'low' : 'ok')
    di('PUMP_CMD', cmd)
    o['VFD_SPD'] = { v: run ? speed : 0, mA: null, st: 'ok' }
    return o
  }, [tick, tags, lines, cuts, run, fault, sumpLow, cmd, speed, spd, s])

  const alarms = tags.filter(t => rd[t.tag]?.st && rd[t.tag].st !== 'ok').map(t => ({ id: `${t.tag}:${rd[t.tag].st}`, t, r: rd[t.tag] }))
  const horn = alarms.some(a => !acked.includes(a.id))
  const ids = alarms.map(a => a.id).join('|')
  useEffect(() => { setAcked(p => { const n = p.filter(i => ids.split('|').includes(i)); return n.length === p.length ? p : n }) }, [ids])
  rd['HORN'] = { v: horn ? 1 : 0, mA: null, st: 'ok' }

  // ---- layout
  const nAI = Math.ceil(tags.filter(t => t.io === 'AI').length / 8)
  const modH = MOD_HEAD + 8 * CH
  const modY = (m: number) => TOP + m * (modH + MOD_GAP)
  const dioN = tags.filter(t => t.mod === 'DIO').length
  const dioY = modY(nAI)
  const plcBottom = dioY + MOD_HEAD + dioN * CH
  const term = (t: Tag) => {
    if (t.mod === 'DIO') return { x: PX - 4, y: dioY + MOD_HEAD + t.ch * CH + CH / 2 }
    const m = +t.mod.slice(3) - 1
    return { x: PX - 4, y: modY(m) + MOD_HEAD + t.ch * CH + CH / 2 }
  }
  let gy = 4
  const gpos: Record<string, { y: number; h: number; rows: Tag[] }> = {}
  for (const g of groups) {
    const rows = tags.filter(t => t.grp === g)
    const h = g === sel2 ? 30 + rows.length * ROW : 40
    gpos[g] = { y: gy, h, rows }; gy += h + 8
  }
  const H = Math.max(plcBottom + 16, gy + 8, 700)
  const gtitle = (g: string) => (g === 'PUMP' ? 'Pump and sump' : `Station ${g.split('-')[0]} · line ${g.split('-')[1]}`)
  const stCol = (st: string) => (st === 'bad' ? 'var(--bad)' : st === 'ok' ? 'var(--ok)' : 'var(--warn)')
  const worst = (g: string) => { const l = gpos[g].rows.map(t => rd[t.tag]?.st ?? 'ok'); return l.includes('bad') ? 'bad' : l.some(x => x !== 'ok') ? 'warn' : 'ok' }
  const cutTog = (tg: string) => setCuts(c => (c.includes(tg) ? c.filter(x => x !== tg) : [...c, tg]))
  const selTags = gpos[sel2].rows

  // HMI helpers
  const hv = (n: string) => (link ? rd[n] : undefined)
  const tile = (k: string) => {
    const n = lname(k), ft = hv(`FT-${n}`), tt = hv(`TT-${n}`), di = hv(`AT-${n}i`), dout = hv(`AT-${n}o`), pt = hv(`PT-${n}`), zt = hv(`ZT-${n}`)
    const ws = [ft, tt, di, dout, pt, zt].map(x => x?.st ?? 'ok')
    const cls = ws.includes('bad') ? 'bad' : ws.some(x => x !== 'ok') ? 'warn' : ''
    return (
      <div key={k} className={`ht ${cls}`}>
        <small>S{k.split('-')[0]} · LINE {k.split('-')[1]}{ws.includes('bad') ? ' · SENSOR FAULT' : ''}</small>
        <span className="big">{f(ft?.v ?? null, 0)}</span> <small style={{ display: 'inline' }}>L/min</small>
        <div className="bar"><i style={{ width: `${Math.min(100, ((ft?.v ?? 0) / 100) * 100)}%` }} /></div>
        <div className="hv">
          <span><small>Temp</small>{f(tt?.v ?? null)} °C</span><span><small>Press</small>{f(pt?.v ?? null, 2)} bar</span>
          <span><small>DO in</small>{f(di?.v ?? null)}</span><span><small>DO out</small>{f(dout?.v ?? null)}</span>
          <span><small>Valves</small>{f(zt?.v ?? null, 0)} %</span>
        </div>
      </div>
    )
  }

  return (
    <>
      <style>{CSS}</style>
      <div className="panel">
        <h2>Sensors to PLC to HMI</h2>
        <p className="note">Left: field sensors, each on its own 4-20 mA pair. Middle: PLC input modules with the terminal each sensor lands on. Right: the operator HMI, linked to the PLC by Ethernet. Click a sensor group to see its individual wires. Values are simulated from the jar model.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={() => setCmd(c => !c)}>{cmd ? 'Stop pump' : 'Start pump'}</button>
          <label className="slider">Pump speed <input type="range" min={40} max={100} value={speed} onChange={e => setSpeed(+e.target.value)} /> {speed}%</label>
          <button className="ghost" onClick={() => setFault(x => !x)}>{fault ? 'Clear pump fault' : 'Trip pump (fault)'}</button>
          <button className="ghost" onClick={() => setSumpLow(x => !x)}>{sumpLow ? 'Refill sump' : 'Sump low level'}</button>
          <button className="ghost" onClick={() => setLink(x => !x)}>{link ? 'Unplug Ethernet' : 'Plug in Ethernet'}</button>
          <button className="ghost" onClick={() => setCuts([])} disabled={!cuts.length}>Reconnect all sensors</button>
        </div>
      </div>
      <div className="panel sc">
        <svg viewBox={`0 0 1190 ${H}`} style={{ width: '100%', minWidth: 980, display: 'block' }} role="img" aria-label="Sensor to PLC to HMI wiring">
          {/* wires */}
          {tags.map(t => {
            const g = gpos[t.grp], isSel = t.grp === sel2, i = g.rows.indexOf(t)
            const x0 = GW, y0 = isSel ? g.y + 30 + i * ROW + ROW / 2 : g.y + g.h / 2, p = term(t)
            const r = rd[t.tag], cut = cuts.includes(t.tag), mx = (x0 + p.x) / 2
            const d = `M${x0},${y0} C${mx},${y0} ${mx},${p.y} ${p.x},${p.y}`
            const col = r?.st === 'bad' ? 'var(--bad)' : 'var(--flow)', op = isSel ? 1 : 0.28
            const outp = t.io === 'DO' || t.io === 'AO'
            return (
              <g key={t.tag + 'w'} opacity={op}>
                <path d={d} className={`pw ${cut || outp ? 'x' : ''}`} stroke={col} strokeDasharray={cut ? '60 400' : undefined} style={outp ? { animationDirection: 'reverse' } : undefined} />
                {cut && isSel && <text x={mx} y={(y0 + p.y) / 2} fill="var(--bad)" fontSize="11" textAnchor="middle" fontWeight="700">cut</text>}
              </g>
            )
          })}
          {/* sensor groups */}
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
                      <text x={84} y={y + 15} fill="var(--mute)" fontSize="11">{t.io === 'AI' ? `${f(r?.mA ?? null, 1)} mA` : t.io}</text>
                      <text x={GW - 10} y={y + 15} fill={stCol(r?.st ?? 'ok')} fontSize="11" textAnchor="end">{t.io === 'AI' ? `${f(r?.v ?? null, t.unit === 'bar' ? 2 : 1)} ${t.unit}` : t.unit === '%' ? `${f(r?.v ?? null, 0)} %` : r?.v ? 'ON' : 'off'}</text>
                    </g>
                  )
                })}
              </g>
            )
          })}
          {/* PLC */}
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
          {tags.map(t => {
            const p = term(t), r = rd[t.tag], hot = t.grp === sel2
            return (
              <g key={t.tag + 'm'}>
                <rect x={p.x - 2} y={p.y - 4} width={8} height={8} rx={2} fill={r?.st === 'bad' ? '#ff8b78' : hot ? '#6cc6ee' : '#5b7476'} />
                <text x={PX + 12} y={p.y + 3.5} fill={hot ? '#e3f1ef' : '#8ea8a6'} fontSize="9">{t.addr}</text>
                <text x={PX + 62} y={p.y + 3.5} fill={hot ? '#e3f1ef' : '#8ea8a6'} fontSize="9">{t.tag}</text>
                <text x={PX + PW} y={p.y + 3.5} fill={hot ? '#e3f1ef' : '#8ea8a6'} fontSize="9" textAnchor="end">{t.io === 'AI' ? `${f(r?.mA ?? null, 1)} mA` : t.io === 'AO' ? `${f(r?.v ?? null, 0)}%` : r?.v ? 'ON' : 'off'}</text>
              </g>
            )
          })}
          {/* Ethernet cable PLC -> HMI */}
          <path d={`M${PX + PW + 14},32 H800`} stroke="#0e1b1d" strokeWidth={7} fill="none" strokeLinecap="round" />
          <path d={`M${PX + PW + 14},32 H800`} stroke={link ? 'var(--flow)' : 'var(--bad)'} strokeWidth={3} fill="none" strokeDasharray={link ? '10 6' : '3 30'} className={link ? 'pw' : 'pw x'} style={{ strokeWidth: 3 }} />
          <text x={(PX + PW + 14 + 800) / 2} y={22} fill="var(--mute)" fontSize="11" textAnchor="middle">Ethernet · Modbus TCP</text>
          {/* HMI */}
          <rect x={800} y={2} width={386} height={Math.min(H - 8, 690)} rx={14} fill="#1b2829" stroke="#0e1b1d" strokeWidth={2} />
          <foreignObject x={810} y={12} width={366} height={Math.min(H - 28, 670)}>
            <div className="hmi">
              <div className="hh"><span>RAS HATCHERY · HMI</span>
                <span><span className="led" style={{ background: link ? '#5fcf9b' : '#ff8b78' }} />{link ? 'PLC ONLINE' : 'NO PLC LINK'}</span></div>
              <div className="hp">
                <div><small>PUMP</small><b style={{ color: link ? (rd['PUMP_RUN']?.v ? '#5fcf9b' : fault ? '#ff8b78' : '#9db8b5') : '#7fa3a2' }}>{!link ? '---' : fault ? 'FAULT' : sumpLow ? 'LOW SUMP' : rd['PUMP_RUN']?.v ? 'RUN' : 'STOP'}</b></div>
                <div><small>Speed</small><b>{link ? f(rd['VFD_SPD']?.v ?? null, 0) : '---'}%</b></div>
                <div><small>Discharge</small><b>{link ? f(rd['PT-100']?.v ?? null, 2) : '---'}</b></div>
                <div><small>Total L/min</small><b>{link ? f(rd['FT-100']?.v ?? null, 0) : '---'}</b></div>
                <div style={{ display: 'grid', gap: 4 }}>
                  <button className="go" disabled={!link || cmd} onClick={() => setCmd(true)}>START</button>
                  <button className="no" disabled={!link || !cmd} onClick={() => setCmd(false)}>STOP</button>
                </div>
              </div>
              <div className="hg">{keys.map(tile)}</div>
              <div>
                <div className="al">
                  {!link ? <div className="c"><span>PLC COMMUNICATION LOST · values not updating</span></div>
                    : alarms.length === 0 ? <div><span style={{ color: '#5fcf9b' }}>No active alarms</span></div>
                    : alarms.slice(0, 8).map(a => (
                      <div key={a.id} className={a.r.st === 'bad' ? 'c' : 'a'} style={{ opacity: acked.includes(a.id) ? 0.55 : 1 }}>
                        <span>{a.t.tag} · {a.t.desc}</span>
                        <span>{a.r.st === 'bad' ? 'SENSOR FAULT' : `${a.r.st.toUpperCase()}${a.r.v != null && a.t.io === 'AI' ? ' ' + f(a.r.v, 1) + ' ' + a.t.unit : ''}`}</span>
                      </div>
                    ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                  <span><span className="led" style={{ background: link && horn ? '#e0583f' : '#2c4645' }} />HORN</span>
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
                <td>{t.mod === 'DIO' ? 'DIO' : `${t.mod} / ch ${t.ch}`}</td>
                <td>{t.io === 'AI' ? `${f(r?.mA ?? null, 2)} mA` : t.io === 'AO' ? '4-20 mA out' : '24 V dry contact'}</td>
                <td>{t.io === 'AI' ? `${f(r?.v ?? null, t.unit === 'bar' ? 2 : 1)} ${t.unit}` : t.io === 'AO' ? `${f(r?.v ?? null, 0)} %` : r?.v ? 'ON' : 'off'}</td>
                <td className={cls}>{r?.st === 'bad' ? 'Wire break / fault' : r?.st === 'ok' ? 'OK' : r?.st}</td>
                <td>{t.io === 'AI' ? <button className="ghost" onClick={() => cutTog(t.tag)}>{cuts.includes(t.tag) ? 'Reconnect' : 'Cut wire'}</button> : ''}</td></tr>
            )
          })}</tbody>
        </table></div>
        <p className="note">A signal under 3.8 mA or over 20.5 mA is treated as a broken wire or failed sensor, as in ras_tag_readings. A real PLC reaches this app through a gateway that writes readings to the database.</p>
      </div>
    </>
  )
}
