// Fluidised egg bed model, ported from McDonald_jar_flow_dashboard.html.
// Units: diameters in cm (jar) or mm (pipe, eggs), flow in L/min, speeds in cm/s.
export const E0 = 0.4

export type Settings = {
  pump_shutoff_head_m: number; pump_free_flow_lpm: number; valve_capacity_lpm_per_rm: number
  line_head_m: number; header_diameter_mm: number; jar_spacing_m: number
  egg_diameter_mm: number; egg_density_kg_m3: number; water_temp_c: number
  max_egg_mass_g: number; target_bed_expansion: number; stage34_flow_boost_pct: number
}
export type JarGeom = {
  jar_diameter_cm?: number; drop_pipe_id_mm?: number; spout_depth_cm?: number
  egg_mass_g?: number; settled_height_cm?: number; stage?: number
}
export type Status = [label: string, tone: 'ok' | 'warn' | 'bad' | 'off']

export const water = (T: number) => ({
  mu: 2.414e-5 * Math.pow(10, 247.8 / (T + 133.15)),
  rho: 1000 * (1 - ((T + 288.9414) / (508929.2 * (T + 68.12963))) * Math.pow(T - 3.9863, 2)),
})

export function termV(d: number, rs: number, rf: number, mu: number) {
  let lo = 1e-5, hi = 3
  for (let i = 0; i < 60; i++) {
    const u = (lo + hi) / 2, Re = (rf * u * d) / mu
    const CD = (24 / Re) * (1 + 0.15 * Math.pow(Re, 0.687))
    const drag = 0.5 * rf * u * u * CD * Math.PI * d * d / 4
    const wt = (rs - rf) * 9.81 * Math.PI * Math.pow(d, 3) / 6
    if (drag > wt) hi = u; else lo = u
  }
  return (lo + hi) / 2
}

export function jarModel(j: JarGeom, s: Settings) {
  const D = j.jar_diameter_cm ?? 12, dp = j.drop_pipe_id_mm ?? 20
  const m = j.egg_mass_g ?? 1200, h0 = j.settled_height_cm ?? 16.8
  const de = s.egg_diameter_mm / 1000, rs = s.egg_density_kg_m3, w = water(s.water_temp_c)
  const A = Math.PI * D * D / 4, Ap = Math.PI * Math.pow(dp / 10, 2) / 4
  const ut = termV(de, rs, w.rho, w.mu)
  const Ret = w.rho * ut * de / w.mu
  const n = Math.min(4.65, Math.max(2.4, 4.45 * Math.pow(Math.max(Ret, 1), -0.1)))
  const Ar = Math.pow(de, 3) * w.rho * (rs - w.rho) * 9.81 / (w.mu * w.mu)
  const umf = (Math.sqrt(1135.7 + 0.0408 * Ar) - 33.7) * w.mu / (w.rho * de)
  const Vegg = m / (rs / 1000 * (1 - E0))
  return { A, Ap, ut: ut * 100, umf: umf * 100, n, Vegg, m, H0: h0 > 0 ? h0 : Vegg / A, rho: w.rho, mu: w.mu }
}
export type JarModel = ReturnType<typeof jarModel>

export function expand(u: number, M: JarModel) {
  if (u <= M.umf) return { r: 1, e: E0 }
  if (u >= M.ut) return { r: Infinity, e: 1 }
  const e = Math.max(E0, Math.pow(u / M.ut, 1 / M.n))
  return { r: (1 - E0) / (1 - e), e }
}

// Flow (L/min) that gives expansion ratio r
export function qFor(r: number, M: JarModel) {
  const e = 1 - (1 - E0) / r
  return M.ut * Math.pow(e, M.n) * M.A * 0.06
}

export const stageMult = (stage: number, boostPct: number) =>
  stage >= 3 ? 1 + Math.min(10, Math.max(0, boostPct || 0)) / 100 : 1

export function status(Q: number, M: JarModel, x: { r: number }, Hs: number, Mmax: number): Status {
  if (x.r === Infinity) return ['Washout', 'bad']
  if (M.Vegg > M.A * Hs * 0.4 || M.m > Mmax) return ['Load too big', 'bad']
  const u = Q * 1000 / 60 / M.A
  if (u <= M.umf) return ['Bed still', 'bad']
  if (x.r < 1.1) return ['Too gentle', 'warn']
  if (x.r < 1.2) return ['Slightly low', 'warn']
  if (x.r <= 1.5) return ['In target', 'ok']
  if (x.r <= 2 && x.r * M.H0 <= Hs) return ['Vigorous', 'warn']
  return ['Too strong', 'bad']
}

// One line of jars on a shared header. gs = valve conductance of each jar (L/min per root m).
export function solveLine(gs: number[], s: Settings) {
  const n = gs.length, H0 = s.line_head_m, d = s.header_diameter_mm / 1000
  const kk = 10.67 * s.jar_spacing_m / (Math.pow(140, 1.852) * Math.pow(d, 4.87))
  let Q = gs.map(x => x * Math.sqrt(H0)), H = gs.map(() => H0)
  for (let it = 0; it < 40; it++) {
    let rem = Q.reduce((a, b) => a + b, 0) / 60000, h = H0
    for (let i = 0; i < n; i++) {
      h = Math.max(0.01, h - kk * Math.pow(rem, 1.852))
      H[i] = h
      rem = Math.max(0, rem - Q[i] / 60000)
    }
    Q = Q.map((q, i) => 0.5 * q + 0.5 * gs[i] * Math.sqrt(H[i]))
  }
  return { Q, H }
}

// Whole system: jars come from ras_jar_overview rows.
export function computeJars(jars: any[], s: Settings) {
  const groups = new Map<string, any[]>()
  for (const j of jars) {
    const k = `${j.station}-${j.line}`
    groups.set(k, [...(groups.get(k) ?? []), j])
  }
  const out: { key: string; rows: any[] }[] = []
  groups.forEach((list, key) => {
    list.sort((a, b) => a.position - b.position)
    const gs = list.map(j => j.is_on ? s.valve_capacity_lpm_per_rm * Math.pow(j.valve_open_pct / 100, 1.5) : 0)
    const res = solveLine(gs, s)
    const rows = list.map((j, i) => {
      const M = jarModel(j, s), Q = res.Q[i], u = Q * 1000 / 60 / M.A, x = expand(u, M)
      const Hs = j.spout_depth_cm ?? 50
      const st: Status = j.is_on ? status(Q, M, x, Hs, s.max_egg_mass_g) : ['Off', 'off']
      const target = qFor(s.target_bed_expansion, M) * stageMult(j.stage, s.stage34_flow_boost_pct)
      return { jar: j, Q, u, x, st, target, head: res.H[i] }
    })
    out.push({ key, rows })
  })
  return out
}

// Auto-set valves: find the opening of every jar on a line that gives its target flow,
// allowing for head loss along the header. Returns whole-number percentages.
export function autoTune(rows: { jar: any; target: number }[], s: Settings) {
  const G = s.valve_capacity_lpm_per_rm
  let open = rows.map(r => (r.jar.is_on ? Math.max(1, r.jar.valve_open_pct || 40) : 0))
  for (let it = 0; it < 40; it++) {
    const { H } = solveLine(open.map(o => G * Math.pow(o / 100, 1.5)), s)
    open = rows.map((r, i) =>
      r.jar.is_on ? Math.min(100, Math.max(1, 100 * Math.pow(r.target / (G * Math.sqrt(H[i])), 2 / 3))) : 0)
  }
  return open.map(o => Math.round(o))
}
