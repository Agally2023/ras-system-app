import { useEffect, useRef, useState } from 'react'

// Dependency-free 3D hatchery: perspective projection on a 2D canvas, painter's algorithm, orbit camera.
// World units are metres. Rows run along X. Each station has two rows (A and B) facing a shared gutter.

export type J3 = {
  Q: number; T: number; bed: number; settled: number; water: number; valve: number
  on: boolean; tone: string; stage: number; wash: boolean; code: string; status: string
}
export type Line3 = { key: string; station: number; idx: number; jars: J3[] }
type Props = {
  lines: Line3[]; selKey: string; selPos: number; spacing: number
  onSelect: (key: string, pos: number) => void
}

const NE = 36            // eggs per jar
const Y0 = 0.85          // jar floor height above the ground
const YH = 1.95          // header pipe height
const RJ = 0.062         // jar outer radius
const RIN = 0.054        // inner radius for eggs
const TRAY_Y = 0.7       // tray water surface
const STATION_GAP = 2.4

type Pal = {
  bg0: string; bg1: string; floorA: string; floorB: string; pipe: string; pipeEdge: string; ink: string
  water: string; egg: string; flow: string; stand: string; tray: string; trayEdge: string; handle: string
  bin: string; ok: string; warn: string; bad: string; off: string; acc: string; text: string
}
function palette(red: boolean): Pal {
  const css = getComputedStyle(document.documentElement)
  const v = (n: string, d: string) => css.getPropertyValue(n).trim() || d
  if (red) return {
    bg0: '#240706', bg1: '#4b0f0b', floorA: '#5d1612', floorB: '#4f120f', pipe: '#ff9a8a', pipeEdge: '#c9392e', ink: '#ffd6cf',
    water: 'rgba(255,130,110,0.30)', egg: '#ff6a3a', flow: '#ffc2b5', stand: '#2b1210', tray: '#ffb0a2', trayEdge: '#d9483c',
    handle: '#ff2a1c', bin: '#7a2a3a', ok: '#8fe3b0', warn: '#ffd166', bad: '#ff5a4d', off: '#a98', acc: '#ffe1da', text: '#ffe1da',
  }
  return {
    bg0: v('--bg', '#f1f6f5'), bg1: v('--panel', '#e2ece9'), floorA: v('--panel', '#e2ece9'), floorB: v('--card', '#ffffff'),
    pipe: v('--pipe', '#cfe7e3'), pipeEdge: v('--acc', '#0b6b63'), ink: v('--ink', '#10302f'), water: 'rgba(90,170,210,0.40)',
    egg: v('--egg', '#d98a1c'), flow: v('--flow', '#2a8fbd'), stand: '#4b5a59', tray: v('--card', '#ffffff'), trayEdge: v('--ink', '#10302f'),
    handle: '#d9322a', bin: '#36527f', ok: v('--ok', '#2f8f5f'), warn: v('--warn', '#c98a1b'), bad: v('--bad', '#c0392b'),
    off: v('--mute', '#7a8f8c'), acc: v('--acc', '#0b6b63'), text: v('--ink', '#10302f'),
  }
}

