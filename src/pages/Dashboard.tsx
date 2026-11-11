import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { canEdit, useAuth } from '../lib/auth'
import { useSystem } from '../lib/useSystem'
import { autoTune, computeJars } from '../lib/model'

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-')

export default function Dashboard() {
  const { system, settings, loading, error } = useSystem()
  const { role } = useAuth()
  const [jars, setJars] = useState<any[]>([])

  useEffect(() => {
    if (!system) return
    supabase.from('ras_jar_overview').select('*').eq('system_id', system.id)
      .order('station').order('line').order('position')
      .then(({ data }) => setJars(data ?? []))
  }, [system])

  const lines = useMemo(() => (settings ? computeJars(jars, settings) : []), [jars, settings])
  const all = lines.flatMap(l => l.rows)
  const total = all.reduce((a, r) => a + r.Q, 0)
  const inTarget = all.filter(r => r.st[1] === 'ok').length
  const active = all.filter(r => r.st[1] !== 'off').length

  const setOpen = (id: string, v: number) =>
    setJars(p => p.map(j => (j.jar_id === id ? { ...j, valve_open_pct: v } : j)))
  const saveOpen = (id: string, v: number) =>
    supabase.from('ras_jars').update({ valve_open_pct: v, updated_at: new Date().toISOString() }).eq('id', id)

  const [busy, setBusy] = useState(false)
  async function autoSet(rows: any[]) {
    setBusy(true)
    const opens = autoTune(rows, settings)
    setJars(p => p.map(j => {
      const i = rows.findIndex(r => r.jar.jar_id === j.jar_id)
      return i >= 0 ? { ...j, valve_open_pct: opens[i] } : j
    }))
    await Promise.all(rows.map((r, i) => r.jar.is_on ? saveOpen(r.jar.jar_id, opens[i]) : null))
    setBusy(false)
  }

  if (loading) return <p>Loading...</p>
  if (error) return <p className="bad">{error}</p>
  if (!system) return <p className="note">No RAS system yet. Open the Admin tab and create one.</p>

  return (
    <>
      <div className="kpis">
        <div className="k"><span>Whole RAS</span><b>{f(total, 0)}</b> <small>L/min</small></div>
        <div className="k"><span>Whole RAS</span><b>{f(total * 0.06, 1)}</b> <small>m3/h</small></div>
        <div className="k"><span>Jars in target range</span><b>{inTarget}</b> <small>of {active}</small></div>
        <div className="k"><span>Target bed expansion</span><b>{f(settings.target_bed_expansion)}x</b></div>
      </div>
      {lines.map(l => (
        <div className="panel" key={l.key}>
          <div className="row">
            <h2 style={{ flex: 1 }}>Station {l.key.split('-')[0]}, line {l.key.split('-')[1]}</h2>
            <button className="ghost" disabled={!canEdit(role) || busy} onClick={() => autoSet(l.rows)}>
              Auto-set valves to target
            </button>
          </div>
          <div className="sc">
            <table className="tbl">
              <thead><tr><th>Jar</th><th>Stage</th><th>Valve opening</th><th>Flow L/min</th><th>Target L/min</th><th>Expansion</th><th>Status</th></tr></thead>
              <tbody>
                {l.rows.map(r => (
                  <tr key={r.jar.jar_id}>
                    <td>{r.jar.jar_code}</td>
                    <td>{r.jar.stage}</td>
                    <td className="slider">
                      <input type="range" min={0} max={100} value={r.jar.valve_open_pct} disabled={!canEdit(role)}
                        onChange={e => setOpen(r.jar.jar_id, +e.target.value)}
                        onPointerUp={e => saveOpen(r.jar.jar_id, +e.currentTarget.value)}
                        onKeyUp={e => saveOpen(r.jar.jar_id, +e.currentTarget.value)} />
                      <span>{r.jar.valve_open_pct}%</span>
                    </td>
                    <td>{f(r.Q)}</td>
                    <td>{f(r.target)}</td>
                    <td>{r.x.r === Infinity ? 'washout' : f(r.x.r) + 'x'}</td>
                    <td className={r.st[1]}>{r.st[0]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <p className="note">Flows come from the fluidised-bed model with your Admin settings and each jar's latest measurements. Jars without measurements use the defaults (12 cm jar, 20 mm feeder, 1200 g of eggs).</p>
    </>
  )
}
