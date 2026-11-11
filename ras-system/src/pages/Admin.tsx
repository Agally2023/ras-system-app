import { FormEvent, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useSystem } from '../lib/useSystem'

const FIELDS: [string, string][] = [
  ['pump_shutoff_head_m', 'Pump shutoff head, m'], ['pump_free_flow_lpm', 'Pump free flow, L/min'],
  ['valve_capacity_lpm_per_rm', 'Valve capacity open, L/min per root m'], ['line_head_m', 'Head at the start of each line, m'],
  ['pump_margin_pct', 'Pump margin, %'], ['do_min_mgl', 'Lowest acceptable oxygen at overflow, mg/L'],
  ['do_supply_mgl', 'Dissolved oxygen in the supply, mg/L'], ['o2_use_mg_per_kg_h', 'Oxygen use, mg per kg eggs per h'],
  ['sump_volume_m3', 'Sump volume, m3'], ['aeration_kla_per_min', 'Aeration transfer rate, per min'],
  ['background_do_demand', 'Background oxygen demand, mg/L per min'], ['ambient_temp_c', 'Ambient temperature, C'],
  ['heater_power_c_per_min', 'Heater or chiller power, C per min'], ['site_altitude_m', 'Site altitude, m'],
  ['water_temp_c', 'Water temperature, C'], ['stations', 'Stations'], ['lines_per_station', 'Lines per station'],
  ['jars_per_line', 'Jars per line'], ['stage34_share_pct', 'Share of jars at stage 3 and 4, %'],
  ['stage34_flow_boost_pct', 'Stage 3 and 4 flow increase, % (max 10)'], ['header_diameter_mm', 'Line header inside diameter, mm'],
  ['jar_spacing_m', 'Jar spacing along the header, m'], ['max_egg_mass_g', 'Maximum egg mass per jar, g'],
  ['egg_diameter_mm', 'Egg diameter, mm'], ['egg_density_kg_m3', 'Egg density, kg per m3'],
  ['target_bed_expansion', 'Target bed expansion (1.1 to 1.8)'], ['bucket_volume_l', 'Bucket volume, L'],
]

export default function Admin() {
  const { system, settings, loading, reload } = useSystem()
  const { role } = useAuth()
  const [form, setForm] = useState<Record<string, string>>({})
  const [name, setName] = useState('Main RAS')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (settings) setForm(Object.fromEntries(FIELDS.map(([k]) => [k, String(settings[k])])))
  }, [settings])

  if (loading) return <p>Loading...</p>
  if (role !== 'admin') return <p className="note">Admin settings are only available to admins.</p>

  async function create(e: FormEvent) {
    e.preventDefault()
    const { error } = await supabase.rpc('ras_create_system', { p_name: name })
    setMsg(error ? error.message : 'System created')
    reload()
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    FIELDS.forEach(([k]) => { patch[k] = +form[k] })
    const { error } = await supabase.from('ras_settings').update(patch).eq('system_id', system.id)
    setMsg(error ? error.message : 'Settings saved')
  }

  async function rebuild() {
    const { error } = await supabase.rpc('ras_seed_layout', { p_system: system.id })
    setMsg(error ? error.message : 'Layout updated. Missing stations, lines and jars were added.')
  }

  if (!system) return (
    <form className="panel" onSubmit={create}>
      <h2>Create your RAS system</h2>
      <label>Name<input value={name} onChange={e => setName(e.target.value)} required /></label>
      <button>Create system</button>
      {msg && <p className="note">{msg}</p>}
    </form>
  )

  return (
    <form className="panel" onSubmit={save}>
      <h2>Admin: pump, valve and egg settings for {system.name}</h2>
      <div className="set">
        {FIELDS.map(([k, label]) => (
          <label key={k}>{label}
            <input type="number" step="any" value={form[k] ?? ''} onChange={e => setForm({ ...form, [k]: e.target.value })} />
          </label>
        ))}
      </div>
      <div className="row">
        <button type="submit">Save settings</button>
        <button type="button" className="ghost" onClick={rebuild}>Add missing jars from layout settings</button>
      </div>
      {msg && <p className="note">{msg}</p>}
    </form>
  )
}
