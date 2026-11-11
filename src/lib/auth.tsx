import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

type Ctx = { session: Session | null; role: string; loading: boolean }
const AuthCtx = createContext<Ctx>({ session: null, role: 'viewer', loading: true })
export const useAuth = () => useContext(AuthCtx)
export const canEdit = (role: string) => role === 'operator' || role === 'admin'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState('viewer')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) { setRole('viewer'); return }
    supabase.from('ras_profiles').select('role').eq('id', session.user.id).maybeSingle()
      .then(({ data }) => setRole(data?.role ?? 'viewer'))
  }, [session])

  return <AuthCtx.Provider value={{ session, role, loading }}>{children}</AuthCtx.Provider>
}
