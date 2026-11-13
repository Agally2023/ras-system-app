// RAS PLC gateway. Reads the PLC over Modbus TCP and writes ras_tag_readings and ras_alarms, using the tag list
// in ras_plc_tags (address, range, alarm limits). Run `node gateway.mjs --simulate` to test the whole path
// without a PLC. Needs Node 18+.
import { createClient } from '@supabase/supabase-js'

const env = process.env
const need = k => { if (!env[k]) { console.error(`Missing ${k}. See .env.example`); process.exit(1) } return env[k] }
const SIM = env.SIMULATE === '1' || process.argv.includes('--simulate')
const num = (k, d) => (env[k] != null && env[k] !== '' ? +env[k] : d)
const FAST = num('POLL_SECONDS', 10) * 1000, JAR = num('JAR_POLL_SECONDS', 60) * 1000
const R4 = num('AI_RAW_4MA', 5530), R20 = num('AI_RAW_20MA', 27648), SCALE = num('REG_SCALE', 100), AI_FC = num('AI_FUNCTION', 3)
const BASE = { iw: num('IW_BASE', 0), mw: num('MW_BASE', 0), qw: num('QW_BASE', 0) }
const ZERO_TOL = num('ZERO_TOL', 0.01)

const sb = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
const log = (...a) => console.log(new Date().toISOString(), ...a)

// ---- tag list ---------------------------------------------------------------------------------------------
async function loadTags() {
  let sid = env.SYSTEM_ID
  if (!sid) { const { data, error } = await sb.from('ras_systems').select('id').limit(1); if (error) throw error; sid = data?.[0]?.id }
  if (!sid) throw new Error('No system found in ras_systems')
  const { data, error } = await sb.from('ras_plc_tags').select('id,tag,io_type,plc_address,unit,range_lo,range_hi,alarm_lo,alarm_hi').eq('system_id', sid).range(0, 4999)
  if (error) throw error
  const tags = []
  for (const t of data) {
    const a = t.plc_address ?? ''
    let m
    if ((m = /^%IW(\d+)$/.exec(a))) tags.push({ ...t, kind: 'iw', n: +m[1] + BASE.iw })
    else if ((m = /^%MW(\d+)$/.exec(a))) tags.push({ ...t, kind: 'mw', n: +m[1] + BASE.mw })
    else if ((m = /^%QW(\d+)$/.exec(a))) tags.push({ ...t, kind: 'qw', n: +m[1] + BASE.qw })
    else if ((m = /^%I(\d+)\.(\d)$/.exec(a))) tags.push({ ...t, kind: 'di', n: +m[1] * 8 + +m[2] })
    else if ((m = /^%Q(\d+)\.(\d)$/.exec(a))) tags.push({ ...t, kind: 'do', n: +m[1] * 8 + +m[2] })
  }
  log(`System ${sid}: ${tags.length} of ${data.length} tags have a supported address`)
  return tags
}

// ---- conversion and limits ---------------------------------------------------------------------------------
function limit(t, v) {
  if (t.alarm_lo != null && v < +t.alarm_lo) return 'low'
  if (t.alarm_hi != null && v > +t.alarm_hi + (+t.alarm_hi === 0 ? ZERO_TOL : 0)) return 'high'
  return 'ok'
}
function convert(t, raw) {
  if (t.kind === 'iw') {
    const mA = 4 + (16 * (raw - R4)) / (R20 - R4)
    if (mA < 3.8 || mA > 20.5) return { value: null, mA, state: 'bad' }          // wire break or failed sensor
    const v = +t.range_lo + ((mA - 4) / 16) * (+t.range_hi - +t.range_lo)
    return { value: v, mA, state: limit(t, v) }
  }
  if (t.kind === 'mw' || t.kind === 'qw') {
    const s = raw > 32767 ? raw - 65536 : raw
    if (s === -32768) return { value: null, mA: null, state: 'bad' }
    const v = s / SCALE
    return { value: v, mA: null, state: t.kind === 'mw' ? limit(t, v) : 'ok' }
  }
  const on = raw ? 1 : 0
  return { value: on, mA: null, state: t.tag === 'PUMP_FAULT' && on ? 'high' : t.tag === 'SUMP_LOW' && on ? 'low' : 'ok' }
}