export default function Hatchery3D({ lines, selKey, selPos, spacing, onSelect }: Props) {
  const cvRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const props = useRef({ lines, selKey, selPos, spacing, onSelect })
  props.current = { lines, selKey, selPos, spacing, onSelect }
  const [red, setRed] = useState(false)
  const redRef = useRef(false); redRef.current = red
  const [fade, setFade] = useState(true)
  const fadeRef = useRef(true); fadeRef.current = fade
  const cam = useRef({ yaw: 0.55, pitch: 0.24, dist: 5.2, tx: 0, ty: 1.15, tz: 0 })
  const goal = useRef({ ...cam.current })
  const eggs = useRef<{ n: number; ex: Float32Array; ey: Float32Array; ez: Float32Array; vx: Float32Array; vy: Float32Array; vz: Float32Array; f: Float32Array; ph: Float32Array; m: Uint8Array; lost: Uint16Array } | null>(null)

  // ---------- layout helpers
  const rowZ = (l: Line3, nSt: number) => (l.station - 1 - (nSt - 1) / 2) * STATION_GAP + (l.idx === 0 ? -0.5 : 0.5)
  const dirOf = (l: Line3) => (l.idx === 0 ? 1 : -1)   // which way the spouts face (toward the gutter)

  function preset(name: 'row' | 'along' | 'all' | 'top') {
    const { lines: L, selKey: k } = props.current
    const nSt = Math.max(...L.map(l => l.station), 1)
    const l = L.find(x => x.key === k) ?? L[0]; if (!l) return
    const z = rowZ(l, nSt), d = dirOf(l)
    const g = goal.current
    setFade(name !== 'all')
    if (name === 'row') Object.assign(g, { tx: 0, ty: 1.15, tz: z, yaw: d > 0 ? 0.5 : Math.PI + 0.5, pitch: 0.22, dist: 5.4 })
    if (name === 'along') Object.assign(g, { tx: -0.6, ty: 1.2, tz: z + d * 0.1, yaw: Math.PI / 2 + (d > 0 ? 0.3 : -0.3), pitch: 0.1, dist: 4.4 })
    if (name === 'all') Object.assign(g, { tx: 0, ty: 0.9, tz: 0, yaw: 0.7, pitch: 0.5, dist: 13 })
    if (name === 'top') Object.assign(g, { tx: 0, ty: 0.9, tz: z, yaw: 0, pitch: 1.4, dist: 6 })
    if (window.matchMedia('(prefers-reduced-motion:reduce)').matches) Object.assign(cam.current, g)
  }
  useEffect(() => { preset('row') }, [selKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cv = cvRef.current!, wrap = wrapRef.current!
    const ctx = cv.getContext('2d')!
    const REDUCE = window.matchMedia('(prefers-reduced-motion:reduce)').matches
    let W = 0, H = 0, raf = 0, last = performance.now(), tick = 0, pal = palette(false)
    const FOV = Math.tan((48 * Math.PI) / 360)

    // camera basis
    let cx = 0, cy = 0, cz = 0, fx = 0, fy = 0, fz = 0, rx = 0, ry = 0, rz = 0, ux = 0, uy = 0, uz = 0, F = 600
    let PX = 0, PY = 0, PS = 0, PZ = 0
    function setCamera() {
      const c = cam.current
      const cp = Math.cos(c.pitch)
      cx = c.tx + c.dist * Math.sin(c.yaw) * cp; cy = c.ty + c.dist * Math.sin(c.pitch); cz = c.tz + c.dist * Math.cos(c.yaw) * cp
      let x = c.tx - cx, y = c.ty - cy, z = c.tz - cz; const l = Math.hypot(x, y, z); fx = x / l; fy = y / l; fz = z / l
      // right = normalize(cross(f, worldUp))
      x = -fz; y = 0; z = fx; const lr = Math.hypot(x, z) || 1; rx = x / lr; ry = 0; rz = z / lr
      ux = ry * fz - rz * fy; uy = rz * fx - rx * fz; uz = rx * fy - ry * fx
      F = H / 2 / FOV
    }
    function P(x: number, y: number, z: number) {
      const dx = x - cx, dy = y - cy, dz = z - cz
      PZ = dx * fx + dy * fy + dz * fz
      if (PZ < 0.15) return false
      PS = F / PZ
      PX = W / 2 + (dx * rx + dy * ry + dz * rz) * PS
      PY = H / 2 - (dx * ux + dy * uy + dz * uz) * PS
      return true
    }

    // ---------- drawing primitives
    function poly(pts: number[], fill?: string, stroke?: string, lw = 1) {
      ctx.beginPath(); ctx.moveTo(pts[0], pts[1])
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1])
      ctx.closePath()
      if (fill) { ctx.fillStyle = fill; ctx.fill() }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke() }
    }
    function circleH(x: number, y: number, z: number, r: number, fill?: string, stroke?: string, lw = 1) {
      const pts: number[] = []
      for (let i = 0; i < 16; i++) { const a = (i / 16) * 6.2832; if (!P(x + Math.cos(a) * r, y, z + Math.sin(a) * r)) return; pts.push(PX, PY) }
      poly(pts, fill, stroke, lw)
    }
    // vertical cylinder: bottom ellipse, side, top ellipse
    function cylV(x: number, z: number, ya: number, yb: number, r: number, fill: string, stroke: string, lw = 1, ellipses = true) {
      const dx = x - cx, dz = z - cz, L = Math.hypot(dx, dz) || 1, px = (-dz / L) * r, pz = (dx / L) * r
      if (ellipses) circleH(x, ya, z, r, fill, stroke, lw)
      if (!P(x + px, ya, z + pz)) return; const a1 = PX, a2 = PY
      if (!P(x - px, ya, z - pz)) return; const b1 = PX, b2 = PY
      if (!P(x - px, yb, z - pz)) return; const c1 = PX, c2 = PY
      if (!P(x + px, yb, z + pz)) return
      poly([a1, a2, b1, b2, c1, c2, PX, PY], fill, undefined)
      ctx.strokeStyle = stroke; ctx.lineWidth = lw
      ctx.beginPath(); ctx.moveTo(a1, a2); ctx.lineTo(PX, PY); ctx.moveTo(b1, b2); ctx.lineTo(c1, c2); ctx.stroke()
      if (ellipses) circleH(x, yb, z, r, fill, stroke, lw)
    }
    // horizontal cylinder along X
    function cylX(xa: number, xb: number, y: number, z: number, r: number, fill: string, stroke: string, lw = 1) {
      const vx = (xa + xb) / 2 - cx, vy = y - cy, vz = z - cz
      let ox = 0, oy = -vz, oz = vy; const l = Math.hypot(oy, oz) || 1; oy = (oy / l) * r; oz = (oz / l) * r; ox = 0
      if (!P(xa, y + oy, z + oz)) return; const a1 = PX, a2 = PY
      if (!P(xa, y - oy, z - oz)) return; const b1 = PX, b2 = PY
      if (!P(xb, y - oy, z - oz)) return; const c1 = PX, c2 = PY
      if (!P(xb, y + oy, z + oz)) return
      void ox; void vx
      poly([a1, a2, b1, b2, c1, c2, PX, PY], fill, stroke, lw)
    }
    // tapered box (frustum), centred on x,z. Sides sorted far to near, then top.
    function box(x: number, z: number, y0: number, y1: number, hxb: number, hzb: number, hxt: number, hzt: number, fill: string, stroke: string, top?: string) {
      const bot = [[-hxb, -hzb], [hxb, -hzb], [hxb, hzb], [-hxb, hzb]], tp = [[-hxt, -hzt], [hxt, -hzt], [hxt, hzt], [-hxt, hzt]]
      const faces: { d: number; pts: number[] }[] = []
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4, q: number[] = []; let ok = true
        for (const [px, py, pz] of [[x + bot[i][0], y0, z + bot[i][1]], [x + bot[j][0], y0, z + bot[j][1]], [x + tp[j][0], y1, z + tp[j][1]], [x + tp[i][0], y1, z + tp[i][1]]]) {
          if (!P(px, py, pz)) { ok = false; break } q.push(PX, PY)
        }
        if (!ok) continue
        const mx = x + (bot[i][0] + bot[j][0]) / 2, mz = z + (bot[i][1] + bot[j][1]) / 2
        faces.push({ d: Math.hypot(mx - cx, (y0 + y1) / 2 - cy, mz - cz), pts: q })
      }
      faces.sort((a, b) => b.d - a.d)
      // only the faces turned toward the camera are visible, the far ones are covered by drawing order
      for (const fc of faces) poly(fc.pts, fill, stroke, 1)
      if (cy > y1) {
        const q: number[] = []
        for (const [px, pz] of tp) { if (!P(x + px, y1, z + pz)) return; q.push(PX, PY) }
        poly(q, top ?? fill, stroke, 1)
      }
    }
    function line3(a: number[], b: number[], col: string, w: number, dash?: number[], off = 0) {
      if (!P(a[0], a[1], a[2])) return; const x1 = PX, y1 = PY
      if (!P(b[0], b[1], b[2])) return
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round'
      ctx.setLineDash(dash ?? []); ctx.lineDashOffset = off
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(PX, PY); ctx.stroke(); ctx.setLineDash([])
    }

    // ---------- eggs
    function ensureEggs(total: number) {
      if (eggs.current && eggs.current.n === total) return
      const n = total * NE, e = {
        n: total, ex: new Float32Array(n), ey: new Float32Array(n), ez: new Float32Array(n), vx: new Float32Array(n), vy: new Float32Array(n),
        vz: new Float32Array(n), f: new Float32Array(n), ph: new Float32Array(n), m: new Uint8Array(n), lost: new Uint16Array(total),
      }
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.28, r = Math.sqrt(Math.random()) * (RIN - 0.004)
        e.ex[i] = Math.cos(a) * r; e.ez[i] = Math.sin(a) * r; e.f[i] = Math.random(); e.ey[i] = 0.01 + e.f[i] * 0.07; e.ph[i] = Math.random() * 6.28
      }
      eggs.current = e
    }
    function stepEggs(dt: number, time: number) {
      const e = eggs.current; if (!e) return
      let g = 0
      const nSt = Math.max(...props.current.lines.map(l => l.station), 1); void nSt
      for (const l of props.current.lines) {
        const d = dirOf(l)
        for (const j of l.jars) {
          const base = g * NE, T = j.on ? j.T : 0, bed = Math.max(j.bed, 0.012), gentle = j.wash ? 0 : Math.min(1, Math.max(0, bed / 0.08 - 0.7))
          const water = j.water, trayLocal = TRAY_Y - Y0 + 0.015
          for (let k = 0; k < NE; k++) {
            const i = base + k
            if (e.m[i] === 2) continue
            if (REDUCE || !j.on) { e.m[i] = 0; e.ey[i] = 0.006 + e.f[i] * Math.max(bed - 0.012, 0.004); continue }
            if (e.m[i] === 1) {
              e.vy[i] -= 3.2 * dt; e.ex[i] += e.vx[i] * dt; e.ey[i] += e.vy[i] * dt; e.ez[i] += e.vz[i] * dt
              if (e.ey[i] <= trayLocal) {
                e.m[i] = 2; e.ey[i] = trayLocal + Math.random() * 0.012
                e.ez[i] = d * (0.12 + Math.random() * 0.05); e.ex[i] = (Math.random() - 0.5) * 0.09; e.vx[i] = e.vy[i] = e.vz[i] = 0; e.lost[g]++
              }
              continue
            }
            const yT = 0.006 + e.f[i] * Math.max(bed - 0.012, 0.004), kk = 18 * (1 - T) * (1 - T) + 0.4
            const rr = Math.hypot(e.ex[i], e.ez[i])
            let ay = kk * (yT - e.ey[i]) - 4 * e.vy[i] + 0.14 * gentle * Math.sin(time * 1.3 + e.ph[i]) + (Math.random() - 0.5) * T * 5.6
            const ax = -4 * e.vx[i] + 0.035 * gentle * Math.sin(time * 1.7 + e.ph[i] * 1.3) + (Math.random() - 0.5) * T * 4.2
            const az = -4 * e.vz[i] + 0.035 * gentle * Math.cos(time * 1.5 + e.ph[i] * 1.1) + (Math.random() - 0.5) * T * 4.2
            if (rr < 0.03) ay -= T * 0.7 * (1 - rr / 0.03); else if (rr > 0.035) ay += T * 0.18
            if (j.wash) ay -= 0.8
            e.vx[i] += ax * dt; e.vy[i] += ay * dt; e.vz[i] += az * dt
            e.ex[i] += e.vx[i] * dt; e.ey[i] += e.vy[i] * dt; e.ez[i] += e.vz[i] * dt
            const r2 = Math.hypot(e.ex[i], e.ez[i])
            if (r2 < 0.017 && e.ey[i] < water - 0.03) { const s = 0.017 / (r2 || 1); e.ex[i] = (e.ex[i] || 0.001) * s; e.ez[i] *= s }
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
    type Hit = { x0: number; y0: number; x1: number; y1: number; z: number; key: string; pos: number }
    let hits: Hit[] = []
    let hover: Hit | null = null

    function drawJar(l: Line3, ji: number, x: number, z: number, g: number, time: number, nLines: number) {
      const j = l.jars[ji], d = dirOf(l), sel = props.current.selKey === l.key && props.current.selPos === ji
      const yTop = Y0 + j.water + 0.06, ySp = Y0 + j.water, yBed = Y0 + Math.max(j.bed, 0.012)
      const tone = (pal as any)[j.on ? j.tone : 'off'] ?? pal.off
      if (!P(x, Y0, z)) return; const bx = PX, by = PY, sc = PS
      if (!P(x, yTop + 0.05, z)) return
      const pxH = Math.abs(by - PY)
      const colLeft = bx - RJ * sc * 1.4, colRight = bx + RJ * sc * 1.4
      hits.push({ x0: colLeft, y0: PY - 8, x1: colRight, y1: by + 30, z: PZ, key: l.key, pos: ji })
      void nLines

      // tray under the spout and the overflow stream
      const tz = z + d * 0.14
      box(x, tz, 0.6, 0.72, 0.035, 0.028, 0.085, 0.066, pal.tray, pal.trayEdge, pal.water)
      if (j.Q > 0.02 && j.on) {
        const w = Math.max(1, Math.min(6, (0.004 + j.Q * 0.0009) * sc))
        line3([x, ySp - 0.003, z + d * RJ], [x, TRAY_Y, z + d * 0.13], pal.flow, w, [4, 6], -time * 40)
      }
      if (pxH < 22) { // far away: a coloured bar is enough
        if (P(x, Y0, z)) { const a = PX, b = PY; P(x, yTop, z); ctx.fillStyle = tone; ctx.fillRect(a - 2, PY, 4, b - PY) }
        return
      }
      // jar back, water, bed
      cylV(x, z, Y0, ySp, RJ - 0.004, pal.water, 'rgba(0,0,0,0)', 0, true)
      cylV(x, z, Y0, yBed, RJ - 0.006, tone + '40', 'rgba(0,0,0,0)', 0, false)
      if (j.on && j.T > 0.05) { // turbulence cone
        if (P(x, Y0 + 0.01, z)) { const a = PX, b = PY; if (P(x, Math.min(ySp, yBed + 0.1 + j.T * 0.25), z)) { ctx.strokeStyle = pal.flow; ctx.globalAlpha = 0.25; ctx.lineWidth = Math.max(1, 0.02 * sc * (0.5 + j.T)); ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(PX, PY); ctx.stroke(); ctx.globalAlpha = 1 } }
      }
      // eggs
      const e = eggs.current
      if (e && pxH > 55) {
        ctx.fillStyle = pal.egg; ctx.beginPath()
        for (let k = 0; k < NE; k++) {
          const i = g * NE + k
          if (!P(x + e.ex[i], Y0 + e.ey[i], z + e.ez[i])) continue
          const rr = Math.max(1.1, 0.0042 * PS); ctx.moveTo(PX + rr, PY); ctx.arc(PX, PY, rr, 0, 6.283)
        }
        ctx.fill()
      }
      // striped drop pipe, from the valve to near the jar floor
      cylV(x, z, Y0 + 0.03, YH - 0.02, 0.012, pal.ink, pal.ink, 0.6, false)
      if (pxH > 40) for (let y = Y0 + 0.05; y < ySp - 0.02; y += 0.07) { cylV(x, z, y, Math.min(y + 0.025, ySp), 0.0125, '#e0902a', 'rgba(0,0,0,0)', 0, false) }
      // glass front
      cylV(x, z, Y0, yTop - 0.04, RJ, 'rgba(255,255,255,0.07)', pal.ink, Math.max(1, 0.0035 * sc), false)
      circleH(x, Y0, z, RJ, undefined, pal.ink, Math.max(0.8, 0.002 * sc))
      // cap, spout lip
      cylV(x, z, yTop - 0.04, yTop - 0.012, RJ + 0.008, pal.tray, pal.ink, Math.max(0.8, 0.002 * sc))
      box(x, z + d * (RJ + 0.012), ySp - 0.012, ySp + 0.004, 0.018, 0.012, 0.018, 0.012, pal.tray, pal.ink)
      // valve (ball body and red lever) and tee into the header
      const vy = 1.55
      cylV(x, z, vy - 0.03, vy + 0.03, 0.022, pal.tray, pal.ink, Math.max(0.8, 0.002 * sc))
      const open = j.valve / 100, ang = (1 - open) * Math.PI / 2
      line3([x, vy, z], [x, vy + Math.cos(ang) * 0.1, z + Math.sin(ang) * 0.1 * d], j.on ? pal.handle : pal.off, Math.max(2, 0.011 * sc))
      cylV(x, z, vy + 0.03, YH, 0.016, pal.pipe, pal.pipeEdge, 0.8, false)
      // header segment for this bay with flowing dashes
      const sp = props.current.spacing
      cylX(x - sp / 2, x + sp / 2, YH, z, 0.032, pal.pipe, pal.pipeEdge, 0.8)
      if (j.Q > 0.02 && j.on) line3([x - sp / 2, YH, z], [x + sp / 2, YH, z], pal.flow, Math.max(1, 0.006 * sc), [5, 7], -time * 30)
      // status lamp on top, ring when selected
      if (P(x, yTop + 0.035, z)) { ctx.fillStyle = tone; ctx.beginPath(); ctx.arc(PX, PY, Math.max(2.2, 0.011 * PS), 0, 6.283); ctx.fill() }
      if (sel) circleH(x, 0.78, z, RJ + 0.045, 'rgba(255,255,255,0.10)', pal.acc, 2.4)
      void ji
    }

    function drawScene(time: number) {
      const L = props.current.lines
      const nSt = Math.max(...L.map(l => l.station), 1), sp = props.current.spacing
      // background
      const gr = ctx.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, pal.bg0); gr.addColorStop(1, pal.bg1)
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H)
      // floor tiles
      const maxN = Math.max(...L.map(l => l.jars.length), 1), X = Math.ceil((maxN * sp) / 2 + 2), Z = Math.ceil((nSt * STATION_GAP) / 2 + 2)
      const tiles: { d: number; q: number[]; a: boolean }[] = []
      for (let i = -X; i < X; i++) for (let k = -Z; k < Z; k++) {
        const q: number[] = []; let ok = true
        for (const [a, b] of [[i, k], [i + 1, k], [i + 1, k + 1], [i, k + 1]]) { if (!P(a, 0, b)) { ok = false; break } q.push(PX, PY) }
        if (ok) tiles.push({ d: Math.hypot(i + 0.5 - cx, cy, k + 0.5 - cz), q, a: (i + k) % 2 === 0 })
      }
      tiles.sort((a, b) => b.d - a.d)
      for (const t of tiles) poly(t.q, t.a ? pal.floorA : pal.floorB)
      ctx.globalAlpha = 0.5
      for (const t of tiles) poly(t.q, undefined, pal.bg1, 0.5)
      ctx.globalAlpha = 1

      hits = []
      // stations far to near
      const stations = Array.from({ length: nSt }, (_, i) => i + 1)
      const zcOf = (s: number) => (s - 1 - (nSt - 1) / 2) * STATION_GAP
      stations.sort((a, b) => Math.hypot(zcOf(b) - cz, cx) - Math.hypot(zcOf(a) - cz, cx))
      // global jar index per line
      const gBase = new Map<string, number>(); let acc = 0
      for (const l of L) { gBase.set(l.key, acc); acc += l.jars.length }
      for (const s of stations) {
        const zc = zcOf(s), rows = L.filter(l => l.station === s)
        if (!rows.length) continue
        const half = (Math.max(...rows.map(r => r.jars.length)) * sp) / 2 + 0.15
        // gutter and the bin below it
        box(0, zc, 0.02, 0.52, half * 0.9, 0.34, half * 0.9, 0.34, pal.bin, pal.ink, pal.bin)
        box(0, zc, 0.52, 0.6, half, 0.08, half, 0.1, pal.tray, pal.trayEdge, pal.water)
        rows.sort((a, b) => Math.abs(rowZ(b, nSt) - cz) - Math.abs(rowZ(a, nSt) - cz))
        for (const l of rows) {
          const z = rowZ(l, nSt), n = l.jars.length, h = (n * sp) / 2 + 0.1
          ctx.globalAlpha = fadeRef.current && l.key !== props.current.selKey ? 0.14 : 1
          // shelf, posts
          box(0, z, 0.78, 0.85, h, 0.07, h, 0.07, pal.stand, pal.ink)
          for (const px of [-h + 0.05, 0, h - 0.05]) box(px, z, 0, 0.78, 0.025, 0.025, 0.025, 0.025, pal.stand, pal.ink)
          // jars far to near along the row
          const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => Math.abs((b - (n - 1) / 2) * sp - cx) - Math.abs((a - (n - 1) / 2) * sp - cx))
          for (const i of order) drawJar(l, i, (i - (n - 1) / 2) * sp, z, gBase.get(l.key)! + i, time, L.length)
          // row label
          ctx.globalAlpha = 1
          if ((!fadeRef.current || l.key === props.current.selKey) && P(-h - 0.05, YH + 0.18, z)) { ctx.fillStyle = pal.text; ctx.font = '600 12px system-ui,sans-serif'; ctx.textAlign = 'right'; ctx.fillText(`S${l.station} · ${String.fromCharCode(65 + l.idx)}`, PX, PY); ctx.textAlign = 'start' }
        }
      }
      // hover / selection label
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
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const ro = new ResizeObserver(resize); ro.observe(wrap); resize()

    function frame(now: number) {
      const dt = Math.min(0.033, (now - last) / 1000); last = now; tick++
      if (tick % 60 === 1) pal = palette(redRef.current)
      const c = cam.current, g = goal.current, k = REDUCE ? 1 : 0.12
      c.yaw += (g.yaw - c.yaw) * k; c.pitch += (g.pitch - c.pitch) * k; c.dist += (g.dist - c.dist) * k
      c.tx += (g.tx - c.tx) * k; c.ty += (g.ty - c.ty) * k; c.tz += (g.tz - c.tz) * k
      const total = props.current.lines.reduce((a, l) => a + l.jars.length, 0)
      ensureEggs(total)
      if (W && H && total) { setCamera(); stepEggs(dt, now / 1000); drawScene(now / 1000) }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    // ---------- input: drag = orbit, shift/right drag = pan, wheel and pinch = zoom, click = select
    const ptrs = new Map<number, { x: number; y: number }>()
    let moved = 0, startX = 0, startY = 0, pinch = 0
    const pick = (x: number, y: number) => {
      let best: Hit | null = null
      for (const h of hits) if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1 && (!best || h.z < best.z)) best = h
      return best
    }
    const rect = () => cv.getBoundingClientRect()
    const down = (e: PointerEvent) => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; startX = e.clientX; startY = e.clientY; if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y) } }
    const move = (e: PointerEvent) => {
      const p = ptrs.get(e.pointerId)
      if (!p) { const r = rect(); hover = pick(e.clientX - r.left, e.clientY - r.top); cv.style.cursor = hover ? 'pointer' : 'grab'; return }
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy)
      const g = goal.current, c = cam.current
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()], dd = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinch) g.dist = Math.min(22, Math.max(1.6, g.dist * (pinch / dd))); pinch = dd; return
      }
      if (e.shiftKey || e.buttons === 2 || e.buttons === 4) {
        const s = g.dist * 0.0016; g.tx -= (rx * dx - ux * dy) * s; g.ty -= (ry * dx - uy * dy) * s; g.tz -= (rz * dx - uz * dy) * s
        g.ty = Math.max(0.2, Math.min(2.5, g.ty)); c.tx = g.tx; c.ty = g.ty; c.tz = g.tz
      } else { g.yaw -= dx * 0.006; g.pitch = Math.min(1.45, Math.max(0.03, g.pitch + dy * 0.006)); c.yaw = g.yaw; c.pitch = g.pitch }
    }
    const up = (e: PointerEvent) => {
      ptrs.delete(e.pointerId); pinch = 0
      if (moved < 6 && Math.hypot(e.clientX - startX, e.clientY - startY) < 6) {
        const r = rect(), h = pick(e.clientX - r.left, e.clientY - r.top)
        if (h) props.current.onSelect(h.key, h.pos)
      }
    }
    const wheel = (e: WheelEvent) => { e.preventDefault(); const g = goal.current; g.dist = Math.min(22, Math.max(1.6, g.dist * Math.exp(e.deltaY * 0.001))) }
    const key = (e: KeyboardEvent) => {
      const g = goal.current
      if (e.key === 'ArrowLeft') g.yaw += 0.12; else if (e.key === 'ArrowRight') g.yaw -= 0.12
      else if (e.key === 'ArrowUp') g.pitch = Math.min(1.45, g.pitch + 0.08); else if (e.key === 'ArrowDown') g.pitch = Math.max(0.03, g.pitch - 0.08)
      else if (e.key === '+' || e.key === '=') g.dist = Math.max(1.6, g.dist * 0.88); else if (e.key === '-') g.dist = Math.min(22, g.dist / 0.88)
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

  return (
    <div>
      <div className="row" style={{ marginBottom: 8, alignItems: 'center' }}>
        <span className="chip" style={{ color: 'var(--mute)' }}>Camera</span>
        <button className="ghost" onClick={() => preset('row')}>This line</button>
        <button className="ghost" onClick={() => preset('along')}>Down the row</button>
        <button className="ghost" onClick={() => preset('all')}>Whole hatchery</button>
        <button className="ghost" onClick={() => preset('top')}>From above</button>
        <label className="chk" style={{ marginLeft: 'auto' }}><input type="checkbox" checked={fade} onChange={e => setFade(e.target.checked)} /> Fade other lines</label>
        <label className="chk"><input type="checkbox" checked={red} onChange={e => setRed(e.target.checked)} /> Red room light</label>
      </div>
      <div ref={wrapRef} style={{ position: 'relative', height: 560, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--line)' }}>
        <canvas ref={cvRef} tabIndex={0} role="img" aria-label="3D view of the hatchery jars. Drag to rotate, scroll to zoom, click a jar to select it. Arrow keys rotate, plus and minus zoom."
          style={{ display: 'block', touchAction: 'none', cursor: 'grab', outlineOffset: -3 }} />
      </div>
      <p className="note">Drag to turn the room, scroll or pinch to zoom, hold Shift and drag to move. Click a jar to select it. Eggs are drawn about twice their real size so you can see them.</p>
    </div>
  )
}
