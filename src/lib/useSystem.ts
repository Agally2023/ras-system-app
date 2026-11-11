import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'

export function useSystem() {
  const [state, set] = useState<{ system: any; settings: any; loading: boolean; error?: string }>(
    { system: null, settings: null, loading: true })

  const reload = useCallback(async () => {
    const { data: system, error } = await supabase.from('ras_systems')
      .select('*').order('created_at').limit(1).maybeSingle()
    if (error) return set({ system: null, settings: null, loading: false, error: error.message })
    if (!system) return set({ system: null, settings: null, loading: false })
    const { data: settings } = await supabase.from('ras_settings')
      .select('*').eq('system_id', system.id).maybeSingle()
    set({ system, settings, loading: false })
  }, [])

  useEffect(() => { reload() }, [reload])
  return { ...state, reload }
}
