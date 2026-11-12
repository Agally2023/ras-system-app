import { useEffect, useRef, useState } from 'react'

// Isometric (orthographic) 3D hatchery, dependency-free. Canvas 2D with painter's algorithm.
// World units are metres. Rows run along X. Each station has two rows (A and B) facing a shared gutter.
// Camera: yaw (turn the room), elevation, scale (px per metre) and a target point. No perspective, so
// every jar stays the same size and rows do not distort.

export type J3 = {
  Q: number; T: number; bed: number; settled: number; water: number; valve: number
  on: boolean; tone: string; stage: number; wash: boolean; code: string; status: string
}
export type Line3 = { key: string; station: number; idx: number; jars: J3[] }
type Props = {
  lines: Line3[]; selKey: string; selPos: number; spacing: number
  onSelect: (key: string, pos: number) => void
}

const NE = 32
const Y0 = 0.52          // jar floor height (top of the shelf)
const YH = 1.62          // header pipe centre height
const RJ = 0.085         // jar radius (drawn a little fat so it reads)
const RIN = 0.074        // inner radius for eggs
const TRAY_Y = 0.36      // tray water surface
const STATION_GAP = 3.3
const ROW_OFF = 0.8      // row distance from the station centre line
const DEF_YAW = 0.62, DEF_ELEV = 0.75

type Kind = 'all' | 'station' | 'line'
type Pal = {
  bg0: string; bg1: string; floor: string; grid: string; pipe: string; pipeHi: string; pipeEdge: string; ink: string
  water: string; waterDeep: string; egg: string; flow: string; stand: string; tray: string; trayEdge: string
  handle: string; ok: string; warn: string; bad: string; off: string; acc: string; text: string; gutter: string
}
function palette(red: boolean): Pal {
  const css = getComputedStyle(document.documentElement)
  const v = (n: string, d: string) => css.getPropertyValue(n).trim() || d
  if (red) return {
    bg0: '#240706', bg1: '#4b0f0b', floor: '#5a1511', grid: 'rgba(255,150,130,0.18)', pipe: '#ff9a8a', pipeHi: '#ffd2c8', pipeEdge: '#a82d24',
    ink: '#ffd6cf', water: 'rgba(255,140,120,0.45)', waterDeep: 'rgba(230,80,70,0.65)', egg: '#ffb04a', flow: '#ffe3dc', stand: '#3a1613',
    tray: '#ffb0a2', trayEdge: '#c9392e', handle: '#ff2a1c', ok: '#8fe3b0', warn: '#ffd166', bad: '#ff5a4d', off: '#b99', acc: '#ffe1da',
    text: '#ffe1da', gutter: '#7a2a3a',
  }
  return {
    bg0: v('--bg', '#f1f6f5'), bg1: v('--panel', '#e2ece9'), floor: v('--panel', '#e2ece9'), grid: 'rgba(40,90,85,0.14)',
    pipe: '#dfeceb', pipeHi: '#ffffff', pipeEdge: '#5d8a85', ink: v('--ink', '#10302f'), water: 'rgba(110,190,235,0.55)',
    waterDeep: 'rgba(40,130,200,0.78)', egg: '#e08a14', flow: '#1b8fe8', stand: '#56686a', tray: '#ffffff', trayEdge: '#5d7a7a',
    handle: '#d9322a', ok: v('--ok', '#2f8f5f'), warn: v('--warn', '#c98a1b'), bad: v('--bad', '#c0392b'), off: v('--mute', '#7a8f8c'),
    acc: v('--acc', '#0b6b63'), text: v('--ink', '#10302f'), gutter: '#9ec3d6',
  }
}

