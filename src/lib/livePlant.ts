import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSystem } from './useSystem'
import { ATTRS, tagOf, type Attr, type Ctx } from './series'
import { fetchLatest, hasReadings } from './readings'
import { limOf, outside } from '../components/Chart'
import type { Lim } from './standards'

// Current value of every HMI attribute (481 items: RAS, pump, 6 lines, 108 jars), the alarms they raise, and an
// alarm journal. Values come from the PLC gateway once readings exist, otherwise from the simulation, where failures
// can be injected for training. Used by the SCADA screen.
export type Prio = 'critical' | 'high' | 'medium' | 'low'
export type Item = { key: string; tag: string; attr: Attr; ctx: Ctx; label: string; value: number; lim?: Lim; state: 'ok' | 'low' | 'high' | 'nodata' }
export type AlarmRec = { id: string; key: string; tag: string; label: string; prio: Prio; state: 'low' | 'high'; value: number; unit: string; dec: number; raisedAt: number; ackAt?: number }
export type JournalEntry = { at: number; kind: 'RAISED' | 'CLEARED' | 'ACK'; tag: string; label: string; prio: Prio }

export const LINES = ['1-A', '1-B', '2-A', '2-B', '3-A', '3-B']
const CRIT = ['sdo', 'ldout', 'jdo', 'nh3', 'no2'], HIGH = ['ph', 'stmp', 'ltmp', 'jtmp', 'lprs', 'jprs', 'pdis', 'jflow', 'ptot'], MED = ['alk', 'turb', 'cah', 'no3']
export const prioOf = (a: Attr): Prio => (CRIT.includes(a.id) ? 'critical' : HIGH.includes(a.id) ? 'high' : MED.includes(a.id) ? 'medium' : 'low')
export const PRIO_ORDER: Prio[] = ['critical', 'high', 'medium', 'low']

export const INJECTIONS = [
  { k: 'nh3', label: 'Ammonia spike' }, { k: 'no2', label: 'Nitrite appears' }, { k: 'no3', label: 'Nitrate appears' }, { k: 'ph', label: 'pH crash' },
  { k: 'alk', label: 'Alkalinity high' }, { k: 'turb', label: 'Turbid water' }, { k: 'cah', label: 'Calcium hardness high' },
  { k: 'heat', label: 'Water too warm' }, { k: 'lowdo', label: 'Low oxygen' }, { k: 'block', label: 'Jar S1-A #5 blocked' },
]
const TO: Record<string, number> = { nh3: 2.6, no2: 1.3, no3: 135, ph: 6.3, alk: 160, turb: 38, cah: 260 }
function applyFail(a: Attr, c: Ctx, v: number, r: Record<string, number>) {
  if (a.id in TO) v = v + (TO[a.id] - v) * (r[a.id] ?? 0)
  if (a.id === 'stmp' || a.id === 'ltmp' || a.id === 'jtmp') v += 3.8 * (r.heat ?? 0)
  if (a.id === 'sdo' || a.id === 'ldin' || a.id === 'ldout' || a.id === 'jdo') v = Math.max(0, v - 3.4 * (r.lowdo ?? 0))
  if (c.li === 0 && c.pos === 5 && (r.block ?? 0) > 0) { if (a.id === 'jflow') v *= 1 - 0.92 * r.block; if (a.id === 'jdo') v = Math.max(0, v * (1 - 0.9 * r.block)) }
  return v
}

export const itemKey = (a: Attr, c: Ctx) => (a.scope === 'line' ? `${a.id}|${c.li}` : a.scope === 'jar' ? `${a.id}|${c.li}|${c.pos}` : a.id)
const code = (li: number) => `S${LINES[li].replace('-', '·')}`

type Def = { key: string; tag: string; attr: Attr; ctx: Ctx; label: string }
function buildDefs(): Def[] {
  const out: Def[] = []
  for (const a of ATTRS) {
    if (a.scope === 'ras' || a.scope === 'pump') { const c = { li: 0, pos: 0 }; out.push({ key: itemKey(a, c), tag: tagOf(a, c), attr: a, ctx: c, label: a.label }) }
    else if (a.scope === 'line') for (let li = 0; li < 6; li++) { const c = { li, pos: 0 }; out.push({ key: itemKey(a, c), tag: tagOf(a, c), attr: a, ctx: c, label: `${code(li)} ${a.label}` }) }
    else for (let li = 0; li < 6; li++) for (let pos = 1; pos <= 18; pos++) { const c = { li, pos }; out.push({ key: itemKey(a, c), tag: tagOf(a, c), attr: a, ctx: c, label: `${code(li)} jar ${pos} ${a.label}` }) }
  }
  return out
}

