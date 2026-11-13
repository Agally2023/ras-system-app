import { useEffect, useId, useState } from 'react'

// Alarm siren built with the Web Audio API (no sound files). Browsers only allow sound after the user has touched
// the page once, so the first tap or key press unlocks it. Every screen that has alarms calls useAlarmSound(); the
// siren plays while any of them has an alarm that nobody has acknowledged or silenced yet.
type Want = { on: boolean; urgent: boolean }
const wants = new Map<string, Want>()
const listeners = new Set<() => void>()
let ctx: AudioContext | null = null
let timer: ReturnType<typeof setInterval> | null = null
let timerUrgent = false, flip = false, enabled = true
try { enabled = localStorage.getItem('ras_alarm_sound') !== '0' } catch { /* storage blocked */ }
const emit = () => listeners.forEach(f => f())

function audio(): AudioContext | null {
  if (!ctx) {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    ctx.onstatechange = emit
  }
  return ctx
}
function beep(freq = 880, len = 0.28) {
  const c = audio()
  if (!c || c.state !== 'running') return
  const o = c.createOscillator(), g = c.createGain(), t = c.currentTime
  o.type = 'triangle'; o.frequency.value = freq
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.22, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + len)
  o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + len + 0.02)
}
function sync() {
  const on = [...wants.values()].some(w => w.on), urgent = [...wants.values()].some(w => w.on && w.urgent)
  if (!enabled || !on) {
    if (timer) { clearInterval(timer); timer = null }
    return
  }
  const c = audio()
  if (c && c.state === 'suspended') c.resume().catch(() => { /* needs a tap first */ })
  if (timer && timerUrgent === urgent) return
  if (timer) clearInterval(timer)
  timerUrgent = urgent
  const tick = () => { flip = !flip; beep(flip ? 880 : 660, urgent ? 0.16 : 0.3) }
  tick()
  timer = setInterval(tick, urgent ? 340 : 800)
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) try { navigator.vibrate([200, 100, 200]) } catch { /* ignore */ }
}
if (typeof window !== 'undefined') {
  const unlock = () => { const c = audio(); if (c && c.state === 'suspended') c.resume().then(() => { emit(); sync() }).catch(() => { /* ignore */ }); emit() }
  window.addEventListener('pointerdown', unlock, { passive: true })
  window.addEventListener('keydown', unlock)
}

export function useSoundState() {
  const [, force] = useState(0)
  useEffect(() => { const f = () => force(n => n + 1); listeners.add(f); return () => { listeners.delete(f) } }, [])
  return {
    enabled, blocked: !!ctx && ctx.state !== 'running' || !ctx,
    setEnabled: (v: boolean) => { enabled = v; try { localStorage.setItem('ras_alarm_sound', v ? '1' : '0') } catch { /* ignore */ } sync(); emit() },
    test: () => { const c = audio(); c?.resume().then(() => { beep(880); setTimeout(() => beep(660), 250); emit() }).catch(() => { /* ignore */ }) },
  }
}

// Plays the siren while `on` is true. `urgent` makes it faster. Returns true while it is sounding.
export function useAlarmSound(on: boolean, urgent = false) {
  const id = useId()
  const s = useSoundState()
  useEffect(() => { wants.set(id, { on, urgent }); sync(); return () => { wants.delete(id); sync() } }, [id, on, urgent])
  return on && s.enabled
}

export function SoundToggle() {
  const s = useSoundState()
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <button className="ghost" aria-pressed={s.enabled} onClick={() => s.setEnabled(!s.enabled)} title="Play a siren while an alarm is active">Alarm sound: {s.enabled ? 'on' : 'off'}</button>
      {s.enabled && <button className="ghost" onClick={s.test} title="Also allows the browser to play sound">{s.blocked ? 'Tap to allow sound' : 'Test'}</button>}
    </span>
  )
}