export default function Hatchery3D({ lines, selKey, selPos, spacing, onSelect }: Props) {
  const cvRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const props = useRef({ lines, selKey, selPos, spacing, onSelect })
  props.current = { lines, selKey, selPos, spacing, onSelect }
  const [red, setRed] = useState(false)
  const redRef = useRef(false); redRef.current = red
  const [focus, setFocus] = useState(false)
  const focusRef = useRef(false); focusRef.current = focus
  const [kind, setKind] = useState<Kind>('all')
  const kindRef = useRef<Kind>('all'); kindRef.current = kind
  const cam = useRef({ yaw: DEF_YAW, elev: DEF_ELEV, S: 80, tx: 0, ty: 0.9, tz: 0 })
  const goal = useRef({ ...cam.current })
  const needFit = useRef(true)
  const eggs = useRef<{ n: number; ex: Float32Array; ey: Float32Array; ez: Float32Array; vx: Float32Array; vy: Float32Array; vz: Float32Array; f: Float32Array; ph: Float32Array; m: Uint8Array } | null>(null)

  const nStOf = () => Math.max(...props.current.lines.map(l => l.station), 1)
  const rowZ = (l: Line3) => (l.station - 1 - (nStOf() - 1) / 2) * STATION_GAP + (l.idx === 0 ? -ROW_OFF : ROW_OFF)
  const dirOf = (l: Line3) => (l.idx === 0 ? 1 : -1)

  function ask(k: Kind) { setKind(k); kindRef.current = k; needFit.current = true; setFocus(k !== 'all') }
  function rotate(dir: number) { goal.current.yaw += dir * (Math.PI / 2); needFit.current = true }
  function resetView() { Object.assign(goal.current, { yaw: DEF_YAW, elev: DEF_ELEV }); needFit.current = true }
  function zoom(f: number) { goal.current.S = Math.min(400, Math.max(25, goal.current.S * f)) }
  useEffect(() => { if (kindRef.current !== 'all') needFit.current = true }, [selKey])

  useEffect(() => {
    const cv = cvRef.current!, wrap = wrapRef.current!
    const ctx = cv.getContext('2d')!
    const REDUCE = window.matchMedia('(prefers-reduced-motion:reduce)').matches
    let W = 0, H = 0, raf = 0, last = performance.now(), tick = 0, pal = palette(false)
    let cp = 1, sp = 0, sE = 0.68, cE = 0.73, S = 80, tx = 0, ty = 0, tz = 0
    let PX = 0, PY = 0, PD = 0

    function setCamera(c: { yaw: number; elev: number; S: number; tx: number; ty: number; tz: number }) {
      cp = Math.cos(c.yaw); sp = Math.sin(c.yaw); sE = Math.sin(c.elev); cE = Math.cos(c.elev); S = c.S; tx = c.tx; ty = c.ty; tz = c.tz
    }
    function P(x: number, y: number, z: number) {
      const dx = x - tx, dz = z - tz, xr = dx * cp + dz * sp, zr = -dx * sp + dz * cp
      PX = W / 2 + xr * S; PY = H / 2 + (zr * sE - (y - ty) * cE) * S; PD = zr
    }

    // fit the camera goal around a set of world boxes
    function fit() {
      const L = props.current.lines; if (!L.length || !W) return
      const g = goal.current, k = kindRef.current, sel = L.find(l => l.key === props.current.selKey) ?? L[0]
      const sp0 = props.current.spacing
      const rows = k === 'all' ? L : k === 'station' ? L.filter(l => l.station === sel.station) : [sel]
      const nMax = Math.max(...L.map(l => l.jars.length)), hx = (nMax * sp0) / 2 + 0.25
      let zmin = Infinity, zmax = -Infinity
      for (const r of rows) { const z = rowZ(r); zmin = Math.min(zmin, z - 0.65); zmax = Math.max(zmax, z + 0.65) }
      const x0 = -hx - 0.95, x1 = hx + 0.1
      const c = Math.cos(g.yaw), s = Math.sin(g.yaw), se = Math.sin(g.elev), ce = Math.cos(g.elev)
      const cx0 = (x0 + x1) / 2, cz0 = (zmin + zmax) / 2, cy0 = 0.95
      let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity
      for (const x of [x0, x1]) for (const z of [zmin - 0.7, zmax + 0.5]) for (const y of [0, 2.1]) {
        const dx = x - cx0, dz = z - cz0, u = dx * c + dz * s, v = (-dx * s + dz * c) * se - (y - cy0) * ce
        umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v)
      }
      g.S = Math.min(360, Math.max(25, Math.min((W * 0.94) / (umax - umin), (H * 0.9) / (vmax - vmin))))
      // shift the target so the extents are centred on the canvas
      const uc = (umin + umax) / 2, vc = (vmin + vmax) / 2
      const a = c, b = s, d = -s * se, e = c * se, det = a * e - b * d
      g.tx = cx0 + (e * uc - b * vc) / det; g.tz = cz0 + (-d * uc + a * vc) / det; g.ty = cy0
    }

    // ---------- drawing primitives
    function ell(x: number, y: number, z: number, r: number, fill?: string, stroke?: string, lw = 1) {
      P(x, y, z); ctx.beginPath(); ctx.ellipse(PX, PY, r * S, r * S * sE, 0, 0, 6.2832)
      if (fill) { ctx.fillStyle = fill; ctx.fill() }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke() }
    }
    function seg(a: number[], b: number[], w: number, col: string, cap: CanvasLineCap = 'butt', dash?: number[], off = 0) {
      P(a[0], a[1], a[2]); const x1 = PX, y1 = PY; P(b[0], b[1], b[2])
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = cap; ctx.setLineDash(dash ?? []); ctx.lineDashOffset = off
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(PX, PY); ctx.stroke(); ctx.setLineDash([])
    }
    // shaded pipe between two world points
    function pipe(a: number[], b: number[], r: number, flowQ = 0, time = 0, flowW = 0.55) {
      const w = r * 2 * S
      seg(a, b, w + 2, pal.pipeEdge); seg(a, b, w, pal.pipe)
      P(a[0], a[1], a[2]); const x1 = PX, y1 = PY; P(b[0], b[1], b[2])
      ctx.strokeStyle = pal.pipeHi; ctx.globalAlpha = 0.8; ctx.lineWidth = Math.max(1, w * 0.22); ctx.lineCap = 'butt'
      const o = w * 0.22
      ctx.beginPath(); ctx.moveTo(x1 - o, y1 - o); ctx.lineTo(PX - o, PY - o); ctx.stroke(); ctx.globalAlpha = 1
      if (flowQ > 0.02) {
        const L = Math.max(3, 0.05 * S)
        seg(a, b, Math.max(1.5, w * flowW), pal.flow, 'round', [L, L * 1.4], -time * (0.5 + flowQ * 0.06) * S * 0.5)
      }
    }
    function box(x: number, z: number, y0: number, y1: number, hxb: number, hzb: number, hxt: number, hzt: number, fill: string, stroke: string, top?: string) {
      const bot = [[-hxb, -hzb], [hxb, -hzb], [hxb, hzb], [-hxb, hzb]], tp = [[-hxt, -hzt], [hxt, -hzt], [hxt, hzt], [-hxt, hzt]]
      const faces: { d: number; pts: number[] }[] = []
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4, q: number[] = []; let dsum = 0
        for (const [px, py, pz] of [[x + bot[i][0], y0, z + bot[i][1]], [x + bot[j][0], y0, z + bot[j][1]], [x + tp[j][0], y1, z + tp[j][1]], [x + tp[i][0], y1, z + tp[i][1]]]) { P(px, py, pz); q.push(PX, PY); dsum += PD }
        faces.push({ d: dsum, pts: q })
      }
      faces.sort((a, b) => a.d - b.d)
      ctx.lineJoin = 'round'
      for (const fc of faces) {
        ctx.beginPath(); ctx.moveTo(fc.pts[0], fc.pts[1]); for (let i = 2; i < 8; i += 2) ctx.lineTo(fc.pts[i], fc.pts[i + 1]); ctx.closePath()
        ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke()
      }
      const q: number[] = []; for (const [px, pz] of tp) { P(x + px, y1, z + pz); q.push(PX, PY) }
      ctx.beginPath(); ctx.moveTo(q[0], q[1]); for (let i = 2; i < 8; i += 2) ctx.lineTo(q[i], q[i + 1]); ctx.closePath()
      ctx.fillStyle = top ?? fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.stroke()
    }

    // ---------- eggs
    function ensureEggs(total: number) {
      if (eggs.current && eggs.current.n === total) return
      const n = total * NE, e = { n: total, ex: new Float32Array(n), ey: new Float32Array(n), ez: new Float32Array(n), vx: new Float32Array(n), vy: new Float32Array(n), vz: new Float32Array(n), f: new Float32Array(n), ph: new Float32Array(n), m: new Uint8Array(n) }
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.28, r = Math.sqrt(Math.random()) * (RIN - 0.006)
        e.ex[i] = Math.cos(a) * r; e.ez[i] = Math.sin(a) * r; e.f[i] = Math.random(); e.ey[i] = 0.01 + e.f[i] * 0.07; e.ph[i] = Math.random() * 6.28
      }
      eggs.current = e
    }
    function stepEggs(dt: number, time: number) {
      const e = eggs.current; if (!e) return
      let g = 0
      for (const l of props.current.lines) {
        const d = dirOf(l)
        for (const j of l.jars) {
          const base = g * NE, T = j.on ? j.T : 0, bed = Math.max(j.bed, 0.012), gentle = j.wash ? 0 : Math.min(1, Math.max(0, bed / 0.08 - 0.7))
          const water = j.water, trayLocal = TRAY_Y - Y0 + 0.02
          for (let k = 0; k < NE; k++) {
            const i = base + k
            if (e.m[i] === 2) continue
            if (REDUCE || !j.on) { e.m[i] = 0; e.ey[i] = 0.006 + e.f[i] * Math.max(bed - 0.012, 0.004); continue }
            if (e.m[i] === 1) {
              e.vy[i] -= 3.2 * dt; e.ex[i] += e.vx[i] * dt; e.ey[i] += e.vy[i] * dt; e.ez[i] += e.vz[i] * dt
              if (e.ey[i] <= trayLocal) { e.m[i] = 2; e.ey[i] = trayLocal + Math.random() * 0.012; e.ez[i] = d * (0.17 + (Math.random() - 0.5) * 0.06); e.ex[i] = (Math.random() - 0.5) * 0.1; e.vx[i] = e.vy[i] = e.vz[i] = 0 }
              continue
            }
            const yT = 0.006 + e.f[i] * Math.max(bed - 0.012, 0.004), kk = 18 * (1 - T) * (1 - T) + 0.4, rr = Math.hypot(e.ex[i], e.ez[i])
            let ay = kk * (yT - e.ey[i]) - 4 * e.vy[i] + 0.14 * gentle * Math.sin(time * 1.3 + e.ph[i]) + (Math.random() - 0.5) * T * 5.6
            const ax = -4 * e.vx[i] + 0.035 * gentle * Math.sin(time * 1.7 + e.ph[i] * 1.3) + (Math.random() - 0.5) * T * 4.2
            const az = -4 * e.vz[i] + 0.035 * gentle * Math.cos(time * 1.5 + e.ph[i] * 1.1) + (Math.random() - 0.5) * T * 4.2
            if (rr < 0.04) ay -= T * 0.7 * (1 - rr / 0.04); else if (rr > 0.05) ay += T * 0.18
            if (j.wash) ay -= 0.8
            e.vx[i] += ax * dt; e.vy[i] += ay * dt; e.vz[i] += az * dt
            e.ex[i] += e.vx[i] * dt; e.ey[i] += e.vy[i] * dt; e.ez[i] += e.vz[i] * dt
            const r2 = Math.hypot(e.ex[i], e.ez[i])
            if (r2 < 0.02 && e.ey[i] < water - 0.03) { const s = 0.02 / (r2 || 1); e.ex[i] = (e.ex[i] || 0.001) * s; e.ez[i] *= s }
            if (r2 > RIN - 0.003) { const s = (RIN - 0.003) / r2; e.ex[i] *= s; e.ez[i] *= s; e.vx[i] *= -0.4; e.vz[i] *= -0.4 }
            if (e.ey[i] < 0.004) { e.ey[i] = 0.004; e.vy[i] = Math.abs(e.vy[i]) * 0.3 }
            if (e.ey[i] > water - 0.004) {
              if (T > 0.3) { e.m[i] = 1; e.ez[i] = d * (RIN + 0.004); e.ey[i] = water; e.vz[i] = d * (0.12 + Math.random() * 0.2); e.vy[i] = 0.1 + Math.random() * 0.25 * T; e.vx[i] = (Math.random() - 0.5) * 0.1 }
              else { e.ey[i] = water - 0.004; e.vy[i] = -Math.abs(e.vy[i]) * 0.2 }
            }
          }
          g++
        }
      }
    }

    // ---------- scene
    type Hit = { x0: number; y0: number; x1: number; y1: number; d: number; key: string; pos: number }
    let hits: Hit[] = []
    let labels: (() => void)[] = []
    let hover: Hit | null = null

    function drawJar(l: Line3, ji: number, x: number, z: number, g: number, time: number) {
      const j = l.jars[ji], d = dirOf(l), sel = props.current.selKey === l.key && props.current.selPos === ji
      const ySp = Y0 + j.water, yBed = Y0 + Math.max(j.bed, 0.012), on = j.on
      const tone = (pal as any)[on ? j.tone : 'off'] ?? pal.off
      const rp = RJ * S, ry = rp * sE
      P(x, Y0, z); const bx = PX, by = PY, depth = PD
      P(x, ySp, z); const sy = PY
      const pxH = by - sy
      const dim = focusRef.current && l.key !== props.current.selKey
      ctx.globalAlpha = dim ? 0.22 : 1
      hits.push({ x0: bx - rp * 1.5, y0: sy - 0.55 * S * cE, x1: bx + rp * 1.5, y1: by + ry + 0.2 * S, d: depth, key: l.key, pos: ji })

      // status disc on the shelf: reads at a glance from far away
      ell(x, Y0 - 0.005, z, 0.125, tone + '55', undefined)
      const spoutFront = d * cp > 0      // spout side faces the camera
      const tz = z + d * 0.17

      const drawTray = () => {
        box(x, tz, 0.3, 0.42, 0.04, 0.035, 0.1, 0.085, pal.tray, pal.trayEdge, pal.water)
        if (j.Q > 0.02 && on) ell(x, TRAY_Y, tz, 0.07, pal.waterDeep)
        if (j.Q > 0.02 && on) {
          const w = Math.max(1.5, Math.min(7, (0.012 + j.Q * 0.0025) * S))
          seg([x, ySp - 0.01, z + d * (RJ + 0.02)], [x, TRAY_Y + 0.02, z + d * (RJ + 0.02)], w, pal.flow, 'round', [Math.max(3, 0.05 * S), Math.max(3, 0.04 * S)], -time * S * 0.9)
          seg([x, ySp - 0.01, z + d * (RJ + 0.02)], [x, TRAY_Y + 0.02, z + d * (RJ + 0.02)], Math.max(1, w * 0.35), 'rgba(255,255,255,0.7)', 'round', [Math.max(2, 0.03 * S), Math.max(5, 0.06 * S)], -time * S * 1.3)
        }
      }
      if (!spoutFront) drawTray()

      if (pxH < 14) { // very far out: coloured bar
        ctx.fillStyle = tone; ctx.fillRect(bx - rp, sy, rp * 2, pxH); ctx.globalAlpha = 1; if (spoutFront) drawTray(); return
      }
      // water body
      const gr = ctx.createLinearGradient(0, sy, 0, by); gr.addColorStop(0, pal.water); gr.addColorStop(1, pal.waterDeep)
      ctx.fillStyle = gr; ctx.beginPath(); ctx.ellipse(bx, by, rp, ry, 0, 0, 6.2832); ctx.fill()
      ctx.fillRect(bx - rp, sy, rp * 2, pxH)
      ell(x, ySp, z, RJ, pal.water, undefined)
      // egg bed
      P(x, yBed, z); const byBed = PY
      ctx.fillStyle = tone + '55'; ctx.fillRect(bx - rp, byBed, rp * 2, by - byBed); ell(x, yBed, z, RJ, tone + '66', undefined)
      // water rising through the jar: bright streaks moving upward
      if (on && j.Q > 0.05 && S > 45) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = Math.max(1, 0.006 * S); ctx.lineCap = 'round'
        const sp2 = 0.25 + Math.min(1.6, j.Q * 0.12)
        for (let k = 0; k < 6; k++) {
          const ph = (time * sp2 + k / 6 + g * 0.13) % 1, yy = yBed + 0.02 + ph * (ySp - yBed - 0.04)
          const ox = Math.sin(k * 2.1 + g) * RJ * 0.65
          P(x + ox * cp, yy, z + ox * sp); ctx.beginPath(); ctx.moveTo(PX, PY); ctx.lineTo(PX, PY - 0.035 * S * cE - 2); ctx.stroke()
        }
      }
      // eggs
      const e = eggs.current
      if (e && S > 55) {
        ctx.fillStyle = pal.egg; ctx.beginPath()
        for (let k = 0; k < NE; k++) {
          const i = g * NE + k; P(x + e.ex[i], Y0 + e.ey[i], z + e.ez[i])
          const rr = Math.max(1.2, 0.0045 * S); ctx.moveTo(PX + rr, PY); ctx.arc(PX, PY, rr, 0, 6.283)
        }
        ctx.fill()
      }
      // striped feeder pipe from the header down to the jar floor, with water running down it
      const vy = ySp + 0.3
      const pw = Math.max(2, 0.038 * S)
      seg([x, YH, z], [x, Y0 + 0.04, z], pw + 1.5, pal.ink)
      if (S > 45) seg([x, ySp, z], [x, Y0 + 0.04, z], pw, '#e0902a', 'butt', [Math.max(3, 0.05 * S), Math.max(3, 0.05 * S)])
      if (j.Q > 0.02 && on) seg([x, YH, z], [x, Y0 + 0.05, z], Math.max(1.5, pw * 0.42), pal.flow, 'round', [Math.max(3, 0.05 * S), Math.max(3, 0.06 * S)], time * S * 0.9 * (0.4 + j.Q * 0.07))
      // glass outline, sheen, rim
      ctx.strokeStyle = pal.ink; ctx.lineWidth = Math.max(1, 0.012 * S); ctx.lineCap = 'butt'
      ctx.beginPath(); ctx.moveTo(bx - rp, sy); ctx.lineTo(bx - rp, by); ctx.ellipse(bx, by, rp, ry, 0, Math.PI, 0, true); ctx.lineTo(bx + rp, sy); ctx.stroke()
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = Math.max(1, 0.015 * S)
      ctx.beginPath(); ctx.moveTo(bx - rp * 0.55, sy + 3); ctx.lineTo(bx - rp * 0.55, by - 4); ctx.stroke()
      // cap
      seg([x, ySp, z], [x, ySp + 0.03, z], (RJ + 0.012) * 2 * S, pal.tray)
      ell(x, ySp + 0.03, z, RJ + 0.012, pal.tray, pal.ink, Math.max(1, 0.01 * S))
      // spout lip
      seg([x, ySp, z + d * RJ], [x, ySp, z + d * (RJ + 0.04)], Math.max(2, 0.025 * S), pal.ink)
      // valve: white body with the red lever (open = along the pipe, closed = across it)
      pipe([x, vy - 0.045, z], [x, vy + 0.045, z], 0.03)
      const open = j.valve / 100, ang = (1 - open) * Math.PI / 2
      seg([x, vy, z], [x, vy + Math.cos(ang) * 0.17, z + Math.sin(ang) * 0.17 * d], Math.max(2.4, 0.024 * S), on ? pal.handle : pal.off, 'round')
      // status lamp
      P(x, ySp + 0.075, z); ctx.fillStyle = tone; ctx.strokeStyle = pal.ink; ctx.lineWidth = 1
      ctx.beginPath(); ctx.arc(PX, PY, Math.max(2.4, 0.026 * S), 0, 6.283); ctx.fill(); ctx.stroke()
      if (sel) { ell(x, Y0 - 0.005, z, 0.17, 'rgba(255,255,255,0.18)', pal.acc, 2.5) }
      if (S > 85) { P(x, Y0 - 0.03, z); ctx.fillStyle = pal.text; ctx.font = `600 ${Math.max(9, Math.min(13, 0.1 * S))}px system-ui,sans-serif`; ctx.textAlign = 'center'; ctx.fillText(String(ji + 1), PX, PY + ry + 14); ctx.textAlign = 'start' }
      ctx.globalAlpha = 1
      if (spoutFront) { ctx.globalAlpha = dim ? 0.22 : 1; drawTray(); ctx.globalAlpha = 1 }
    }

    function drawRow(l: Line3, g0: number, time: number) {
      const sp0 = props.current.spacing, z = rowZ(l), n = l.jars.length, h = (n * sp0) / 2 + 0.1
      const dim = focusRef.current && l.key !== props.current.selKey
      ctx.globalAlpha = dim ? 0.22 : 1
      const selRow = l.key === props.current.selKey
      if (selRow) { // soft plate under the selected row
        const q = [[-h - 0.1, z - 0.5], [h + 0.1, z - 0.5], [h + 0.1, z + 0.5], [-h - 0.1, z + 0.5]]
        ctx.beginPath(); q.forEach(([a, b], i) => { P(a, 0.01, b); i ? ctx.lineTo(PX, PY) : ctx.moveTo(PX, PY) }); ctx.closePath()
        ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fill(); ctx.strokeStyle = pal.acc; ctx.lineWidth = 2; ctx.stroke()
      }
      // shelf and legs
      box(0, z, 0.4, 0.5, h, 0.12, h, 0.12, pal.stand, pal.ink, '#7d8f90')
      for (const px of [-h + 0.06, 0, h - 0.06]) for (const dz of [-0.09, 0.09]) box(px, z + dz, 0, 0.4, 0.022, 0.022, 0.022, 0.022, pal.stand, pal.ink)
      ctx.globalAlpha = 1
      const order = Array.from({ length: n }, (_, i) => i)
      order.sort((a, b) => { const xa = (a - (n - 1) / 2) * sp0, xb = (b - (n - 1) / 2) * sp0; return (-xa * sp) - (-xb * sp) })
      for (const i of order) drawJar(l, i, (i - (n - 1) / 2) * sp0, z, g0 + i, time)
      // header pipe along the row with water flowing
      ctx.globalAlpha = dim ? 0.22 : 1
      const tot = l.jars.reduce((a, q) => a + (q.on ? q.Q : 0), 0)
      pipe([-h - 0.45, YH, z], [h - 0.05, YH, z], 0.05, tot / Math.max(1, n) * 3, time, 0.5)
      P(h - 0.05, YH, z); ctx.fillStyle = pal.pipeEdge; ctx.beginPath(); ctx.arc(PX, PY, 0.05 * S, 0, 6.283); ctx.fill()
      // label is drawn in a final pass so nearer rows never paint over it
      labels.push(() => {
        P(-h - 0.28, 0.04, z); ctx.globalAlpha = dim ? 0.35 : 1
        ctx.fillStyle = pal.text; ctx.font = `700 ${Math.max(11, Math.min(15, 0.14 * S))}px system-ui,sans-serif`; ctx.textAlign = 'right'
        ctx.fillText(`S${l.station} · ${String.fromCharCode(65 + l.idx)}`, PX, PY)
        ctx.font = `${Math.max(10, Math.min(12, 0.11 * S))}px system-ui,sans-serif`; ctx.fillStyle = pal.flow
        ctx.fillText(`${tot.toFixed(0)} L/min`, PX, PY + Math.max(12, Math.min(15, 0.14 * S))); ctx.textAlign = 'start'; ctx.globalAlpha = 1
      })
      ctx.globalAlpha = 1
    }

    function drawScene(time: number) {
      const L = props.current.lines, sp0 = props.current.spacing
      const gr = ctx.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, pal.bg0); gr.addColorStop(1, pal.bg1)
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H)
      const nSt = nStOf(), nMax = Math.max(...L.map(l => l.jars.length), 1), hx = (nMax * sp0) / 2 + 0.3
      const zr0 = ((nSt - 1) / 2) * STATION_GAP + 1.7
      // floor plate and 1 m grid
      ctx.beginPath(); for (const [a, b] of [[-hx - 1.6, -zr0 - 0.6], [hx + 0.4, -zr0 - 0.6], [hx + 0.4, zr0], [-hx - 1.6, zr0]]) { P(a, 0, b); ctx.lineTo(PX, PY) }
      ctx.closePath(); ctx.fillStyle = pal.floor; ctx.fill(); ctx.strokeStyle = pal.grid; ctx.lineWidth = 1
      ctx.beginPath()
      for (let xg = Math.ceil(-hx - 1.6); xg <= hx + 0.4; xg++) { P(xg, 0, -zr0 - 0.6); ctx.moveTo(PX, PY); P(xg, 0, zr0); ctx.lineTo(PX, PY) }
      for (let zg = Math.ceil(-zr0 - 0.6); zg <= zr0; zg++) { P(-hx - 1.6, 0, zg); ctx.moveTo(PX, PY); P(hx + 0.4, 0, zg); ctx.lineTo(PX, PY) }
      ctx.stroke()
      hits = []; labels = []

      const gBase = new Map<string, number>(); let acc = 0
      for (const l of L) { gBase.set(l.key, acc); acc += l.jars.length }
      type Item = { d: number; run: () => void }
      const items: Item[] = []
      const zcOf = (s: number) => (s - 1 - (nSt - 1) / 2) * STATION_GAP
      for (let s = 1; s <= nSt; s++) {
        const rows = L.filter(l => l.station === s); if (!rows.length) continue
        const zc = zcOf(s), half = (Math.max(...rows.map(r => r.jars.length)) * sp0) / 2 + 0.1
        P(0, 0, zc); items.push({ d: PD, run: () => {
          // gutter between the two rows, water flowing toward the sump end (-x)
          box(0, zc, 0.12, 0.3, half, 0.2, half, 0.2, '#c9d6d6', pal.trayEdge, pal.gutter)
          const q = rows.reduce((a, r) => a + r.jars.reduce((b, jj) => b + (jj.on ? jj.Q : 0), 0), 0)
          if (q > 0.1) seg([half - 0.05, 0.31, zc], [-half + 0.05, 0.31, zc], Math.max(2, 0.06 * S), pal.flow, 'round', [Math.max(4, 0.07 * S), Math.max(4, 0.07 * S)], time * S * 0.7)
        } })
        for (const r of rows) { P(0, 0, rowZ(r)); items.push({ d: PD, run: () => drawRow(r, gBase.get(r.key)!, time) }) }
      }
      items.sort((a, b) => a.d - b.d)
      // manifold on the supply end (left) with the pump
      const manifold = () => {
        const xm = -hx - 0.55 - 0.45
        const zs = L.map(rowZ), zmin = Math.min(...zs), zmax = Math.max(...zs)
        const tot = L.reduce((a, l) => a + l.jars.reduce((b, jj) => b + (jj.on ? jj.Q : 0), 0), 0)
        for (const l of L) pipe([xm, YH, rowZ(l)], [-(l.jars.length * sp0) / 2 - 0.55, YH, rowZ(l)], 0.045, tot / 40, time)
        pipe([xm, YH, zmin - 0.9], [xm, YH, zmax], 0.075, tot / 40, time, 0.5)
        pipe([xm, 0.2, zmin - 0.9], [xm, YH, zmin - 0.9], 0.075, tot / 40, time, 0.5)
        box(xm, zmin - 0.9, 0, 0.25, 0.2, 0.2, 0.2, 0.2, '#3a6aa0', pal.ink, '#5a8ac0')
        labels.push(() => { P(xm, 0, zmin - 0.9 + 0.22); ctx.fillStyle = pal.text; ctx.font = '700 12px system-ui,sans-serif'; ctx.textAlign = 'center'
          ctx.fillText('RAS pump', PX, PY + 14); ctx.font = '12px system-ui,sans-serif'; ctx.fillStyle = pal.flow; ctx.fillText(`${tot.toFixed(0)} L/min`, PX, PY + 28); ctx.textAlign = 'start' })
      }
      if (sp <= 0) manifold()
      for (const it of items) it.run()
      if (sp > 0) manifold()
      for (const fn of labels) fn()

      const lab = hover
      if (lab) {
        const l = L.find(q => q.key === lab.key), j = l?.jars[lab.pos]
        if (j) {
          const t1 = `${j.code}  ·  ${j.Q.toFixed(2)} L/min`, t2 = `valve ${Math.round(j.valve)}%  ·  ${j.status}`
          ctx.font = '600 12px system-ui,sans-serif'
          const w = Math.max(ctx.measureText(t1).width, ctx.measureText(t2).width) + 16
          const bx = Math.min(W - w - 4, Math.max(4, (lab.x0 + lab.x1) / 2 - w / 2)), by = Math.max(4, lab.y0 - 46)
          ctx.fillStyle = pal.bg0; ctx.strokeStyle = pal.acc; ctx.lineWidth = 1
          ctx.beginPath(); ctx.roundRect(bx, by, w, 40, 6); ctx.fill(); ctx.stroke()
          ctx.fillStyle = pal.text; ctx.fillText(t1, bx + 8, by + 16); ctx.font = '12px system-ui,sans-serif'; ctx.fillStyle = (pal as any)[j.tone] ?? pal.text; ctx.fillText(t2, bx + 8, by + 32)
        }
      }
    }

    function resize() {
      const w = wrap.clientWidth, h = wrap.clientHeight, dpr = window.devicePixelRatio || 1
      if (!w || !h) return
      W = w; H = h; cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); needFit.current = true
    }
    const ro = new ResizeObserver(resize); ro.observe(wrap); resize()

    function frame(now: number) {
      const dt = Math.min(0.033, (now - last) / 1000); last = now; tick++
      if (tick % 60 === 1) pal = palette(redRef.current)
      if (needFit.current && W) { fit(); needFit.current = false; if (tick < 3) Object.assign(cam.current, goal.current) }
      const c = cam.current, g = goal.current, k = REDUCE ? 1 : 0.14
      c.yaw += (g.yaw - c.yaw) * k; c.elev += (g.elev - c.elev) * k; c.S += (g.S - c.S) * k
      c.tx += (g.tx - c.tx) * k; c.ty += (g.ty - c.ty) * k; c.tz += (g.tz - c.tz) * k
      const total = props.current.lines.reduce((a, l) => a + l.jars.length, 0)
      ensureEggs(total)
      if (W && H && total) { setCamera(c); stepEggs(dt, now / 1000); drawScene(now / 1000) }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    // ---------- input: drag = move, Shift/right drag = turn, wheel/pinch = zoom, click = select
    const ptrs = new Map<number, { x: number; y: number }>()
    let moved = 0, startX = 0, startY = 0, pinch = 0
    const pick = (x: number, y: number) => { let best: Hit | null = null; for (const h of hits) if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1 && (!best || h.d > best.d)) best = h; return best }
    const rect = () => cv.getBoundingClientRect()
    const down = (e: PointerEvent) => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; startX = e.clientX; startY = e.clientY; if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y) } }
    const move = (e: PointerEvent) => {
      const p = ptrs.get(e.pointerId)
      if (!p) { const r = rect(); hover = pick(e.clientX - r.left, e.clientY - r.top); cv.style.cursor = hover ? 'pointer' : 'grab'; return }
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy)
      const g = goal.current, c = cam.current
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()], dd = Math.hypot(a.x - b.x, a.y - b.y); if (pinch) g.S = Math.min(400, Math.max(25, g.S * (dd / pinch))); pinch = dd; return }
      if (e.shiftKey || e.buttons === 2) { g.yaw -= dx * 0.006; g.elev = Math.min(1.3, Math.max(0.25, g.elev + dy * 0.004)); c.yaw = g.yaw; c.elev = g.elev }
      else {
        // move the scene with the pointer: invert the screen-to-world mapping
        const a = cp, b = sp, d = -sp * sE, e2 = cp * sE, det = a * e2 - b * d, u = -dx / S, v = -dy / S
        const wx = (e2 * u - b * v) / det, wz = (-d * u + a * v) / det
        g.tx += wx; g.tz += wz; c.tx = g.tx; c.tz = g.tz
      }
    }
    const up = (e: PointerEvent) => {
      ptrs.delete(e.pointerId); pinch = 0
      if (moved < 6 && Math.hypot(e.clientX - startX, e.clientY - startY) < 6) { const r = rect(), h = pick(e.clientX - r.left, e.clientY - r.top); if (h) props.current.onSelect(h.key, h.pos) }
    }
    const wheel = (e: WheelEvent) => { e.preventDefault(); const g = goal.current; g.S = Math.min(400, Math.max(25, g.S * Math.exp(-e.deltaY * 0.0012))) }
    const key = (e: KeyboardEvent) => {
      const g = goal.current
      if (e.key === '+' || e.key === '=') g.S = Math.min(400, g.S * 1.15); else if (e.key === '-') g.S = Math.max(25, g.S / 1.15)
      else if (e.key === 'ArrowLeft') g.yaw += 0.15; else if (e.key === 'ArrowRight') g.yaw -= 0.15
      else if (e.key === 'ArrowUp') g.elev = Math.min(1.3, g.elev + 0.06); else if (e.key === 'ArrowDown') g.elev = Math.max(0.25, g.elev - 0.06)
      else return
      e.preventDefault()
    }
    const leave = () => { hover = null }
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up)
    cv.addEventListener('pointercancel', up); cv.addEventListener('pointerleave', leave); cv.addEventListener('wheel', wheel, { passive: false })
    cv.addEventListener('contextmenu', e => e.preventDefault()); cv.addEventListener('keydown', key)
    return () => {
      cancelAnimationFrame(raf); ro.disconnect()
      cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up)
      cv.removeEventListener('pointercancel', up); cv.removeEventListener('pointerleave', leave); cv.removeEventListener('wheel', wheel); cv.removeEventListener('keydown', key)
    }
  }, [])

  const btn = (k: Kind, label: string) => <button className={kind === k ? '' : 'ghost'} aria-pressed={kind === k} onClick={() => ask(k)}>{label}</button>
  return (
    <div>
      <div className="row" style={{ marginBottom: 8, alignItems: 'center' }}>
        <span className="chip" style={{ color: 'var(--mute)' }}>Fit</span>
        {btn('all', 'All jars')}{btn('station', 'This station')}{btn('line', 'This line')}
        <span className="chip" style={{ color: 'var(--mute)', marginLeft: 8 }}>Turn</span>
        <button className="ghost" aria-label="Turn left" onClick={() => rotate(-1)}>&#8630;</button>
        <button className="ghost" aria-label="Turn right" onClick={() => rotate(1)}>&#8631;</button>
        <button className="ghost" onClick={resetView}>Isometric</button>
        <button className="ghost" aria-label="Zoom out" onClick={() => zoom(1 / 1.25)}>&minus;</button>
        <button className="ghost" aria-label="Zoom in" onClick={() => zoom(1.25)}>+</button>
        <label className="chk" style={{ marginLeft: 'auto' }}><input type="checkbox" checked={focus} onChange={e => setFocus(e.target.checked)} /> Fade other lines</label>
        <label className="chk"><input type="checkbox" checked={red} onChange={e => setRed(e.target.checked)} /> Red room light</label>
      </div>
      <div ref={wrapRef} style={{ position: 'relative', height: 'min(76vh, 700px)', minHeight: 460, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--line)' }}>
        <canvas ref={cvRef} tabIndex={0} role="img" aria-label="Isometric 3D view of every hatchery jar with its pipes and water flow. Drag to move, scroll to zoom, click a jar to select it. Arrow keys turn the view, plus and minus zoom."
          style={{ display: 'block', touchAction: 'none', cursor: 'grab', outlineOffset: -3 }} />
      </div>
      <p className="note">Blue dashes show water moving: through the header and feeder pipes, up through each jar, over the spout into its tray, and along the gutter to the sump. A jar's lamp and floor disc show its status. Drag to move, scroll or pinch to zoom, Shift+drag to turn, click a jar to select it.</p>
    </div>
  )
}