// ---- reading the PLC ---------------------------------------------------------------------------------------
let modbus
async function plc() {
  if (modbus?.isOpen) return modbus
  const { default: ModbusRTU } = await import('modbus-serial')
  modbus = new ModbusRTU()
  await modbus.connectTCP(need('PLC_HOST'), { port: num('PLC_PORT', 502) })
  modbus.setID(num('PLC_UNIT', 1)); modbus.setTimeout(3000)
  log('PLC connected')
  return modbus
}
async function block(read, nums) {                       // read contiguous blocks of up to 100 registers or bits
  const out = new Map(), sorted = [...new Set(nums)].sort((a, b) => a - b)
  for (let i = 0; i < sorted.length;) {
    let j = i; while (j + 1 < sorted.length && sorted[j + 1] - sorted[i] < 100 && sorted[j + 1] - sorted[j] < 20) j++
    const start = sorted[i], len = sorted[j] - start + 1, r = await read(start, len)
    for (let k = 0; k < len; k++) out.set(start + k, r.data[k])
    i = j + 1
  }
  return out
}
async function readTags(tags) {
  const c = await plc(), res = []
  const by = k => tags.filter(t => t.kind === k)
  const groups = [
    ['iw', (s, l) => (AI_FC === 4 ? c.readInputRegisters(s, l) : c.readHoldingRegisters(s, l))],
    ['mw', (s, l) => c.readHoldingRegisters(s, l)], ['qw', (s, l) => c.readHoldingRegisters(s, l)],
    ['di', (s, l) => c.readDiscreteInputs(s, l)], ['do', (s, l) => c.readCoils(s, l)],
  ]
  for (const [k, read] of groups) {
    const ts = by(k); if (!ts.length) continue
    const m = await block(read, ts.map(t => t.n))
    for (const t of ts) if (m.has(t.n)) res.push({ t, ...convert(t, m.get(t.n)) })
  }
  return res
}
function simulate(tags) {                                // plausible values inside each tag's normal band
  const ph = Date.now() / 60000
  return tags.map((t, i) => {
    if (t.kind === 'di' || t.kind === 'do') return { t, ...convert(t, t.tag === 'PUMP_RUN' || t.tag === 'PUMP_CMD' ? 1 : 0) }
    const lo = t.alarm_lo != null ? +t.alarm_lo : null, hi = t.alarm_hi != null ? +t.alarm_hi : null
    const mid = lo != null && hi != null ? (lo + hi) / 2 : hi != null ? hi * 0.5 : lo != null ? lo * 1.3 : (+t.range_hi - +t.range_lo) * 0.45 + +t.range_lo
    const v = mid * (1 + 0.03 * Math.sin(ph + i))
    return { t, value: v, mA: t.kind === 'iw' ? 4 + (16 * (v - t.range_lo)) / (t.range_hi - t.range_lo) : null, state: t.kind === 'qw' ? 'ok' : limit(t, v) }
  })
}

// ---- writing readings and alarms ---------------------------------------------------------------------------
const open = new Map()                                   // tag_id -> { id, state }
async function loadOpenAlarms() {
  const { data, error } = await sb.from('ras_alarms').select('id,tag_id,state').is('cleared_at', null)
  if (error) throw error
  for (const a of data) open.set(a.tag_id, { id: a.id, state: a.state })
}
async function store(rows) {
  const at = new Date().toISOString()
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from('ras_tag_readings').insert(rows.slice(i, i + 500).map(r => ({ tag_id: r.t.id, read_at: at, value: r.value, milliamps: r.mA, state: r.state })))
    if (error) throw error
  }
  const clear = [], raise = []
  for (const r of rows) {
    const cur = open.get(r.t.id)
    if (r.state === 'ok') { if (cur) { clear.push(cur.id); open.delete(r.t.id) } continue }
    if (cur && cur.state === r.state) continue
    if (cur) { clear.push(cur.id); open.delete(r.t.id) }
    raise.push({ tag_id: r.t.id, state: r.state, value: r.value, raised_at: at })
  }
  if (clear.length) { const { error } = await sb.from('ras_alarms').update({ cleared_at: at }).in('id', clear); if (error) throw error }
  if (raise.length) {
    const { data, error } = await sb.from('ras_alarms').insert(raise).select('id,tag_id,state'); if (error) throw error
    for (const a of data) open.set(a.tag_id, { id: a.id, state: a.state })
  }
  return { raised: raise.length, cleared: clear.length }
}

// ---- main loop ---------------------------------------------------------------------------------------------
const tags = await loadTags()
await loadOpenAlarms()
const fast = tags.filter(t => t.kind !== 'mw'), jar = tags.filter(t => t.kind === 'mw')
let busy = false
async function cycle(set, name) {
  if (busy || !set.length) return
  busy = true
  try {
    const rows = SIM ? simulate(set) : await readTags(set), r = await store(rows)
    log(`${name}: ${rows.length} readings stored, ${rows.filter(x => x.state !== 'ok').length} not ok, alarms +${r.raised} -${r.cleared}`)
  } catch (e) {
    log(`${name}: ${e.message ?? e}`); try { modbus?.close(() => {}) } catch { /* reconnect on the next cycle */ } modbus = undefined
  } finally { busy = false }
}
async function rollup() {
  const { data, error } = await sb.rpc('ras_rollup_readings')
  log(error ? `rollup failed: ${error.message}` : `rollup: ${data} tag-hours summarised`)
}
log(SIM ? 'Simulation mode: no PLC is read' : `Polling PLC ${env.PLC_HOST} every ${FAST / 1000} s (jars every ${JAR / 1000} s)`)
await cycle(fast, 'plant'); await cycle(jar, 'jars'); await rollup()
setInterval(() => cycle(fast, 'plant'), FAST)
setInterval(() => cycle(jar, 'jars'), JAR)
setInterval(rollup, 3600000)
