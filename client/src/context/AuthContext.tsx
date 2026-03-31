import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { User } from '../types'
import * as api from '../services/api'
import { connect, disconnect } from '../services/ws'
import { generateKeyPair, publicKeyFromPrivate, generateSigningKeyPair } from '../services/crypto'

const PRIVKEY_STORAGE = 'relay_e2e_privkey'
const SIGNING_PRIVKEY_STORAGE = 'relay_e2e_signing_privkey'
const DEVICE_ID_STORAGE = 'relay_device_id'

let ensureKeyPairRunning = false

async function ensureKeyPair() {
  if (ensureKeyPairRunning) return
  ensureKeyPairRunning = true
  try {
    await doEnsureKeyPair()
  } finally {
    ensureKeyPairRunning = false
  }
}

async function doEnsureKeyPair() {
  const existing = localStorage.getItem(PRIVKEY_STORAGE)
  const existingDeviceId = localStorage.getItem(DEVICE_ID_STORAGE)

  // Derive public key from existing private key, or generate a new keypair
  const kp = existing
    ? { privateKey: existing, publicKey: await publicKeyFromPrivate(existing) }
    : await generateKeyPair()
  if (!existing) {
    localStorage.setItem(PRIVKEY_STORAGE, kp.privateKey)
  }

  // Signing key pair (ECDSA P-256)
  const existingSigning = localStorage.getItem(SIGNING_PRIVKEY_STORAGE)
  let signingPub = ''
  if (!existingSigning) {
    const skp = await generateSigningKeyPair()
    localStorage.setItem(SIGNING_PRIVKEY_STORAGE, skp.signingPrivateKey)
    signingPub = skp.signingPublicKey
  }

  try {
    const devices = await api.getMyDevices()

    // If we have a stored device_id that matches, we're in sync
    if (existingDeviceId) {
      const match = devices.find(d => d.id === existingDeviceId && d.public_key === kp.publicKey)
      if (match) return
    }

    // Check if any existing device already has this public key (e.g. duplicate registration)
    const sameKey = devices.find(d => d.public_key === kp.publicKey)
    if (sameKey) {
      localStorage.setItem(DEVICE_ID_STORAGE, sameKey.id)
      return
    }
  } catch {}

  // Register a new device (include signing key)
  const device = await api.registerDevice(kp.publicKey, '', signingPub)
  localStorage.setItem(DEVICE_ID_STORAGE, device.id)
  // Also sync public_key on user record for backward compat
  await api.updatePublicKey(kp.publicKey).catch(() => {})
}

export function getPrivateKey(): string | null {
  return localStorage.getItem(PRIVKEY_STORAGE)
}

export function getSigningPrivateKey(): string | null {
  return localStorage.getItem(SIGNING_PRIVKEY_STORAGE)
}

export function getDeviceId(): string | null {
  return localStorage.getItem(DEVICE_ID_STORAGE)
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

  const logout = async () => {
    try {
      await api.logout()
    } catch {
      // Ignore errors — clear local state regardless
    }
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
