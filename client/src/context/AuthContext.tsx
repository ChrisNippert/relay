import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { User } from '../types'
import * as api from '../services/api'
import { connect, disconnect } from '../services/ws'
import { generateKeyPair, publicKeyFromPrivate } from '../services/crypto'

const PRIVKEY_STORAGE = 'relay_e2e_privkey'

async function ensureKeyPair() {
  const existing = localStorage.getItem(PRIVKEY_STORAGE)
  if (existing) {
    // Have a local private key — derive its public key and verify it matches the server
    const me = await api.getMe()
    const localPub = await publicKeyFromPrivate(existing)
    if (me.public_key === localPub) return // keys are in sync
    // Mismatch or server has no key — re-upload the public key derived from our local private key
    await api.updatePublicKey(localPub)
    return
  }
  // No local key (new device) — generate fresh keypair
  const kp = await generateKeyPair()
  localStorage.setItem(PRIVKEY_STORAGE, kp.privateKey)
  await api.updatePublicKey(kp.publicKey)
  // Invalidate old channel key entries (encrypted for previous keypair)
  await api.deleteMyChannelKeys().catch(() => {})
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
  updateUser: (partial: Partial<User>) => void
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

  const updateUser = (partial: Partial<User>) => {
    setUser((prev) => prev ? { ...prev, ...partial } : prev)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
