import { useEffect, useMemo, useState } from 'react'
import { Chart, CHART_CSS, f, limTxt } from '../components/Chart'
import { ATTRS, series, tagOf, type Attr, type Ctx, type Pt, type Range } from '../lib/series'
import { fetchSeries } from '../lib/readings'
import { INJECTIONS, LINES, PRIO_ORDER, prioOf, useLivePlant, type Item, type Prio } from '../lib/livePlant'
import { SoundToggle, useAlarmSound } from '../lib/alarmSound'
import { GatewayBadge } from '../lib/gateway'

// SCADA: plant-wide supervision. A live mimic of the whole RAS (sump, pumps, supply header, 3 stations x 2 lines with
// all 108 jars, drum filter, biofilter, water-quality analysers), an alarm summary with acknowledge and a journal,
// trends for any tag, and a tag browser. It shares its data with the Dashboard: PLC readings once the gateway has
// written any, a simulation before that.

const CSS = `
@keyframes scf{to{stroke-dashoffset:-16}}@keyframes scb{50%{opacity:.25}}
.sc-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.sc-pipe{fill:none;stroke:var(--pipe);stroke-width:10;stroke-linecap:round;stroke-linejoin:round}
.sc-flow{fill:none;stroke:var(--flow);stroke-width:3.5;stroke-dasharray:9 7;animation:scf .9s linear infinite;stroke-linecap:round;stroke-linejoin:round}
.sc-flow.off{animation:none;stroke:var(--mute);opacity:.4}
.sc-blink{animation:scb 1s steps(2) infinite}
.sc-i{cursor:pointer}.sc-i:hover rect.sc-bx{stroke:var(--acc)}
.sc-pr{font-size:11px;font-weight:700;padding:1px 7px;border-radius:4px;color:#fff;display:inline-block}
.sc-pr.critical{background:var(--bad)}.sc-pr.high{background:#d9822b}.sc-pr.medium{background:var(--warn);color:#1b1b1b}.sc-pr.low{background:var(--mute)}
.sc-cnt{display:inline-flex;gap:4px;align-items:center;font-size:13px}
.sc-two{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:12px;align-items:start}
@media(max-width:1000px){.sc-two{grid-template-columns:1fr}}
.sc-tbl{width:100%;border-collapse:collapse;font-size:13px}.sc-tbl th{color:var(--mute);font-weight:500;text-align:left;padding:4px 6px;position:sticky;top:0;background:var(--panel)}
.sc-tbl td{padding:4px 6px;border-top:1px solid var(--line)}.sc-tbl tr.un td{font-weight:700}.sc-tbl tr.ak td{opacity:.7}
.sc-scroll{max-height:340px;overflow:auto}
.sc-tabs{display:flex;gap:4px;margin-bottom:8px}.sc-tabs button{padding:4px 10px}.sc-tabs button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
`

type Trend = { id: string; li: number; pos: number }
const PRIO_COL = (p: Prio) => (p === 'critical' || p === 'high' ? 'var(--bad)' : 'var(--warn)')

function useTrend(attr: Attr, ctx: Ctx, range: Range, plc: boolean, sysId: string | undefined, tick: number): Pt[] {
  const [real, setReal] = useState<Pt[]>([])
  const key = range === 'live' ? tick : Math.floor(Date.now() / 15000)
  const sim = useMemo(() => (plc ? [] : series(attr, range, Date.now(), ctx)), [plc, attr, ctx.li, ctx.pos, range, key])
  useEffect(() => {
    if (!plc || !sysId) return
    let dead = false
    fetchSeries(sysId, [attr], range, Date.now(), ctx).then(r => { if (!dead) setReal(r[attr.id] ?? []) }).catch(() => { if (!dead) setReal([]) })
    return () => { dead = true }
  }, [plc, sysId, attr, ctx.li, ctx.pos, range, key])
  return plc ? real : sim
}

