// E2E encryption manager — handles channel key setup, encrypt/decrypt
import * as crypto from './crypto'
import * as api from './api'
import { getPrivateKey } from '../context/AuthContext'

const ENC_PREFIX = 'ENC:'

// In-memory cache of decrypted channel keys (CryptoKey objects)
const channelKeyCache = new Map<string, CryptoKey>()

/**
 * Check if a channel has E2E encryption enabled (i.e. keys exist on server).
 */
export async function isChannelEncrypted(channelId: string): Promise<boolean> {
  if (channelKeyCache.has(channelId)) return true
  try {
    const keys = await api.getChannelKeys(channelId)
    return keys.length > 0
  } catch {
    return false
  }
}

/**
 * Get the decrypted channel key, loading from server if needed.
 * Returns null if no key exists for this user/channel.
 */
export async function getChannelKey(channelId: string): Promise<CryptoKey | null> {
  const cached = channelKeyCache.get(channelId)
  if (cached) return cached

  const privKey = getPrivateKey()
  if (!privKey) return null

  try {
    const keys = await api.getChannelKeys(channelId)
    const me = await api.getMe()
    const myEntry = keys.find(k => k.user_id === me.id)
    if (!myEntry) return null

    // encrypted_key format: "senderUserId:nonce.ciphertext"
    const colonIdx = myEntry.encrypted_key.indexOf(':')
    if (colonIdx === -1) return null
    const senderUserId = myEntry.encrypted_key.slice(0, colonIdx)
    const rest = myEntry.encrypted_key.slice(colonIdx + 1)

    const dotIdx = rest.indexOf('.')
    if (dotIdx === -1) return null
    const nonce = rest.slice(0, dotIdx)
    const ciphertext = rest.slice(dotIdx + 1)

    const sender = await api.getUser(senderUserId)
    if (!sender.public_key) return null

    // Derive shared secret: our private key + sender's public key
    const sharedKey = await crypto.deriveSharedKey(privKey, sender.public_key)

    // Decrypt the channel key (the plaintext is the base64 raw AES key)
    const channelKeyB64 = await crypto.decrypt(sharedKey, ciphertext, nonce)
    const channelKey = await crypto.importKey(channelKeyB64)

    channelKeyCache.set(channelId, channelKey)
    return channelKey
  } catch (e) {
    console.error('Failed to load channel key:', e)
    return null
  }
}

/**
 * Enable E2E encryption for a channel.
 * Generates a random channel key, encrypts it for every member, stores on server.
 */
export async function enableEncryption(channelId: string, serverId?: string): Promise<boolean> {
  const privKey = getPrivateKey()
  if (!privKey) return false

  try {
    const me = await api.getMe()

    // Generate a random AES-256-GCM channel key
    const channelKey = await crypto.generateChannelKey()
    const channelKeyB64 = await crypto.exportKey(channelKey)

    // Get all member user IDs
    let memberIds: string[]
    if (serverId) {
      const members = await api.getMembers(serverId)
      memberIds = members.map(m => m.user_id)
    } else {
      memberIds = await api.getDMParticipants(channelId)
    }

    // For each member with a public key, encrypt the channel key for them
    for (const memberId of memberIds) {
      const member = await api.getUser(memberId)
      if (!member.public_key) continue

      // Derive shared secret: our private key + their public key
      const sharedKey = await crypto.deriveSharedKey(privKey, member.public_key)

      // Encrypt the channel key
      const { ciphertext, nonce } = await crypto.encrypt(sharedKey, channelKeyB64)

      // Store as "myUserId:nonce.ciphertext" for that member
      const encryptedKey = `${me.id}:${nonce}.${ciphertext}`
      await api.setChannelKey(channelId, encryptedKey, memberId)
    }

    channelKeyCache.set(channelId, channelKey)
    return true
  } catch (e) {
    console.error('Failed to enable encryption:', e)
    return false
  }
}

/**
 * Redistribute the channel key to any members who are missing it.
 * Called when a user who has the key opens an encrypted channel.
 * This handles the case where encryption was enabled before a member
 * had logged in (and thus had no public key at the time).
 */
export async function redistributeKeys(channelId: string, serverId?: string): Promise<void> {
  const privKey = getPrivateKey()
  if (!privKey) return

  const channelKey = await getChannelKey(channelId)
  if (!channelKey) return

  try {
    const me = await api.getMe()
    const keys = await api.getChannelKeys(channelId)
    const usersWithKeys = new Set(keys.map(k => k.user_id))

    // Get all member user IDs
    let memberIds: string[]
    if (serverId) {
      const members = await api.getMembers(serverId)
      memberIds = members.map(m => m.user_id)
    } else {
      memberIds = await api.getDMParticipants(channelId)
    }

    const channelKeyB64 = await crypto.exportKey(channelKey)

    for (const memberId of memberIds) {
      if (usersWithKeys.has(memberId)) continue

      const member = await api.getUser(memberId)
      if (!member.public_key) continue

      const sharedKey = await crypto.deriveSharedKey(privKey, member.public_key)
      const { ciphertext, nonce } = await crypto.encrypt(sharedKey, channelKeyB64)
      const encryptedKey = `${me.id}:${nonce}.${ciphertext}`
      await api.setChannelKey(channelId, encryptedKey, memberId)
    }
  } catch (e) {
    console.error('Failed to redistribute keys:', e)
  }
}

/**
 * Encrypt a plaintext message. Returns the encrypted string with ENC: prefix.
 */
export async function encryptMessage(channelId: string, plaintext: string): Promise<string | null> {
  const key = await getChannelKey(channelId)
  if (!key) return null
  const { ciphertext, nonce } = await crypto.encrypt(key, plaintext)
  return `${ENC_PREFIX}${nonce}:${ciphertext}`
}

/**
 * Decrypt a message if it's encrypted. Returns plaintext.
 * If the message isn't encrypted, returns it as-is.
 */
export async function decryptMessage(channelId: string, content: string): Promise<string> {
  if (!content.startsWith(ENC_PREFIX)) return content
  const key = await getChannelKey(channelId)
  if (!key) return '[encrypted — missing key]'
  try {
    const payload = content.slice(ENC_PREFIX.length)
    const colonIdx = payload.indexOf(':')
    if (colonIdx === -1) return '[encrypted — invalid format]'
    const nonce = payload.slice(0, colonIdx)
    const ciphertext = payload.slice(colonIdx + 1)
    return await crypto.decrypt(key, ciphertext, nonce)
  } catch {
    return '[encrypted — decryption failed]'
  }
}

/**
 * Check if a message content string is encrypted.
 */
export function isEncryptedContent(content: string): boolean {
  return content.startsWith(ENC_PREFIX)
}

/**
 * Clear the cached channel key.
 */
export function clearChannelKey(channelId: string) {
  channelKeyCache.delete(channelId)
}
