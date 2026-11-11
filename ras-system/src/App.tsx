import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { useAuth } from './lib/auth'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import DataEntry from './pages/DataEntry'
import Plc from './pages/Plc'
import Admin from './pages/Admin'

export default function App() {
  const { session, role, loading } = useAuth()
  if (loading) return <p className="wrap">Loading...</p>
  if (!session) return <Login />
  return (
    <div className="wrap">
      <header className="top">
        <h1>RAS System</h1>
        <span className="muted">{session.user.email} ({role})</span>
        <button className="ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>
      <nav className="tabs">
        <NavLink to="/">Dashboard</NavLink>
        <NavLink to="/data">Data entry</NavLink>
        <NavLink to="/plc">PLC I/O</NavLink>
        <NavLink to="/admin">Admin</NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/data" element={<DataEntry />} />
        <Route path="/plc" element={<Plc />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </div>
  )
}
