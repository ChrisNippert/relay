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
 * Parse an encrypted_key blob.
 * New format: "pk.BASE64_SENDER_PUBKEY:nonce.ciphertext"
 * Old format: "senderUserId:nonce.ciphertext"
 */
function parseEncryptedKey(encryptedKey: string): { senderPubKey?: string; senderUserId?: string; nonce: string; ciphertext: string } | null {
  const colonIdx = encryptedKey.indexOf(':')
  if (colonIdx === -1) return null

  const prefix = encryptedKey.slice(0, colonIdx)
  const rest = encryptedKey.slice(colonIdx + 1)
  const dotIdx = rest.indexOf('.')
  if (dotIdx === -1) return null

  const nonce = rest.slice(0, dotIdx)
  const ciphertext = rest.slice(dotIdx + 1)

  if (prefix.startsWith('pk.')) {
    return { senderPubKey: prefix.slice(3), nonce, ciphertext }
  }
  return { senderUserId: prefix, nonce, ciphertext }
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

    const parsed = parseEncryptedKey(myEntry.encrypted_key)
    if (!parsed) return null

    let senderPubKey: string | undefined
    if (parsed.senderPubKey) {
      // New format — public key is embedded
      senderPubKey = parsed.senderPubKey
    } else if (parsed.senderUserId) {
      // Old format — look up sender's current public key (may fail if they regenerated)
      const sender = await api.getUser(parsed.senderUserId)
      senderPubKey = sender.public_key
    }
    if (!senderPubKey) return null

    // Derive shared secret: our private key + sender's public key
    const sharedKey = await crypto.deriveSharedKey(privKey, senderPubKey)

    // Decrypt the channel key (the plaintext is the base64 raw AES key)
    const channelKeyB64 = await crypto.decrypt(sharedKey, parsed.ciphertext, parsed.nonce)
    const channelKey = await crypto.importKey(channelKeyB64)

    channelKeyCache.set(channelId, channelKey)
    return channelKey
  } catch (e) {
    console.error('Failed to load channel key:', e)
    return null
  }
}

/**
 * Build an encrypted_key blob using the new format (embeds sender's public key).
 */
async function buildEncryptedKey(privKey: string, recipientPubKey: string, channelKeyB64: string): Promise<string> {
  const myPubKey = await crypto.publicKeyFromPrivate(privKey)
  const sharedKey = await crypto.deriveSharedKey(privKey, recipientPubKey)
  const { ciphertext, nonce } = await crypto.encrypt(sharedKey, channelKeyB64)
  return `pk.${myPubKey}:${nonce}.${ciphertext}`
}

/**
 * Enable E2E encryption for a channel.
 * Generates a random channel key, encrypts it for every member, stores on server.
 */
export async function enableEncryption(channelId: string, serverId?: string): Promise<boolean> {
  const privKey = getPrivateKey()
  if (!privKey) return false

  try {
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

      const encryptedKey = await buildEncryptedKey(privKey, member.public_key, channelKeyB64)
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
 * Redistribute the channel key to members who are missing it
 * or whose key entry is stale (encrypted for a different keypair).
 */
export async function redistributeKeys(channelId: string, serverId?: string): Promise<void> {
  const privKey = getPrivateKey()
  if (!privKey) return

  const channelKey = await getChannelKey(channelId)
  if (!channelKey) return

  try {
    const keys = await api.getChannelKeys(channelId)
    const existingKeyMap = new Map(keys.map(k => [k.user_id, k.encrypted_key]))

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
      const member = await api.getUser(memberId)
      if (!member.public_key) continue

      const existing = existingKeyMap.get(memberId)
      if (existing) {
        // Check if the existing entry was encrypted with the member's current keypair.
        // The entry stores the SENDER's public key, and ECDH was done with the member's
        // public key at the time. If the member has since changed keys, we need to re-encrypt.
        // We can detect this by trying: if the entry uses old format (userId-based),
        // upgrade it to new format. For new format entries, they'll work as long as
        // the member's private key hasn't changed — which we can't check from here.
        // But if the member deleted their old entries (via ensureKeyPair), they won't
        // have an entry at all, so this branch won't fire.
        // For robustness, also re-encrypt old-format entries to use the new pk. format.
        const parsed = parseEncryptedKey(existing)
        if (parsed && parsed.senderPubKey) continue // already new format, likely valid
        // Old format — upgrade to new format with embedded public key
      }

      const encryptedKey = await buildEncryptedKey(privKey, member.public_key, channelKeyB64)
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

/**
 * Rotate the channel key: wipe all existing keys, generate a fresh key,
 * and distribute it to all current members. Old messages encrypted with
 * the previous key become undecryptable for new/departed members.
 */
export async function rotateKeys(channelId: string, serverId?: string): Promise<boolean> {
  const privKey = getPrivateKey()
  if (!privKey) return false

  try {
    // Wipe all existing keys from the server
    await api.deleteChannelKeys(channelId)

    // Clear local cache so we don't use the old key
    channelKeyCache.delete(channelId)

    // Generate a brand new channel key
    const channelKey = await crypto.generateChannelKey()
    const channelKeyB64 = await crypto.exportKey(channelKey)

    // Get current members
    let memberIds: string[]
    if (serverId) {
      const members = await api.getMembers(serverId)
      memberIds = members.map(m => m.user_id)
    } else {
      memberIds = await api.getDMParticipants(channelId)
    }

    // Encrypt the new key for every current member who has a public key
    for (const memberId of memberIds) {
      const member = await api.getUser(memberId)
      if (!member.public_key) continue
      const encryptedKey = await buildEncryptedKey(privKey, member.public_key, channelKeyB64)
      await api.setChannelKey(channelId, encryptedKey, memberId)
    }

    channelKeyCache.set(channelId, channelKey)
    return true
  } catch (e) {
    console.error('Failed to rotate channel keys:', e)
    return false
  }
}
