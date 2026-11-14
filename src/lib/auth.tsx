import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

type Ctx = { session: Session | null; role: string; loading: boolean }
const AuthCtx = createContext<Ctx>({ session: null, role: 'viewer', loading: true })
export const useAuth = () => useContext(AuthCtx)
export const AUTO = { email: (import.meta.env.VITE_AUTO_LOGIN_EMAIL as string) || '', password: (import.meta.env.VITE_AUTO_LOGIN_PASSWORD as string) || '' }
export const NO_LOGIN = !!AUTO.email
export const canEdit = (role: string) => role === 'operator' || role === 'admin'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState('viewer')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      // Phone / kiosk builds have no sign-in screen: they sign in by themselves as a read-only monitor account.
      if (!data.session && AUTO.email) {
        const r = await supabase.auth.signInWithPassword({ email: AUTO.email, password: AUTO.password })
        data = { session: r.data.session } as typeof data
      }
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
