import { useState } from 'react'

// Plan: where the automation equipment sits in the RAS and how it is connected. Three views:
// site plan (where each piece is in the building), panel layout (inside the control panel) and wiring (signals, PNP/NPN, pump starter).
// This is a design plan for the installer, not a drawing for construction: check ratings, cable sizes and local rules first.

const CSS = `
.pl-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.pl-tabs button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
.pl-svg{width:100%;display:block;min-width:760px}
.pl-t{width:100%;border-collapse:collapse;font-size:13px}.pl-t th{color:var(--mute);font-weight:500;text-align:left;padding:5px 6px}.pl-t td{padding:5px 6px;border-top:1px solid var(--line);vertical-align:top}
.pl-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;margin-top:12px}
.pl-k{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--mute);margin-top:6px}.pl-k i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:4px;vertical-align:-2px}
.pl-hi{cursor:pointer}.pl-hi:hover rect,.pl-hi.on rect{stroke:var(--acc);stroke-width:2.5}
`
type Part = { id: string; name: string; where: string; does: string; col: string }
const PARTS: Part[] = [
  { id: 'plc', name: 'PLC (CPU + I/O modules)', where: 'Control panel, middle DIN rail, next to the power supply', does: 'Reads all sensors, runs the pump / valve logic and alarms, talks Modbus TCP to the gateway.', col: '#3b82a0' },
  { id: 'dcs', name: 'DCS controller (optional)', where: 'Control panel, second rail (or inside the PLC if it runs the PID loops)', does: 'Runs the three PID loops (pump speed, aeration, temperature). Only add if the PLC cannot do it.', col: '#6a6fb3' },
  { id: 'hmi', name: 'HMI touch screen', where: 'Panel door, eye level', does: 'Operator screen: overview, jars, water quality, limits, alarms.', col: '#2a8f6a' },
  { id: 'vfd', name: 'VFD', where: 'Pump room, wall mounted beside the panel (or bottom of the panel)', does: 'Variable speed for the duty pump P-1. Speed reference from the PLC (4-20 mA or Modbus).', col: '#d9822b' },
  { id: 'sw', name: 'Industrial switch', where: 'Control panel, right of the PLC', does: 'Links PLC, HMI, VFD and the gateway PC / Wi-Fi router.', col: '#3b82a0' },
  { id: 'smps', name: 'Power supply (SMPS 24 VDC)', where: 'Control panel, top-left of the middle rail', does: '24 VDC for the PLC, sensors, relays and HMI.', col: '#c2a21f' },
  { id: 'rel', name: 'Relays', where: 'Control panel, lower rail', does: 'PLC outputs switch the contactor coils, solenoid valves, horn and beacon.', col: '#b5532f' },
  { id: 'iso', name: 'Signal isolators (AI / AO)', where: 'Control panel, lower rail beside the relays', does: 'Protect the PLC analog inputs from the 4-20 mA field loops (flow, pressure, temperature, analysers).', col: '#2a8f6a' },
  { id: 'tb', name: 'Terminal blocks', where: 'Bottom of the panel, grey signal, blue 0 V, green-yellow earth', does: 'Every field cable lands here first, then goes on to the PLC.', col: '#7a8793' },
  { id: 'mcb', name: 'MCB / isolator', where: 'Top of the panel, incoming supply', does: 'Main switch and short-circuit protection for the supply, pumps and the 24 V circuit.', col: '#c0392b' },
  { id: 'fuse', name: 'Fuses', where: 'Control panel, after the MCB, on each 24 V branch', does: 'Protect the sensor, relay and analyser branches separately.', col: '#c0392b' },
  { id: 'duct', name: 'Cable duct', where: 'Horizontal between rails, vertical down both sides', does: 'Keeps power wiring (left) apart from signal wiring (right).', col: '#9aa5ae' },
]
const P = Object.fromEntries(PARTS.map(p => [p.id, p]))

