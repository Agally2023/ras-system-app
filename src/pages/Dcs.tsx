import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useSystem } from '../lib/useSystem'
import { SoundToggle, useAlarmSound } from '../lib/alarmSound'
import { GatewayBadge } from '../lib/gateway'

// DCS: control-oriented view. Three PID loops (pump speed -> pressure, aeration valve -> sump oxygen, heater/chiller
// -> water temperature) with faceplates, AUTO/MAN modes, setpoints, interlocks and deviation alarms. Loop settings
// come from ras_control_loops. Until a PLC runs these loops, the process behind them is a simple simulation
// (each tick = 10 s of plant time) so operators can practise tuning and upsets.

type Mode = 'auto' | 'man'
type Loop = { code: 'F' | 'D' | 'T'; name: string; pv: string; unit: string; dec: number; sp: number; kp: number; ti: number; omin: number; omax: number; hi?: number; mode: Mode; man: number; out: number; val: number; prev: number; hist: { pv: number; sp: number; out: number }[] }
const DEF: Record<string, Partial<Loop>> = {
  F: { name: 'Pump speed', pv: 'Supply pressure', unit: 'bar', dec: 2, sp: 0.2, kp: 60, ti: 15, omin: 0, omax: 110, hi: 0.6 },
  D: { name: 'Aeration valve', pv: 'Sump oxygen', unit: 'mg/L', dec: 1, sp: 6.5, kp: 40, ti: 120, omin: 0, omax: 100 },
  T: { name: 'Heater and chiller', pv: 'Water temperature', unit: '°C', dec: 1, sp: 29, kp: 50, ti: 180, omin: -100, omax: 100 },
}
const OUTU: Record<string, string> = { F: '% speed', D: '% open', T: '% (− cool / + heat)' }
const DT = 10, N = 90
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const mk = (c: 'F' | 'D' | 'T'): Loop => {
  const d = DEF[c] as Loop, pv = c === 'F' ? 0.2 : c === 'D' ? 6.5 : 29, out = c === 'F' ? 78 : c === 'D' ? 58 : 0
  return { ...d, code: c, mode: 'auto', man: out, out, val: pv, prev: 0, hist: [] }
}
const css = `
.dcs-g{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.dcs-f{background:var(--card);border:2px solid var(--line);border-radius:10px;padding:12px}.dcs-f.al{border-color:var(--bad)}
.dcs-f h3{margin:0 0 6px;display:flex;justify-content:space-between;gap:6px;align-items:center}
.dcs-r{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;text-align:center;margin:8px 0}
.dcs-r b{display:block;font-size:22px}.dcs-r small{color:var(--mute)}
.dcs-m{display:flex;gap:4px}.dcs-m button{flex:1}.dcs-m button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
.dcs-in{display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap}.dcs-in input{width:84px}
.dcs-t{width:100%;border-collapse:collapse;font-size:13px}.dcs-t td,.dcs-t th{padding:5px 6px;border-top:1px solid var(--line);text-align:left}.dcs-t th{color:var(--mute);font-weight:500}
.dcs-bar{height:10px;background:var(--line);border-radius:5px;overflow:hidden;position:relative}.dcs-bar i{position:absolute;top:0;bottom:0;background:var(--acc)}
.dcs-il{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:700;color:#fff;background:var(--bad)}.dcs-il.ok{background:var(--ok)}
`
function Trend({ L }: { L: Loop }) {
  const W = 300, H = 90, hs = L.hist
  if (hs.length < 2) return <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%' }} />
  const vs = hs.flatMap(h => [h.pv, h.sp]), lo = Math.min(...vs), hi = Math.max(...vs), pad = (hi - lo || 1) * 0.2
  const y = (v: number) => H - 4 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 8), x = (i: number) => (i / (N - 1)) * W
  const yo = (v: number) => H - 4 - ((v - L.omin) / (L.omax - L.omin)) * (H - 8)
  const path = (f: (h: Loop['hist'][number]) => number) => hs.map((h, i) => `${i ? 'L' : 'M'}${x(i + N - hs.length).toFixed(1)},${f(h).toFixed(1)}`).join('')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', background: 'var(--panel)', borderRadius: 6 }} role="img" aria-label={`${L.pv} trend`}>
      <path d={path(h => yo(h.out))} fill="none" stroke="var(--mute)" strokeWidth={1} opacity={0.6} />
      <path d={path(h => y(h.sp))} fill="none" stroke="var(--warn)" strokeWidth={1.2} strokeDasharray="4 3" />
      <path d={path(h => y(h.pv))} fill="none" stroke="var(--flow)" strokeWidth={2} />
    </svg>
  )
}

