// Real readings for the dashboard: ras_tag_readings (current hour) plus ras_tag_hourly (history),
// grouped in the database by ras_tags_series. Written by the PLC gateway (see gateway/).
import { supabase } from './supabase'
import { buckets, tagOf, type Attr, type Ctx, type Pt, type Range } from './series'

const p2 = (n: number) => String(n).padStart(2, '0')

export async function hasReadings(): Promise<boolean> {
  const a = await supabase.from('ras_tag_readings').select('id').limit(1)
  if (a.data?.length) return true
  const b = await supabase.from('ras_tag_hourly').select('tag_id').limit(1)
  return !!b.data?.length
}

type Row = { tag: string; bucket_start: string; avg_v: number; min_v: number; max_v: number; n: number }

export async function fetchSeries(systemId: string, attrs: Attr[], range: Range, now: number, ctx: Ctx): Promise<Record<string, Pt[]>> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const tags = [...new Set(attrs.map(a => tagOf(a, ctx)))]
  const bk = range === 'live' ? null : buckets(range, now)
  const since = range === 'live' ? now - 10 * 60000 : bk![0].start
  const { data, error } = await supabase.rpc('ras_tags_series', {
    p_system: systemId, p_tags: tags, p_bucket: range === 'live' ? 'raw' : range, p_since: new Date(since).toISOString(), p_until: new Date(now + 1000).toISOString(), p_tz: tz,
  })
  if (error) throw new Error(error.message)
  const by = new Map<string, Row[]>()
  for (const r of (data ?? []) as Row[]) by.set(r.tag, [...(by.get(r.tag) ?? []), r])
  const out: Record<string, Pt[]> = {}
  for (const a of attrs) {
    const rows = by.get(tagOf(a, ctx)) ?? []
    if (range === 'live') {
      out[a.id] = rows.map(r => { const t = Date.parse(r.bucket_start), d = new Date(t); return { t, v: r.avg_v, lo: r.avg_v, hi: r.avg_v, label: `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` } })
    } else {
      const m = new Map(rows.map(r => [Date.parse(r.bucket_start), r]))
      out[a.id] = bk!.map((b, i) => {
        const r = m.get(b.start)
        return r ? { t: (b.start + b.end) / 2, v: r.avg_v, lo: r.min_v, hi: r.max_v, label: b.label, partial: i === bk!.length - 1 }
          : { t: (b.start + b.end) / 2, v: NaN, lo: NaN, hi: NaN, label: b.label, partial: i === bk!.length - 1 }
      })
    }
  }
  return out
}