export default function Scada() {
  const P = useLivePlant()
  const { items, get, source, alarms, journal, unacked, counts } = P
  const [sel, setSel] = useState({ li: 0, pos: 1 })
  const [trend, setTrend] = useState<Trend>({ id: 'nh3', li: 0, pos: 1 })
  const [range, setRange] = useState<Range>('live')
  const [tab, setTab] = useState<'active' | 'journal'>('active')
  const [filter, setFilter] = useState('')
  const [rows, setRows] = useState(40)
  const [prioF, setPrioF] = useState<Prio | 'all'>('all')

  const critUn = unacked.some(a => a.prio === 'critical')
  const sounding = useAlarmSound(unacked.length > 0, critUn)
  const unKeys = useMemo(() => new Set(unacked.map(a => a.key)), [unacked])
  const jarState = useMemo(() => {
    const m = new Map<string, Prio | 'ok' | 'nodata'>()
    for (const it of items) {
      if (it.attr.scope !== 'jar') continue
      const k = `${it.ctx.li}|${it.ctx.pos}`, cur = m.get(k) ?? 'ok'
      const nx: Prio | 'ok' | 'nodata' = it.state === 'nodata' ? 'nodata' : it.state === 'ok' ? 'ok' : prioOf(it.attr)
      const rank = (x: string) => (x === 'ok' ? 9 : x === 'nodata' ? 8 : PRIO_ORDER.indexOf(x as Prio))
      m.set(k, rank(nx) < rank(cur) ? nx : cur)
    }
    return m
  }, [items])

  const col = (it?: Item) => (!it || it.state === 'nodata' ? 'var(--mute)' : it.state === 'ok' ? 'var(--ink)' : PRIO_COL(prioOf(it.attr)))
  const txt = (it?: Item, d?: number) => (it && Number.isFinite(it.value) ? it.value.toFixed(d ?? it.attr.dec) : '---')
  const pick = (id: string, li = 0, pos = 1) => { setTrend({ id, li, pos }) }
  const flowing = (get('ptot')?.value ?? 0) > 5

  // ---- mimic pieces
  const Inst = ({ x, y, w = 92, label, it, unit = true }: { x: number; y: number; w?: number; label: string; it?: Item; unit?: boolean }) => (
    <g className={`sc-i ${it && unKeys.has(it.key) ? 'sc-blink' : ''}`} onClick={() => it && pick(it.attr.id, it.ctx.li, it.ctx.pos || 1)}>
      <rect className="sc-bx" x={x} y={y} width={w} height={30} rx={5} fill="var(--panel)" stroke={it && it.state !== 'ok' && it.state !== 'nodata' ? col(it) : 'var(--line)'} strokeWidth={it && it.state !== 'ok' && it.state !== 'nodata' ? 2 : 1} />
      <text x={x + 6} y={y + 11} fontSize="9" fill="var(--mute)">{label}</text>
      <text x={x + 6} y={y + 25} fontSize="13" fontWeight="700" fill={col(it)}>{txt(it)}<tspan fontSize="9" fontWeight="400" fill="var(--mute)"> {unit && it ? it.attr.unit : ''}</tspan></text>
    </g>
  )
  const card = (li: number) => {
    const x = 380 + (li % 2) * 210, y = 80 + Math.floor(li / 2) * 160, on = sel.li === li
    const r = (id: string) => get(id, li)
    const fl = r('lflow'), pr = r('lprs'), tm = r('ltmp'), di = r('ldin'), dO = r('ldout'), vl = r('lvalve')
    const lineAl = [fl, pr, tm, di, dO].some(i => i && i.state !== 'ok' && i.state !== 'nodata')
    return (
      <g key={li}>
        <rect x={x} y={y} width={200} height={140} rx={8} fill="var(--card)" stroke={on ? 'var(--acc)' : lineAl ? 'var(--bad)' : 'var(--line)'} strokeWidth={on || lineAl ? 2 : 1} />
        <text x={x + 8} y={y + 16} fontSize="13" fontWeight="700" fill="var(--ink)">Station {LINES[li].replace('-', ' line ')}</text>
        {[['Flow', fl, 'L/min', 1], ['Pressure', pr, 'bar', 2], ['Temp', tm, '°C', 1], ['O₂ in', di, 'mg/L', 1], ['O₂ out', dO, 'mg/L', 1], ['Valves', vl, '%', 0]].map(([n, it, u, d], i) => (
          <g key={n as string} className="sc-i" onClick={() => pick((it as Item).attr.id, li, 1)}>
            <text x={x + 8} y={y + 34 + i * 17} fontSize="10.5" fill="var(--mute)">{n as string}</text>
            <text x={x + 62} y={y + 34 + i * 17} fontSize="11.5" fontWeight="700" fill={col(it as Item)} className={unKeys.has((it as Item).key) ? 'sc-blink' : ''}>{txt(it as Item, d as number)} <tspan fontSize="9" fontWeight="400" fill="var(--mute)">{u as string}</tspan></text>
          </g>
        ))}
        <text x={x + 128} y={y + 30} fontSize="9" fill="var(--mute)">18 jars</text>
        {Array.from({ length: 18 }, (_, i) => {
          const pos = i + 1, st = jarState.get(`${li}|${pos}`) ?? 'ok', sl = sel.li === li && sel.pos === pos
          const fill = st === 'ok' ? 'var(--ok)' : st === 'nodata' ? 'var(--mute)' : PRIO_COL(st as Prio)
          return <rect key={pos} className="sc-i" x={x + 112 + (i % 6) * 14} y={y + 36 + Math.floor(i / 6) * 14} width={11} height={11} rx={2} fill={fill} opacity={st === 'ok' ? 0.55 : 1} stroke={sl ? 'var(--ink)' : 'none'} strokeWidth={2}
            onClick={() => { setSel({ li, pos }); setTrend(t => ({ id: ATTRS.find(a => a.id === t.id)?.scope === 'jar' ? t.id : 'jdo', li, pos })) }}><title>{`Jar ${pos}`}</title></rect>
        })}
        <text x={x + 112} y={y + 100} fontSize="9" fill="var(--mute)">Selected: jar {sel.li === li ? sel.pos : '-'}</text>
      </g>
    )
  }
  const wq = ['nh3', 'no2', 'no3', 'ph', 'alk', 'turb', 'cah', 'hard']

  // ---- trend and tag browser
  const tAttr = ATTRS.find(a => a.id === trend.id)!, tCtx = useMemo(() => ({ li: trend.li, pos: trend.pos }), [trend.li, trend.pos])
  const pts = useTrend(tAttr, tCtx, range, P.plc, P.sysId, Math.floor(Date.now() / 2000))
  const shown = useMemo(() => items.filter(i => (!filter || (i.tag + ' ' + i.label).toLowerCase().includes(filter.toLowerCase()))), [items, filter])
  const list = alarms.filter(a => prioF === 'all' || a.prio === prioF)
  const t2 = (t: number) => new Date(t).toLocaleTimeString()

  return (
    <div className="dk">
      <style>{CHART_CSS}{CSS}</style>
      <div className="panel">
        <div className="sc-bar">
          <h2 style={{ margin: 0, marginRight: 8 }}>SCADA · Hatchery RAS</h2>
          <span className="dk-sim" style={source === 'plc' ? { borderColor: 'var(--ok)', color: 'var(--ok)' } : undefined}>{source === 'plc' ? 'PLC data' : 'Simulated data'}</span>
          <GatewayBadge />
          <SoundToggle />
          {sounding && <button style={{ background: 'var(--bad)', borderColor: 'var(--bad)', color: '#fff' }} onClick={P.ackAll}>Silence and acknowledge all</button>}
          <span style={{ flex: 1 }} />
          {PRIO_ORDER.map(p => <span key={p} className="sc-cnt"><span className={`sc-pr ${p}`}>{p}</span><b>{counts[p]}</b></span>)}
          <button className="ghost" disabled={!unacked.length} onClick={P.ackAll}>Acknowledge all ({unacked.length})</button>
        </div>
        {source === 'sim' && (
          <div className="sc-bar" style={{ marginTop: 8 }}>
            <small className="note">Training: make something fail.</small>
            {INJECTIONS.map(x => <button key={x.k} className={`ghost ${P.inject.includes(x.k) ? 'on' : ''}`} style={P.inject.includes(x.k) ? { background: 'var(--bad)', borderColor: 'var(--bad)', color: '#fff' } : undefined} onClick={() => P.toggleInject(x.k)}>{x.label}</button>)}
            <button className="ghost" disabled={!P.inject.length} onClick={P.clearInject}>Clear all</button>
          </div>
        )}
      </div>

      <div className="panel sc" style={{ padding: 6 }}>
        <svg viewBox="0 0 1100 640" style={{ width: '100%', minWidth: 880, display: 'block' }} role="img" aria-label="Plant mimic">
          {/* pipework: supply header, drops to each line, overflow return, treatment, back to sump */}
          {[0, 1, 2].map(s => <path key={s} className="sc-pipe" d={`M330,${72 + s * 160} H690`} />)}
          <path className="sc-pipe" d="M330,500 V72" /><path className="sc-pipe" d="M150,500 H197 M233,500 H330" />
          {[0, 1, 2].flatMap(s => [480, 690].map(x => <path key={`${s}-${x}`} className="sc-pipe" d={`M${x},${72 + s * 160} V${80 + s * 160}`} />))}
          {[0, 1, 2].map(s => <path key={`r${s}`} className="sc-pipe" d={`M790,${150 + s * 160} H820`} />)}
          <path className="sc-pipe" d="M820,150 V600 H800 M650,600 H620 M480,600 H150" />
          <rect x={650} y={582} width={150} height={36} rx={6} fill="var(--panel)" stroke="var(--line)" /><text x={725} y={604} fontSize="12" textAnchor="middle" fill="var(--ink)">Drum filter</text>
          <rect x={480} y={582} width={140} height={36} rx={6} fill="var(--panel)" stroke="var(--line)" /><text x={550} y={604} fontSize="12" textAnchor="middle" fill="var(--ink)">Biofilter</text>
          <g>
            <path className={`sc-flow ${flowing ? '' : 'off'}`} d="M150,500 H197 M233,500 H330 V72" />
            {[0, 1, 2].map(s => <path key={s} className={`sc-flow ${flowing ? '' : 'off'}`} d={`M330,${72 + s * 160} H690`} />)}
            {[0, 1, 2].flatMap(s => [480, 690].map(x => <path key={`${s}-${x}`} className={`sc-flow ${flowing ? '' : 'off'}`} d={`M${x},${72 + s * 160} V${80 + s * 160}`} />))}
            {[0, 1, 2].map(s => <path key={`r${s}`} className={`sc-flow ${flowing ? '' : 'off'}`} d={`M790,${150 + s * 160} H820`} />)}
            <path className={`sc-flow ${flowing ? '' : 'off'}`} d="M820,150 V600 H800 M650,600 H620 M480,600 H150" />
          </g>
          {/* sump and pumps */}
          <rect x={20} y={440} width={130} height={170} rx={8} fill="var(--panel)" stroke="var(--line)" strokeWidth={2} />
          <rect x={24} y={478} width={122} height={128} rx={5} fill="var(--water)" opacity={0.7} />
          <text x={85} y={460} fontSize="13" fontWeight="700" textAnchor="middle" fill="var(--ink)">Sump</text>
          <Inst x={34} y={490} w={102} label="Temperature" it={get('stmp')} /><Inst x={34} y={528} w={102} label="Dissolved O₂" it={get('sdo')} />
          {[500, 555].map((y, i) => (
            <g key={y}><circle cx={215} cy={y} r={18} fill="var(--card)" stroke={i === 0 && flowing ? 'var(--ok)' : 'var(--mute)'} strokeWidth={3} />
              <path d={`M207,${y - 9} L226,${y} L207,${y + 9} Z`} fill={i === 0 && flowing ? 'var(--ok)' : 'var(--mute)'} />
              <text x={215} y={y + 34} fontSize="10" textAnchor="middle" fill="var(--mute)">P-{i + 1} {i === 0 ? (flowing ? 'duty · run' : 'duty · stop') : 'standby'}</text></g>
          ))}
          <path className="sc-pipe" d="M150,555 H197 M233,555 H260 V500" />
          <Inst x={238} y={400} w={84} label="Discharge" it={get('pdis')} /><Inst x={238} y={436} w={84} label="Supply flow" it={get('ptot')} /><Inst x={238} y={368} w={84} label="Pump speed" it={get('pspd')} />
          {[0, 1, 2, 3, 4, 5].map(card)}
          {[0, 1, 2].map(s => <text key={s} x={700} y={s * 160 + 68} fontSize="11" fill="var(--mute)">Station {s + 1} supply</text>)}
          <text x={830} y={380} fontSize="11" fill="var(--mute)">Overflow</text>
          {/* water quality analysers */}
          <rect x={850} y={60} width={240} height={420} rx={8} fill="var(--card)" stroke="var(--line)" />
          <text x={862} y={82} fontSize="13" fontWeight="700" fill="var(--ink)">Water quality · whole RAS</text>
          {wq.map((id, i) => {
            const it = get(id), y = 94 + i * 47
            return (
              <g key={id} className={`sc-i ${it && unKeys.has(it.key) ? 'sc-blink' : ''}`} onClick={() => pick(id)}>
                <rect className="sc-bx" x={858} y={y} width={224} height={41} rx={5} fill="var(--panel)" stroke={it && (it.state === 'low' || it.state === 'high') ? col(it) : 'var(--line)'} strokeWidth={it && (it.state === 'low' || it.state === 'high') ? 2 : 1} />
                <text x={866} y={y + 15} fontSize="11" fill="var(--mute)">{it?.attr.label}</text>
                <text x={866} y={y + 34} fontSize="15" fontWeight="700" fill={col(it)}>{txt(it)}<tspan fontSize="10" fontWeight="400" fill="var(--mute)"> {it?.attr.unit}</tspan></text>
                <text x={1074} y={y + 34} fontSize="10" fill="var(--mute)" textAnchor="end">{limTxt(it?.lim, it?.attr.dec ?? 1)}</text>
                <circle cx={1068} cy={y + 12} r={5} fill={it?.state === 'ok' ? 'var(--ok)' : it?.state === 'nodata' ? 'var(--mute)' : col(it)} />
              </g>
            )
          })}
          <text x={850} y={510} fontSize="11" fill="var(--mute)">Jar squares: green normal, red or amber</text>
          <text x={850} y={526} fontSize="11" fill="var(--mute)">out of standard, grey no data.</text>
          <text x={850} y={542} fontSize="11" fill="var(--mute)">Click any value or jar to trend it.</text>
        </svg>
      </div>

      <div className="sc-two">
        <div className="panel">
          <div className="sc-tabs">
            <button className={tab === 'active' ? 'on' : ''} onClick={() => setTab('active')}>Active alarms ({alarms.length})</button>
            <button className={tab === 'journal' ? 'on' : ''} onClick={() => setTab('journal')}>Alarm journal ({journal.length})</button>
            <span style={{ flex: 1 }} />
            {tab === 'active' && <select value={prioF} onChange={e => setPrioF(e.target.value as Prio | 'all')}><option value="all">All priorities</option>{PRIO_ORDER.map(p => <option key={p} value={p}>{p}</option>)}</select>}
          </div>
          <div className="sc-scroll">
            {tab === 'active' ? (
              <table className="sc-tbl"><thead><tr><th>Raised</th><th>Priority</th><th>Tag</th><th>Description</th><th>Value</th><th>State</th><th></th></tr></thead>
                <tbody>
                  {list.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--ok)' }}>No active alarms</td></tr>}
                  {list.slice(0, 200).map(a => (
                    <tr key={a.id} className={a.ackAt ? 'ak' : 'un'}>
                      <td>{t2(a.raisedAt)}</td><td><span className={`sc-pr ${a.prio}`}>{a.prio}</span></td><td>{a.tag}</td><td>{a.label}</td>
                      <td>{f(a.value, a.dec)} {a.unit}</td><td style={{ color: PRIO_COL(a.prio) }}>{a.state === 'high' ? 'HIGH' : 'LOW'}</td>
                      <td>{a.ackAt ? <small>acked {t2(a.ackAt)}</small> : <button className="ghost" onClick={() => P.ack(a.id)}>Ack</button>}</td>
                    </tr>
                  ))}
                </tbody></table>
            ) : (
              <table className="sc-tbl"><thead><tr><th>Time</th><th>Event</th><th>Priority</th><th>Tag</th><th>Description</th></tr></thead>
                <tbody>
                  {journal.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--mute)' }}>No events yet</td></tr>}
                  {journal.slice(0, 200).map((j, i) => <tr key={i}><td>{t2(j.at)}</td><td>{j.kind}</td><td><span className={`sc-pr ${j.prio}`}>{j.prio}</span></td><td>{j.tag}</td><td>{j.label}</td></tr>)}
                </tbody></table>
            )}
          </div>
        </div>
        <div className="panel">
          <div className="sc-bar" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Trend</h3>
            <div className="seg">{([['live', 'Live'], ['hour', 'Hourly'], ['day', 'Daily'], ['week', 'Weekly']] as [Range, string][]).map(([k, l]) => <button key={k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{l}</button>)}</div>
          </div>
          <div className="sc-bar" style={{ marginBottom: 8 }}>
            <select value={trend.id} onChange={e => setTrend(t => ({ ...t, id: e.target.value }))}>{ATTRS.map(a => <option key={a.id} value={a.id}>{a.label} ({a.scope})</option>)}</select>
            {tAttr.scope !== 'ras' && tAttr.scope !== 'pump' && <select value={trend.li} onChange={e => setTrend(t => ({ ...t, li: +e.target.value }))}>{LINES.map((l, i) => <option key={l} value={i}>Station {l.replace('-', ' line ')}</option>)}</select>}
            {tAttr.scope === 'jar' && <select value={trend.pos} onChange={e => setTrend(t => ({ ...t, pos: +e.target.value }))}>{Array.from({ length: 18 }, (_, i) => <option key={i} value={i + 1}>Jar {i + 1}</option>)}</select>}
          </div>
          <Chart key={trend.id + range + trend.li + trend.pos} a={tAttr} pts={pts} range={range} tag={tagOf(tAttr, tCtx)} />
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="sc-bar" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Tag browser</h3>
          <input placeholder="Search tag or description, for example JO-2B or ammonia" value={filter} onChange={e => { setFilter(e.target.value); setRows(40) }} style={{ minWidth: 280 }} />
          <small className="note">{shown.length} of {items.length} tags</small>
        </div>
        <div className="sc-scroll" style={{ maxHeight: 360 }}>
          <table className="sc-tbl"><thead><tr><th>Tag</th><th>Description</th><th>Value</th><th>Standard</th><th>State</th></tr></thead>
            <tbody>{shown.slice(0, rows).map(i => (
              <tr key={i.key} style={{ cursor: 'pointer' }} onClick={() => { setTrend({ id: i.attr.id, li: i.ctx.li, pos: i.ctx.pos || 1 }); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>
                <td>{i.tag}</td><td>{i.label}</td><td style={{ color: col(i) }}>{txt(i)} {i.attr.unit}</td><td>{limTxt(i.lim, i.attr.dec)}</td>
                <td style={{ color: col(i) }}>{i.state === 'ok' ? 'OK' : i.state === 'nodata' ? 'no data' : i.state.toUpperCase()}</td></tr>
            ))}</tbody></table>
        </div>
        {rows < shown.length && <button className="ghost" style={{ marginTop: 8 }} onClick={() => setRows(r => r + 100)}>Show more</button>}
      </div>
    </div>
  )
}