export function useLivePlant() {
  const { system } = useSystem()
  const sysId = system?.id
  const defs = useMemo(buildDefs, [])
  const [plc, setPlc] = useState(false)
  const [tick, setTick] = useState(0)
  const [latest, setLatest] = useState<Record<string, number>>({})
  const [updatedAt, setUpdatedAt] = useState(Date.now())
  const [inject, setInject] = useState<string[]>([])
  const [ramp, setRamp] = useState<Record<string, number>>({})
  const [alarms, setAlarms] = useState<AlarmRec[]>([])
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const rec = useRef(new Map<string, AlarmRec>())

  useEffect(() => { if (sysId) hasReadings().then(setPlc).catch(() => setPlc(false)) }, [sysId])
  useEffect(() => { const i = setInterval(() => setTick(t => t + 1), plc ? 5000 : 2000); return () => clearInterval(i) }, [plc])
  useEffect(() => {
    if (!plc || !sysId) return
    let dead = false
    fetchLatest(sysId, defs.map(d => d.tag)).then(r => { if (!dead) { setLatest(r); setUpdatedAt(Date.now()) } }).catch(() => { /* keep last values */ })
    return () => { dead = true }
  }, [plc, sysId, tick, defs])
  useEffect(() => {
    if (plc) return
    setRamp(p => { const n: Record<string, number> = {}; for (const x of INJECTIONS) { const c = p[x.k] ?? 0, tg = inject.includes(x.k) ? 1 : 0; n[x.k] = c + Math.max(-0.25, Math.min(0.2, tg - c)) } return n })
  }, [tick, inject, plc])

  const items: Item[] = useMemo(() => {
    const now = Date.now()
    return defs.map(d => {
      const lim = limOf(d.attr)
      const value = plc ? (d.tag in latest ? latest[d.tag] : NaN) : applyFail(d.attr, d.ctx, d.attr.fn(now, d.ctx), ramp)
      const state: Item['state'] = !Number.isFinite(value) ? 'nodata' : outside(value, lim, d.attr.dec) ? (lim && lim[0] != null && value < lim[0] ? 'low' : 'high') : 'ok'
      return { ...d, value, lim, state }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defs, plc, latest, ramp, tick])
  const byKey = useMemo(() => new Map(items.map(i => [i.key, i])), [items])
  const get = useCallback((id: string, li = 0, pos = 0) => {
    const a = ATTRS.find(x => x.id === id)!
    return byKey.get(itemKey(a, { li, pos }))
  }, [byKey])

  useEffect(() => {
    const now = Date.now(), active = new Map<string, Item>(), jr: JournalEntry[] = []
    for (const it of items) if (it.state === 'low' || it.state === 'high') active.set(`${it.key}:${it.state}`, it)
    for (const [id, it] of active) {
      const ex = rec.current.get(id)
      if (!ex) {
        const r: AlarmRec = { id, key: it.key, tag: it.tag, label: it.label, prio: prioOf(it.attr), state: it.state as 'low' | 'high', value: it.value, unit: it.attr.unit, dec: it.attr.dec, raisedAt: now }
        rec.current.set(id, r); jr.push({ at: now, kind: 'RAISED', tag: r.tag, label: r.label, prio: r.prio })
      } else ex.value = it.value
    }
    for (const [id, r] of [...rec.current]) if (!active.has(id)) { rec.current.delete(id); jr.push({ at: now, kind: 'CLEARED', tag: r.tag, label: r.label, prio: r.prio }) }
    const rank = (p: Prio) => PRIO_ORDER.indexOf(p)
    setAlarms([...rec.current.values()].sort((a, b) => rank(a.prio) - rank(b.prio) || b.raisedAt - a.raisedAt))
    if (jr.length) setJournal(j => [...jr, ...j].slice(0, 300))
  }, [items])

  const ack = useCallback((id: string) => {
    const r = rec.current.get(id); if (!r || r.ackAt) return
    r.ackAt = Date.now()
    setAlarms(a => a.map(x => (x.id === id ? { ...x, ackAt: r.ackAt } : x)))
    setJournal(j => [{ at: r.ackAt!, kind: 'ACK' as const, tag: r.tag, label: r.label, prio: r.prio }, ...j].slice(0, 300))
  }, [])
  const ackAll = useCallback(() => { for (const r of [...rec.current.values()]) ack(r.id) }, [ack])
  const unacked = alarms.filter(a => !a.ackAt)
  const counts = Object.fromEntries(PRIO_ORDER.map(p => [p, alarms.filter(a => a.prio === p).length])) as Record<Prio, number>
  const toggleInject = (k: string) => setInject(a => (a.includes(k) ? a.filter(x => x !== k) : [...a, k]))
  return { items, get, source: (plc ? 'plc' : 'sim') as 'plc' | 'sim', plc, sysId, updatedAt, alarms, journal, ack, ackAll, unacked, counts, inject, toggleInject, clearInject: () => setInject([]) }
}
