import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import axios from 'axios'
export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || '/api', withCredentials: true, timeout: 15000 })
type User = { id: string; name: string; email: string }
type Auth = { user: User | null; loading: boolean; error: string; refresh: () => Promise<void>; authenticate: (mode: string, data: object) => Promise<void>; logout: () => Promise<void> }
const Context = createContext<Auth | null>(null)
export function errorMessage(error: unknown) { return axios.isAxiosError(error) ? error.response?.data?.errors?.[0]?.message || error.response?.data?.message || 'Unable to reach the server. Please try again.' : 'Something went wrong. Please try again.' }
export function AuthProvider({ children }: { children: ReactNode }) {
 const [user, setUser] = useState<User | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
 async function refresh() { setLoading(true); setError(''); try { setUser((await api.get('/auth/me')).data.user) } catch(e) { setUser(null); if (!axios.isAxiosError(e) || e.response?.status !== 401) setError(errorMessage(e)) } finally { setLoading(false) } }
 useEffect(() => { void refresh() }, [])
 async function authenticate(mode: string, data: object) { setUser((await api.post(`/auth/${mode}`, data)).data.user); setError('') }
 async function logout() { await api.post('/auth/logout'); setUser(null) }
 return <Context.Provider value={{ user, loading, error, refresh, authenticate, logout }}>{children}</Context.Provider>
}
export function useAuth() { const auth = useContext(Context); if (!auth) throw new Error('Missing AuthProvider'); return auth }