export default function Dcs() {
  const { system } = useSystem()
  const sysId: string | undefined = system?.id
  const loops = useRef<Record<string, Loop>>({ F: mk('F'), D: mk('D'), T: mk('T') })
  const [, bump] = useState(0)
  const [sump, setSump] = useState(1.2)           // sump level, m (interlock below 0.5)
  const sumpR = useRef(1.2)
  const dist = useRef({ warm: false, load: false, pipe: false, drain: false })
  const [dst, setDst] = useState({ warm: false, load: false, pipe: false, drain: false })
  const [log, setLog] = useState<string[]>([])
  const [saved, setSaved] = useState('')
  const [edit, setEdit] = useState<Record<string, string>>({})
  const [acked, setAcked] = useState('')
  const say = (m: string) => setLog(l => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 40))

  useEffect(() => {
    if (!sysId) return
    supabase.from('ras_control_loops').select('*').eq('system_id', sysId).then(({ data }) => {
      for (const r of data ?? []) {
        const L = loops.current[r.code]; if (!L) continue
        L.sp = +r.setpoint; L.kp = +r.kp; L.ti = +r.ti_s; L.omin = +r.out_min; L.omax = +r.out_max
        if (r.high_limit != null) L.hi = +r.high_limit
        L.mode = r.mode === 'manual' || r.mode === 'man' ? 'man' : 'auto'; L.man = +r.manual_output || L.out
      }
      bump(n => n + 1)
    })
  }, [sysId])

  useEffect(() => {
    const id = setInterval(() => {
      const d = dist.current, F = loops.current.F, D = loops.current.D, T = loops.current.T
      // sump level: pump draws, return refills; draining test lowers it
      sumpR.current = clamp(sumpR.current + (d.drain ? -0.05 : 0.02), 0, 1.5); setSump(sumpR.current)
      const lowLvl = sumpR.current < 0.5
      for (const L of [F, D, T]) {
        // controller
        const pv = L.val, e = L.sp - pv
        let u = L.out
        if (L.mode === 'auto') u = clamp(L.out + L.kp * (e - L.prev) + (L.kp * DT / L.ti) * e, L.omin, L.omax)
        else u = clamp(L.man, L.omin, L.omax)
        L.prev = e
        // interlocks override the output
        if (L.code === 'F') { if (lowLvl) u = 0; else if ((L.hi ?? 9) < pv) u = Math.min(u, L.out - 5) }
        if (L.code === 'D' && D.val < 4) u = L.omax
        if (L.code === 'T' && T.val > 31.5) u = Math.min(u, -100)
        if (L.mode === 'auto' || u !== L.out) L.man = L.mode === 'auto' ? u : L.man
        L.out = u
      }
      // process models (first order)
      const fOut = d.pipe ? F.out * 0.6 : F.out
      F.val += (0.33 * (fOut / 100) ** 2 - F.val) * (DT / 20)
      D.val += ((3 + 0.06 * D.out - (d.load ? 2.5 : 0)) - D.val) * (DT / 60)
      T.val += ((29 + 0.04 * T.out + (d.warm ? 4 : 0)) - T.val) * (DT / 300)
      for (const L of [F, D, T]) { L.hist.push({ pv: L.val, sp: L.sp, out: L.out }); if (L.hist.length > N) L.hist.shift() }
      bump(n => n + 1)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const L = loops.current, lowLvl = sump < 0.5
  const il = [
    { k: 'low', on: lowLvl, t: 'Low sump level: pump stopped', c: 'critical' },
    { k: 'hp', on: L.F.hi != null && L.F.val > L.F.hi, t: `High supply pressure (> ${L.F.hi} bar): pump speed limited`, c: 'high' },
    { k: 'lo2', on: L.D.val < 4, t: 'Low sump oxygen (< 4 mg/L): aeration forced fully open', c: 'critical' },
    { k: 'ht', on: L.T.val > 31.5, t: 'High water temperature (> 31.5 °C): chiller forced to maximum', c: 'high' },
  ]
  const dev = (c: 'F' | 'D' | 'T') => { const l = L[c]; return Math.abs(l.val - l.sp) > (c === 'F' ? 0.08 : c === 'D' ? 1 : 1.5) }
  const alarms = [...il.filter(i => i.on).map(i => ({ k: i.k, t: i.t, c: i.c })), ...(['F', 'D', 'T'] as const).filter(c => dev(c) && L[c].mode === 'auto').map(c => ({ k: 'dev' + c, t: `${L[c].pv} deviates from setpoint`, c: 'medium' }))]
  const key = alarms.map(a => a.k).join(',')
  const sounding = useAlarmSound(alarms.length > 0 && acked !== key, alarms.some(a => a.c === 'critical') && acked !== key)

  const setMode = (c: 'F' | 'D' | 'T', m: Mode) => { const l = L[c]; if (l.mode === m) return; l.man = l.out; l.prev = l.sp - l.val; l.mode = m; say(`${l.name}: ${m.toUpperCase()} mode`); bump(n => n + 1) }
  const toggle = (k: keyof typeof dst) => { dist.current[k] = !dist.current[k]; setDst({ ...dist.current }); say(`Test upset ${k}: ${dist.current[k] ? 'ON' : 'OFF'}`) }
  const save = async (c: 'F' | 'D' | 'T') => {
    const l = L[c]
    const { error } = await supabase.from('ras_control_loops').update({ setpoint: l.sp, kp: l.kp, ti_s: l.ti, mode: l.mode === 'auto' ? 'auto' : 'manual', manual_output: l.man }).eq('system_id', sysId).eq('code', c)
    if (error) return setSaved(`Not saved: ${error.message}`)
    await supabase.from('ras_control_events').insert({ system_id: sysId, message: `Loop ${c} (${l.name}): setpoint ${l.sp}, kp ${l.kp}, ti ${l.ti}s, ${l.mode}` })
    setSaved(`Saved loop ${c} at ${new Date().toLocaleTimeString()}`)
  }
  const num = (c: 'F' | 'D' | 'T', f: 'sp' | 'kp' | 'ti' | 'man', v: string) => {
    const n = parseFloat(v); setEdit(e => ({ ...e, [c + f]: v })); if (!Number.isFinite(n)) return
    const l = L[c]; if (f === 'man') l.man = clamp(n, l.omin, l.omax); else (l as any)[f] = n
  }

  return (
    <div className="dk">
      <style>{css}</style>
      <div className="panel">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>DCS · Control loops</h2>
          <span className="dk-sim">Simulated process</span><GatewayBadge /><SoundToggle />
          {sounding && <button style={{ background: 'var(--bad)', borderColor: 'var(--bad)', color: '#fff' }} onClick={() => setAcked(key)}>Silence alarms</button>}
          <span style={{ flex: 1 }} />
          <span className={`dcs-il ${alarms.length ? '' : 'ok'}`}>{alarms.length ? `${alarms.length} alarm${alarms.length > 1 ? 's' : ''}` : 'All loops normal'}</span>
        </div>
        <small className="note">Each second is 10 s of plant time. Change setpoints, switch to manual, or trigger an upset and watch the loops respond. Saving writes the loop settings to the database for the PLC.</small>
      </div>

      <div className="dcs-g" style={{ marginTop: 12 }}>
        {(['F', 'D', 'T'] as const).map(c => {
          const l = L[c], d = dev(c), pc = (l.out - l.omin) / (l.omax - l.omin)
          return (
            <div key={c} className={`dcs-f ${d && l.mode === 'auto' ? 'al' : ''}`}>
              <h3><span>{c} · {l.name}</span><span className="dcs-il" style={{ background: l.mode === 'auto' ? 'var(--ok)' : 'var(--warn)', color: l.mode === 'auto' ? '#fff' : '#1b1b1b' }}>{l.mode.toUpperCase()}</span></h3>
              <small className="note">{l.pv}</small>
              <div className="dcs-r">
                <div><small>PV</small><b style={{ color: d ? 'var(--bad)' : 'var(--ink)' }}>{l.val.toFixed(l.dec)}</b><small>{l.unit}</small></div>
                <div><small>SP</small><b>{l.sp.toFixed(l.dec)}</b><small>{l.unit}</small></div>
                <div><small>OUT</small><b>{l.out.toFixed(0)}</b><small>{OUTU[c]}</small></div>
              </div>
              <div className="dcs-bar"><i style={{ left: l.omin < 0 ? `${Math.min(pc, 0.5) * 100}%` : 0, width: l.omin < 0 ? `${Math.abs(pc - 0.5) * 100}%` : `${pc * 100}%` }} /></div>
              <Trend L={l} />
              <div className="dcs-m" style={{ marginTop: 8 }}>
                <button className={l.mode === 'auto' ? 'on' : ''} onClick={() => setMode(c, 'auto')}>AUTO</button>
                <button className={l.mode === 'man' ? 'on' : ''} onClick={() => setMode(c, 'man')}>MAN</button>
              </div>
              <div className="dcs-in">
                <label>SP <input type="number" step="any" value={edit[c + 'sp'] ?? l.sp} onChange={e => num(c, 'sp', e.target.value)} /></label>
                {l.mode === 'man' && <label>OUT <input type="number" step="any" value={edit[c + 'man'] ?? l.man} onChange={e => num(c, 'man', e.target.value)} /></label>}
              </div>
              <div className="dcs-in"><label>Kp <input type="number" step="any" value={edit[c + 'kp'] ?? l.kp} onChange={e => num(c, 'kp', e.target.value)} /></label>
                <label>Ti (s) <input type="number" step="any" value={edit[c + 'ti'] ?? l.ti} onChange={e => num(c, 'ti', e.target.value)} /></label>
                <button className="ghost" disabled={!sysId} onClick={() => save(c)}>Save</button></div>
            </div>
          )
        })}
      </div>
      {saved && <small className="note" style={{ display: 'block', marginTop: 6 }}>{saved}</small>}

      <div className="dcs-g" style={{ marginTop: 12 }}>
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Interlocks and alarms</h3>
          <table className="dcs-t"><tbody>
            {il.map(i => <tr key={i.k}><td><span className={`dcs-il ${i.on ? '' : 'ok'}`}>{i.on ? 'TRIPPED' : 'OK'}</span></td><td>{i.t}</td></tr>)}
            {(['F', 'D', 'T'] as const).map(c => <tr key={c}><td><span className={`dcs-il ${dev(c) && L[c].mode === 'auto' ? '' : 'ok'}`}>{dev(c) && L[c].mode === 'auto' ? 'DEV' : 'OK'}</span></td><td>Loop {c} deviation from setpoint</td></tr>)}
          </tbody></table>
          <p style={{ margin: '8px 0 0' }}>Sump level: <b>{sump.toFixed(2)} m</b></p>
        </div>
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Test upsets</h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {([['warm', 'Hot day (+4 °C)'], ['load', 'Heavy feeding (O₂ demand)'], ['pipe', 'Partly blocked pipe'], ['drain', 'Sump draining']] as const).map(([k, t]) =>
              <button key={k} className="ghost" style={dst[k] ? { background: 'var(--bad)', borderColor: 'var(--bad)', color: '#fff' } : undefined} onClick={() => toggle(k)}>{t}</button>)}
          </div>
          <h3>Group overview</h3>
          <table className="dcs-t"><thead><tr><th>Loop</th><th>Mode</th><th>PV</th><th>SP</th><th>OUT</th></tr></thead><tbody>
            {(['F', 'D', 'T'] as const).map(c => <tr key={c}><td>{c} {L[c].name}</td><td>{L[c].mode.toUpperCase()}</td><td>{L[c].val.toFixed(L[c].dec)}</td><td>{L[c].sp}</td><td>{L[c].out.toFixed(0)}</td></tr>)}
          </tbody></table>
        </div>
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Operator log</h3>
          <div style={{ maxHeight: 220, overflow: 'auto', fontSize: 13 }}>{log.length ? log.map((m, i) => <div key={i}>{m}</div>) : <span style={{ color: 'var(--mute)' }}>No actions yet</span>}</div>
        </div>
      </div>
    </div>
  )
}
