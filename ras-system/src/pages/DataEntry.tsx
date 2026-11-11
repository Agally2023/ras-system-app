import { FormEvent, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { canEdit, useAuth } from '../lib/auth'
import { useSystem } from '../lib/useSystem'

const MEAS: [string, string][] = [
  ['jar_diameter_cm', 'Jar diameter at the egg bed (cm)'], ['drop_pipe_id_mm', 'Feeder pipe inside diameter (mm)'],
  ['jar_volume_l', 'Jar volume (L)'], ['spout_depth_cm', 'Water depth to spout (cm)'],
  ['egg_mass_g', 'Egg mass (g)'], ['egg_stage', 'Egg stage (1 to 4)'],
  ['settled_height_cm', 'Settled egg height (cm)'], ['bed_height_flow_cm', 'Bed height during flow (cm)'],
  ['do_inlet_mgl', 'Oxygen, inlet (mg/L)'], ['do_overflow_mgl', 'Oxygen, overflow (mg/L)'],
]

export default function DataEntry() {
  const { system } = useSystem()
  const { role } = useAuth()
  const [jars, setJars] = useState<any[]>([])
  const [tests, setTests] = useState<any[]>([])
  const [jarId, setJarId] = useState('')
  const [bt, setBt] = useState({ time_s: '', volume_l: '' })
  const [ms, setMs] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')
  const edit = canEdit(role)

  const loadTests = () =>
    supabase.from('ras_bucket_tests').select('*, ras_jars(position)').order('tested_at', { ascending: false }).limit(20)
      .then(({ data }) => setTests(data ?? []))

  useEffect(() => {
    if (!system) return
    supabase.from('ras_jar_overview').select('jar_id, jar_code').eq('system_id', system.id)
      .order('station').order('line').order('position')
      .then(({ data }) => { setJars(data ?? []); if (data?.length) setJarId(data[0].jar_id) })
    loadTests()
  }, [system])

  async function addTest(e: FormEvent) {
    e.preventDefault()
    const { error } = await supabase.from('ras_bucket_tests')
      .insert({ jar_id: jarId, time_s: +bt.time_s, volume_l: +bt.volume_l })
    setMsg(error ? error.message : 'Bucket test saved')
    if (!error) { setBt({ time_s: '', volume_l: '' }); loadTests() }
  }

  async function addMeasurement(e: FormEvent) {
    e.preventDefault()
    const row: Record<string, any> = { jar_id: jarId }
    MEAS.forEach(([k]) => { if (ms[k] !== undefined && ms[k] !== '') row[k] = +ms[k] })
    const { error } = await supabase.from('ras_jar_measurements').insert(row)
    setMsg(error ? error.message : 'Measurements saved')
  }

  const jarSelect = (
    <label>Jar
      <select value={jarId} onChange={e => setJarId(e.target.value)}>
        {jars.map(j => <option key={j.jar_id} value={j.jar_id}>{j.jar_code}</option>)}
      </select>
    </label>
  )

  return (
    <>
      {!edit && <p className="note">Your role is read only. Ask an admin for operator access to enter data.</p>}
      {msg && <p className="note">{msg}</p>}
      <form className="panel" onSubmit={addTest}>
        <h2>Bucket test</h2>
        <p className="note">Collect the overflow of one jar in a bucket. Flow = 60 x volume / time.</p>
        {jarSelect}
        <label>Time (s)<input type="number" step="0.1" min="0" required value={bt.time_s} onChange={e => setBt({ ...bt, time_s: e.target.value })} /></label>
        <label>Volume (L)<input type="number" step="0.05" min="0" required value={bt.volume_l} onChange={e => setBt({ ...bt, volume_l: e.target.value })} /></label>
        <button disabled={!edit || !jarId}>Save bucket test</button>
      </form>
      <div className="panel">
        <h2>Latest bucket tests</h2>
        <div className="sc"><table className="tbl">
          <thead><tr><th>When</th><th>Time (s)</th><th>Volume (L)</th><th>Flow (L/min)</th></tr></thead>
          <tbody>{tests.map(t => (
            <tr key={t.id}><td>{new Date(t.tested_at).toLocaleString()}</td><td>{t.time_s}</td><td>{t.volume_l}</td><td>{(+t.flow_lpm).toFixed(2)}</td></tr>
          ))}</tbody>
        </table></div>
      </div>
      <form className="panel" onSubmit={addMeasurement}>
        <h2>Measurement sheet</h2>
        <p className="note">Leave optional fields blank. These values drive the model for that jar.</p>
        {jarSelect}
        <div className="set">
          {MEAS.map(([k, label]) => (
            <label key={k}>{label}
              <input type="number" step="any" value={ms[k] ?? ''} onChange={e => setMs({ ...ms, [k]: e.target.value })} />
            </label>
          ))}
        </div>
        <button disabled={!edit || !jarId}>Save measurements</button>
      </form>
    </>
  )
}