export default function Plan() {
  const [tab, setTab] = useState<'site' | 'panel' | 'wire'>('site')
  const [sel, setSel] = useState('plc')
  const s = P[sel]
  const hi = (id: string) => ({ className: `pl-hi ${sel === id ? 'on' : ''}`, onClick: () => setSel(id) })
  const Box = ({ id, x, y, w, h, label, fs = 11 }: { id: string; x: number; y: number; w: number; h: number; label: string; fs?: number }) => (
    <g {...hi(id)}><rect x={x} y={y} width={w} height={h} rx={5} fill={P[id].col} fillOpacity={0.22} stroke={P[id].col} strokeWidth={1.5} />
      <text x={x + w / 2} y={y + h / 2 + fs / 3} textAnchor="middle" fontSize={fs} fontWeight={700} fill="var(--ink)">{label}</text></g>
  )
  const info = (
    <div className="panel" style={{ marginTop: 12 }}>
      <h3 style={{ margin: 0 }}>{s.name}</h3>
      <p style={{ margin: '6px 0 2px' }}><b>Where:</b> {s.where}</p>
      <p style={{ margin: 0 }}><b>What it does:</b> {s.does}</p>
      <div className="pl-k">{PARTS.map(p => <span key={p.id} style={{ cursor: 'pointer', fontWeight: sel === p.id ? 700 : 400 }} onClick={() => setSel(p.id)}><i style={{ background: p.col }} />{p.name.split(' (')[0]}</span>)}</div>
    </div>
  )

  return (
    <div className="dk">
      <style>{CSS}</style>
      <div className="panel">
        <h2 style={{ margin: 0 }}>PLC connection plan · Hatchery RAS</h2>
        <small className="note">Click any item to see where it goes and what it does. Planning drawing only: confirm ratings, cable sizes and local rules with your electrician before building.</small>
        <div className="pl-tabs" style={{ marginTop: 10 }}>
          {([['site', 'Site plan'], ['panel', 'Panel layout'], ['wire', 'Wiring and signals']] as const).map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>

        {tab === 'site' && (
          <div style={{ overflowX: 'auto' }}>
            <svg className="pl-svg" viewBox="0 0 1100 560" role="img" aria-label="Site plan of the hatchery">
              <rect x={10} y={10} width={1080} height={540} rx={10} fill="none" stroke="var(--line)" strokeWidth={2} />
              {/* zones */}
              <rect x={24} y={24} width={300} height={250} rx={8} fill="var(--panel)" stroke="var(--line)" /><text x={36} y={46} fontSize="13" fontWeight="700" fill="var(--ink)">Pump room</text>
              <rect x={24} y={290} width={300} height={246} rx={8} fill="var(--panel)" stroke="var(--line)" /><text x={36} y={312} fontSize="13" fontWeight="700" fill="var(--ink)">Control room</text>
              <rect x={340} y={24} width={500} height={512} rx={8} fill="var(--panel)" stroke="var(--line)" /><text x={352} y={46} fontSize="13" fontWeight="700" fill="var(--ink)">Hatchery hall · 3 stations x 2 lines x 18 jars</text>
              <rect x={856} y={24} width={220} height={512} rx={8} fill="var(--panel)" stroke="var(--line)" /><text x={868} y={46} fontSize="13" fontWeight="700" fill="var(--ink)">Treatment area</text>
              {/* pump room */}
              <rect x={40} y={60} width={110} height={100} rx={6} fill="var(--water)" opacity={0.6} /><text x={95} y={115} textAnchor="middle" fontSize="12" fill="var(--ink)">Sump</text>
              <text x={95} y={135} textAnchor="middle" fontSize="10" fill="var(--mute)">AT-100 oxygen, TT temp</text>
              <circle cx={200} cy={90} r={18} fill="none" stroke="var(--ink)" strokeWidth={2} /><text x={200} y={94} textAnchor="middle" fontSize="11" fill="var(--ink)">P-1</text>
              <circle cx={200} cy={140} r={18} fill="none" stroke="var(--ink)" strokeWidth={2} /><text x={200} y={144} textAnchor="middle" fontSize="11" fill="var(--ink)">P-2</text>
              <Box id="vfd" x={240} y={72} w={70} h={36} label="VFD" /><text x={275} y={124} textAnchor="middle" fontSize="9" fill="var(--mute)">to P-1</text>
              <rect x={240} y={134} width={70} height={28} rx={5} fill="none" stroke="var(--mute)" strokeDasharray="4 3" /><text x={275} y={152} textAnchor="middle" fontSize="10" fill="var(--mute)">starter P-2</text>
              <text x={40} y={190} fontSize="11" fill="var(--mute)">PT-100 pump pressure, FT-100 total flow on the</text><text x={40} y={204} fontSize="11" fill="var(--mute)">discharge pipe. Motor cables run in conduit, away</text><text x={40} y={218} fontSize="11" fill="var(--mute)">from the signal cables.</text>
              {/* control room: panel */}
              <rect x={40} y={326} width={270} height={190} rx={6} fill="var(--card)" stroke="var(--ink)" strokeWidth={2} /><text x={50} y={344} fontSize="11" fontWeight="700" fill="var(--ink)">Control panel</text>
              <Box id="plc" x={50} y={354} w={80} h={34} label="PLC" /><Box id="dcs" x={136} y={354} w={80} h={34} label="DCS (opt.)" fs={10} />
              <Box id="smps" x={222} y={354} w={80} h={34} label="24 V SMPS" fs={10} />
              <Box id="sw" x={50} y={396} w={80} h={30} label="Switch" /><Box id="hmi" x={136} y={396} w={80} h={30} label="HMI (door)" fs={10} />
              <Box id="mcb" x={222} y={396} w={38} h={30} label="MCB" fs={9} /><Box id="fuse" x={264} y={396} w={38} h={30} label="Fuse" fs={9} />
              <Box id="rel" x={50} y={434} w={80} h={30} label="Relays" /><Box id="iso" x={136} y={434} w={80} h={30} label="Isolators" fs={10} /><Box id="tb" x={222} y={434} w={80} h={30} label="Terminals" fs={10} />
              <Box id="duct" x={50} y={472} w={252} h={22} label="Cable duct" />
              <text x={36} y={528} fontSize="10" fill="var(--mute)">Wi-Fi router + gateway PC on the shelf beside the panel</text>
              {/* hall */}
              {[0, 1, 2].map(s => [0, 1].map(l => {
                const x = 360 + l * 230, y = 66 + s * 150
                return <g key={`${s}${l}`}><rect x={x} y={y} width={216} height={132} rx={6} fill="var(--card)" stroke="var(--line)" />
                  <text x={x + 8} y={y + 16} fontSize="12" fontWeight="700" fill="var(--ink)">Station {s + 1} line {l ? 'B' : 'A'}</text>
                  {Array.from({ length: 18 }, (_, i) => <circle key={i} cx={x + 16 + (i % 9) * 22} cy={y + 38 + Math.floor(i / 9) * 22} r={8} fill="var(--water)" opacity={0.75} stroke="var(--line)" />)}
                  <text x={x + 8} y={y + 96} fontSize="10" fill="var(--mute)">FT / PT / TT on the line inlet, AT oxygen</text><text x={x + 8} y={y + 110} fontSize="10" fill="var(--mute)">in and out, jar flow and valve limit switches</text>
                  <text x={x + 8} y={y + 124} fontSize="10" fill="var(--mute)">(PNP 24 V proximity)</text></g>
              }))}
              <rect x={600} y={46} width={60} height={14} rx={3} fill="var(--mute)" opacity={0.4} /><text x={630} y={57} textAnchor="middle" fontSize="9" fill="var(--ink)">JB-1</text>
              <rect x={600} y={196} width={60} height={14} rx={3} fill="var(--mute)" opacity={0.4} /><text x={630} y={207} textAnchor="middle" fontSize="9" fill="var(--ink)">JB-2</text>
              <rect x={600} y={346} width={60} height={14} rx={3} fill="var(--mute)" opacity={0.4} /><text x={630} y={357} textAnchor="middle" fontSize="9" fill="var(--ink)">JB-3</text>
              {/* treatment */}
              <rect x={872} y={64} width={188} height={70} rx={6} fill="var(--card)" stroke="var(--line)" /><text x={882} y={84} fontSize="12" fontWeight="700" fill="var(--ink)">Drum filter</text><text x={882} y={102} fontSize="10" fill="var(--mute)">Turbidity analyser AT-TURB</text>
              <rect x={872} y={150} width={188} height={70} rx={6} fill="var(--card)" stroke="var(--line)" /><text x={882} y={170} fontSize="12" fontWeight="700" fill="var(--ink)">Biofilter</text><text x={882} y={188} fontSize="10" fill="var(--mute)">Ammonia, nitrite, nitrate</text>
              <rect x={872} y={236} width={188} height={110} rx={6} fill="var(--card)" stroke="var(--line)" /><text x={882} y={256} fontSize="12" fontWeight="700" fill="var(--ink)">Analyser cabinet</text><text x={882} y={274} fontSize="10" fill="var(--mute)">pH, alkalinity, calcium hardness,</text><text x={882} y={288} fontSize="10" fill="var(--mute)">total hardness (4-20 mA outputs)</text>
              <text x={872} y={376} fontSize="11" fill="var(--mute)">Sample lines from the sump return</text><text x={872} y={392} fontSize="11" fill="var(--mute)">feed the analyser cabinet.</text>
              {/* cables */}
              <path d="M310,420 H330 V90 H340" fill="none" stroke="var(--acc)" strokeWidth={2} strokeDasharray="6 4" /><text x={316} y={250} fontSize="10" fill="var(--acc)" transform="rotate(-90 316 250)">signal trunk to JB-1..3</text>
              <path d="M275,162 V326" fill="none" stroke="#d9822b" strokeWidth={2} /><text x={214} y={290} fontSize="10" fill="#d9822b">motor power</text>
              <path d="M840,180 H850 V528 H312 V500" fill="none" stroke="var(--acc)" strokeWidth={2} strokeDasharray="6 4" />
              <text x={600} y={548} fontSize="10" fill="var(--mute)" textAnchor="middle">Dashed: signal cables (screened, 4-20 mA and 24 V DI) · Solid orange: motor power</text>
            </svg>
          </div>
        )}

        {tab === 'panel' && (
          <div style={{ overflowX: 'auto' }}>
            <svg className="pl-svg" viewBox="0 0 1100 600" role="img" aria-label="Control panel layout">
              <rect x={20} y={10} width={760} height={580} rx={8} fill="var(--panel)" stroke="var(--ink)" strokeWidth={3} />
              <text x={30} y={32} fontSize="12" fill="var(--mute)">Back plate, 800 x 600 mm class enclosure (size to suit)</text>
              {/* rails */}
              {[60, 190, 320, 450].map((y, i) => <g key={y}><rect x={50} y={y + 52} width={700} height={4} fill="var(--mute)" opacity={0.6} /><text x={756} y={y + 56} fontSize="9" fill="var(--mute)">rail {i + 1}</text></g>)}
              {/* vertical ducts */}
              <Box id="duct" x={32} y={46} w={14} h={520} label="" /><Box id="duct" x={754} y={46} w={14} h={520} label="" />
              {/* rail 1: protection */}
              <Box id="mcb" x={60} y={60} w={110} h={48} label="MCB main + pumps" fs={10} /><Box id="fuse" x={180} y={60} w={110} h={48} label="Fuses 24 V branches" fs={10} />
              <Box id="smps" x={300} y={60} w={140} h={48} label="SMPS 24 VDC" /><text x={450} y={80} fontSize="10" fill="var(--mute)">L N PE in · +V -V out</text>
              {/* duct */}
              <Box id="duct" x={50} y={124} w={700} h={16} label="" />
              {/* rail 2: controllers */}
              <Box id="plc" x={60} y={150} w={330} h={90} label="PLC: CPU, DI, DO, AI, AO modules" fs={12} />
              <Box id="dcs" x={400} y={150} w={160} h={90} label="DCS controller (optional)" fs={10} /><Box id="sw" x={570} y={150} w={110} h={90} label="Switch (8 port)" fs={11} />
              <Box id="duct" x={50} y={254} w={700} h={16} label="" />
              {/* rail 3: interface */}
              <Box id="iso" x={60} y={284} w={200} h={90} label="Signal isolators AI / AO" fs={11} /><Box id="rel" x={270} y={284} w={330} h={90} label="Relays: valves, horn, beacon, contactor coils" fs={11} />
              <Box id="vfd" x={610} y={284} w={130} h={90} label="Contactor KM1 + overload FR1 (P-2)" fs={10} />
              <Box id="duct" x={50} y={388} w={700} h={16} label="" />
              {/* rail 4: terminals */}
              <Box id="tb" x={60} y={418} w={680} h={90} label="Terminal blocks: signals (grey) · 24 V (red) · 0 V (blue) · earth (green-yellow)" fs={12} />
              <text x={60} y={540} fontSize="11" fill="var(--mute)">Field cables enter from the bottom through glands. Power wiring on the left duct, signal wiring on the right duct.</text>
              {/* door */}
              <rect x={810} y={10} width={270} height={400} rx={8} fill="var(--card)" stroke="var(--ink)" strokeWidth={3} /><text x={822} y={32} fontSize="12" fill="var(--mute)">Panel door (outside)</text>
              <Box id="hmi" x={828} y={46} w={234} h={150} label="HMI touch screen" fs={13} />
              <circle cx={870} cy={250} r={20} fill="#c0392b" /><text x={900} y={254} fontSize="12" fill="var(--ink)">Emergency stop (NC)</text>
              <circle cx={870} cy={300} r={14} fill="#2a8f6a" /><text x={900} y={304} fontSize="12" fill="var(--ink)">START SB1 (NO)</text>
              <circle cx={870} cy={340} r={14} fill="#d9822b" /><text x={900} y={344} fontSize="12" fill="var(--ink)">STOP SB2 (NC)</text>
              <circle cx={870} cy={380} r={10} fill="#e0b72a" /><text x={900} y={384} fontSize="12" fill="var(--ink)">Alarm beacon</text>
              <text x={810} y={440} fontSize="11" fill="var(--mute)">VFD for pump P-1 is wall mounted beside</text><text x={810} y={456} fontSize="11" fill="var(--mute)">the panel (heat), wired back to rail 3.</text>
            </svg>
          </div>
        )}

        {tab === 'wire' && (
          <div>
            <table className="pl-t"><thead><tr><th>Signal</th><th>From (field)</th><th>Through</th><th>To the PLC</th><th>Notes</th></tr></thead><tbody>
              {[
                ['Flow, pressure, temperature (4-20 mA)', 'FT / PT / TT on each line, pump discharge', 'Terminal block, signal isolator', 'Analog input (AI)', 'Two-wire loops powered from 24 V. 4 mA = 0, 20 mA = full scale. Under 3.6 mA means broken wire.'],
                ['Oxygen and water-quality analysers', 'AT-NH3, NO2, NO3, pH, ALK, TURB, CAH, HARD, oxygen', 'Terminal block, signal isolator', 'Analog input (AI)', 'Use the analyser 4-20 mA output. Isolate so a ground fault in one analyser cannot upset the others.'],
                ['Jar flow and valve position', 'Proximity or limit switch on each jar valve', 'Terminal block', 'Digital input (DI)', 'Three-wire PNP sensor to 24 V DI card. Do not mix NPN and PNP on one card.'],
                ['Pump P-2 (standby) start / stop', 'Contactor KM1 coil A1/A2', 'Relay on a PLC output', 'Digital output (DO)', 'Direct-on-line starter: MCB, contactor KM1, overload FR1. Hardwired E-stop and STOP in series with the coil.'],
                ['Pump P-1 speed (duty)', 'VFD', 'Isolator (AO) or Modbus over the switch', 'Analog output (AO) or Modbus', 'VFD alarm and run feedback go back to two digital inputs.'],
                ['Solenoid valves, horn, beacon', 'Field devices', 'Relays', 'Digital outputs (DO)', 'One relay per device. Fuse each branch.'],
                ['HMI, gateway, VFD (if Modbus)', 'Ethernet', 'Industrial switch', 'PLC Ethernet port', 'The gateway PC reads the PLC over Modbus TCP and sends the data out through the Wi-Fi router.'],
              ].map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={j === 0 ? { fontWeight: 700 } : undefined}>{c}</td>)}</tr>)}
            </tbody></table>

            <div className="pl-two">
              <div className="panel" style={{ margin: 0 }}>
                <h3 style={{ marginTop: 0 }}>PNP or NPN sensors</h3>
                <svg viewBox="0 0 440 210" style={{ width: '100%' }} role="img" aria-label="PNP and NPN three-wire sensor wiring">
                  {[['PNP (sourcing output)', 0, 'Output switches +24 V to the input. Use with sinking DI cards (common 0 V).'], ['NPN (sinking output)', 105, 'Output switches 0 V to the input. Use with sourcing DI cards (common +24 V).']].map(([t, y, n]) => (
                    <g key={t as string} transform={`translate(0 ${y})`}>
                      <text x={8} y={16} fontSize="12" fontWeight="700" fill="var(--ink)">{t as string}</text>
                      <rect x={150} y={26} width={90} height={44} rx={6} fill="var(--card)" stroke="var(--ink)" /><text x={195} y={52} textAnchor="middle" fontSize="11" fill="var(--ink)">3-wire sensor</text>
                      <path d="M20,34 H150" stroke="#c0392b" strokeWidth={2} /><text x={24} y={30} fontSize="10" fill="#c0392b">+24 V (brown)</text>
                      <path d="M20,62 H150" stroke="#2f6fbf" strokeWidth={2} /><text x={24} y={76} fontSize="10" fill="#2f6fbf">0 V (blue)</text>
                      <path d="M240,48 H330" stroke="var(--ink)" strokeWidth={2} /><text x={246} y={44} fontSize="10" fill="var(--ink)">signal (black)</text>
                      <rect x={330} y={32} width={80} height={32} rx={5} fill="var(--panel)" stroke="var(--ink)" /><text x={370} y={52} textAnchor="middle" fontSize="11" fill="var(--ink)">PLC DI</text>
                      <text x={8} y={94} fontSize="10" fill="var(--mute)">{n as string}</text>
                    </g>
                  ))}
                </svg>
                <small className="note">Correction to the diagram you shared: it labels PNP as "sinking" and NPN as "sourcing". It is the other way round. A PNP sensor sources current to the load, an NPN sensor sinks it.</small>
              </div>
              <div className="panel" style={{ margin: 0 }}>
                <h3 style={{ marginTop: 0 }}>Pump starter (direct on line)</h3>
                <svg viewBox="0 0 440 250" style={{ width: '100%' }} role="img" aria-label="Direct on line motor starter">
                  <text x={10} y={16} fontSize="11" fontWeight="700" fill="var(--ink)">Power</text>
                  {[40, 70, 100].map((x, i) => <g key={x}><path d={`M${x},26 V190`} stroke="var(--ink)" strokeWidth={2} /><text x={x - 4} y={22} fontSize="9" fill="var(--mute)">L{i + 1}</text></g>)}
                  <rect x={30} y={44} width={80} height={22} fill="var(--card)" stroke="var(--ink)" /><text x={115} y={59} fontSize="10" fill="var(--ink)">QS / MCB</text>
                  <rect x={30} y={80} width={80} height={22} fill="var(--card)" stroke="var(--ink)" /><text x={115} y={95} fontSize="10" fill="var(--ink)">FU1</text>
                  <rect x={30} y={116} width={80} height={22} fill="var(--card)" stroke="var(--ink)" /><text x={115} y={131} fontSize="10" fill="var(--ink)">KM1 contacts</text>
                  <rect x={30} y={152} width={80} height={22} fill="var(--card)" stroke="var(--ink)" /><text x={115} y={167} fontSize="10" fill="var(--ink)">FR1 overload</text>
                  <circle cx={70} cy={212} r={20} fill="var(--card)" stroke="var(--ink)" strokeWidth={2} /><text x={70} y={216} textAnchor="middle" fontSize="11" fill="var(--ink)">M 3~</text><path d="M40,190 V212 M70,190 V192 M100,190 V212" stroke="var(--ink)" strokeWidth={2} />
                  <text x={230} y={16} fontSize="11" fontWeight="700" fill="var(--ink)">Control (24 V or 230 V coil)</text>
                  <path d="M250,26 V220 M390,26 V220" stroke="var(--ink)" strokeWidth={2} />
                  {[['E-stop (NC)', 44], ['FR1 (95-96)', 80], ['STOP SB2 (NC)', 116]].map(([t, y]) => <g key={t as string}><rect x={262} y={y as number} width={116} height={22} fill="var(--card)" stroke="var(--ink)" /><text x={270} y={(y as number) + 15} fontSize="10" fill="var(--ink)">{t as string}</text></g>)}
                  <rect x={262} y={152} width={52} height={22} fill="var(--card)" stroke="var(--ink)" /><text x={266} y={167} fontSize="10" fill="var(--ink)">START SB1</text>
                  <rect x={322} y={152} width={56} height={22} fill="var(--card)" stroke="var(--ink)" /><text x={326} y={167} fontSize="10" fill="var(--ink)">KM1 hold</text>
                  <rect x={262} y={188} width={116} height={28} fill="var(--card)" stroke="var(--ink)" /><text x={320} y={206} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--ink)">KM1 coil A1-A2</text>
                </svg>
                <small className="note">Stop and E-stop are normally closed and in series with the coil, so a broken wire stops the pump. The PLC can also start it: a relay contact goes in parallel with START.</small>
              </div>
            </div>
          </div>
        )}
      </div>
      {tab !== 'wire' && info}
    </div>
  )
}
