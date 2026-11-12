import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { canEdit, useAuth } from '../lib/auth'
import { useSystem } from '../lib/useSystem'
import PlcHmi from './PlcHmi'

export default function Plc() {
  const { system } = useSystem()
  const { session, role } = useAuth()
  const [tags, setTags] = useState<any[]>([])
  const [alarms, setAlarms] = useState<any[]>([])
  const [tab, setTab] = useState<'hmi' | 'io'>('hmi')

  const load = () => {
    if (!system) return
    supabase.from('ras_plc_tags').select('*').eq('system_id', system.id).order('plc_address')
      .then(({ data }) => setTags(data ?? []))
    supabase.from('ras_active_alarms').select('*').eq('system_id', system.id).order('raised_at', { ascending: false })
      .then(({ data }) => setAlarms(data ?? []))
  }
  useEffect(load, [system])

  const ack = async (id: string) => {
    await supabase.from('ras_alarms')
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: session!.user.id }).eq('id', id)
    load()
  }

  return (
    <>
      <div className="seg" style={{ width: 'fit-content', marginBottom: 10 }}>
        <button className={tab === 'hmi' ? 'on' : ''} onClick={() => setTab('hmi')}>PLC + HMI connection</button>
        <button className={tab === 'io' ? 'on' : ''} onClick={() => setTab('io')}>I/O list and alarms</button>
      </div>
      {tab === 'hmi' ? <PlcHmi /> : <>
      <div className="panel">
        <h2>Active alarms</h2>
        {alarms.length === 0 ? <p className="note">No active alarms</p> : (
          <table className="tbl"><thead><tr><th>Raised</th><th>Tag</th><th>Description</th><th>State</th><th>Value</th><th></th></tr></thead>
            <tbody>{alarms.map(a => (
              <tr key={a.id}><td>{new Date(a.raised_at).toLocaleString()}</td><td>{a.tag}</td><td>{a.description}</td>
                <td>{a.state}</td><td>{a.value} {a.unit}</td>
                <td>{a.acknowledged_at ? 'Acknowledged' : <button disabled={!canEdit(role)} onClick={() => ack(a.id)}>Acknowledge</button>}</td></tr>
            ))}</tbody></table>
        )}
      </div>
      <div className="panel">
        <h2>I/O list</h2>
        <div className="sc"><table className="tbl">
          <thead><tr><th>Tag</th><th>Description</th><th>Type</th><th>Address</th><th>Range</th><th>Unit</th><th>Low alarm</th><th>High alarm</th></tr></thead>
          <tbody>{tags.map(t => (
            <tr key={t.id}><td>{t.tag}</td><td>{t.description}</td><td>{t.io_type}</td><td>{t.plc_address}</td>
              <td>{t.io_type === 'AI' ? `${t.range_lo} to ${t.range_hi}` : '-'}</td><td>{t.unit}</td><td>{t.alarm_lo}</td><td>{t.alarm_hi}</td></tr>
          ))}</tbody>
        </table></div>
        <p className="note">A browser cannot read a PLC directly. Live values need a gateway that writes to ras_tag_readings with the service-role key (see README).</p>
      </div>
      </>}
    </>
  )
}
