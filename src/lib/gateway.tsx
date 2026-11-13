import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { useSystem } from './useSystem'

// Whether the PLC gateway on the plant computer is reporting. The gateway writes ras_gateway_status every 15 s over
// the plant's Wi-Fi or Ethernet; anyone signed in can read it from anywhere.
export type Gw = { last_seen: string; mode: 'plc' | 'simulate'; plc_connected: boolean; tags_ok: number; tags_bad: number; message: string | null; host: string | null }

export function useGateway() {
  const { system } = useSystem()
  const sysId = system?.id
  const [g, setG] = useState<Gw | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!sysId) return
    let dead = false
    const load = async () => { const { data } = await supabase.from('ras_gateway_status').select('*').eq('system_id', sysId).maybeSingle(); if (!dead) setG((data as Gw) ?? null) }
    load()
    const i = setInterval(load, 10000), j = setInterval(() => setNow(Date.now()), 5000)
    return () => { dead = true; clearInterval(i); clearInterval(j) }
  }, [sysId])
  const age = g ? Math.max(0, (now - Date.parse(g.last_seen)) / 1000) : null
  const state: 'none' | 'online' | 'stale' | 'offline' = !g || age == null ? 'none' : age < 45 ? 'online' : age < 300 ? 'stale' : 'offline'
  return { g, age, state }
}

const ago = (s: number) => (s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`)

export function GatewayBadge() {
  const { g, age, state } = useGateway()
  const text = state === 'none' ? 'No gateway reporting yet'
    : state === 'offline' ? `Gateway offline · last seen ${ago(age!)}`
    : state === 'stale' ? `Gateway slow · last seen ${ago(age!)}`
    : !g!.plc_connected ? 'Gateway online · PLC not reachable'
    : g!.mode === 'simulate' ? `Gateway simulation · ${ago(age!)}` : `Gateway online · ${ago(age!)}`
  const cls = state === 'online' && g!.plc_connected && g!.mode === 'plc' ? 'ok' : state === 'none' ? 'n' : state === 'offline' || (state === 'online' && !g!.plc_connected) ? 'bad' : 'warn'
  return <span className={`gw ${cls}`} title={g ? `${g.host ?? ''} · ${g.tags_ok} tags ok, ${g.tags_bad} not ok${g.message ? ' · ' + g.message : ''}` : 'Start the gateway on the plant computer (see README)'}>{text}</span>
}
