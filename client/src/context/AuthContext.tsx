import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { User } from '../types'
import * as api from '../services/api'
import { connect, disconnect } from '../services/ws'

interface AuthCtx {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (username: string, email: string, password: string, displayName: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthCtx>(null!)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = api.getToken()
    if (token) {
      api.getMe()
        .then((u) => {
          setUser(u)
          connect()
        })
        .catch(() => {
          api.setToken(null)
        })
        .finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
    return () => disconnect()
  }, [])

  const login = async (email: string, password: string) => {
    const res = await api.login(email, password)
    api.setToken(res.token)
    setUser(res.user)
    connect()
  }

  const register = async (username: string, email: string, password: string, displayName: string) => {
    const res = await api.register(username, email, password, displayName)
    api.setToken(res.token)
    setUser(res.user)
    connect()
  }

  const logout = () => {
    api.setToken(null)
    disconnect()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
