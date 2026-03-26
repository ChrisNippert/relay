import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { User } from '../types'
import * as api from '../services/api'
import { connect, disconnect } from '../services/ws'
import { generateKeyPair } from '../services/crypto'

const PRIVKEY_STORAGE = 'relay_e2e_privkey'

async function ensureKeyPair() {
  const existing = localStorage.getItem(PRIVKEY_STORAGE)
  if (existing) {
    // Already have a keypair; check if server has our public key
    const me = await api.getMe()
    if (!me.public_key) {
      const kp = await generateKeyPair()
      localStorage.setItem(PRIVKEY_STORAGE, kp.privateKey)
      await api.updatePublicKey(kp.publicKey)
    }
    return
  }
  // Generate fresh keypair
  const kp = await generateKeyPair()
  localStorage.setItem(PRIVKEY_STORAGE, kp.privateKey)
  await api.updatePublicKey(kp.publicKey)
}

export function getPrivateKey(): string | null {
  return localStorage.getItem(PRIVKEY_STORAGE)
}

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
        .then(async (u) => {
          setUser(u)
          connect()
          await ensureKeyPair().catch(console.error)
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
    await ensureKeyPair().catch(console.error)
  }

  const register = async (username: string, email: string, password: string, displayName: string) => {
    const res = await api.register(username, email, password, displayName)
    api.setToken(res.token)
    setUser(res.user)
    connect()
    await ensureKeyPair().catch(console.error)
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
