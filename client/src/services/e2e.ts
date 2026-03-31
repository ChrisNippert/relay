// E2E encryption manager — epoch-based key model with message signing
import * as crypto from './crypto'
import * as api from './api'
import { getPrivateKey, getSigningPrivateKey, getDeviceId } from '../context/AuthContext'

const ENC_PREFIX = 'ENC:'

// Dev logging — filter console by [E2E] to monitor encryption
const E2E_DEBUG = true
function e2eLog(...args: unknown[]) { if (E2E_DEBUG) console.log('%c[E2E]', 'color: #00e0ff; font-weight: bold', ...args) }
function e2eWarn(...args: unknown[]) { if (E2E_DEBUG) console.warn('%c[E2E]', 'color: #ffaa00; font-weight: bold', ...args) }

// In-memory cache of decrypted channel keys keyed by "channelId:epoch"
const channelKeyCache = new Map<string, CryptoKey>()

// Cache the current (latest) epoch per channel
const currentEpochCache = new Map<string, number>()

function cacheKey(channelId: string, epoch: number): string {
  return `${channelId}:${epoch}`
}

/**
 * Check if a channel has E2E encryption enabled (i.e. keys exist on server).
 */
export async function isChannelEncrypted(channelId: string): Promise<boolean> {
  if (currentEpochCache.has(channelId)) {
    e2eLog(`isChannelEncrypted(${channelId.slice(0,8)}…) → true (cached epoch=${currentEpochCache.get(channelId)})`)
    return true
  }
  try {
    const keys = await api.getChannelKeys(channelId)
    const result = keys.length > 0
    e2eLog(`isChannelEncrypted(${channelId.slice(0,8)}…) → ${result} (${keys.length} key entries on server)`)
    return result
  } catch {
    return false
  }
}

/**
 * Parse an encrypted_key blob.
 * Format: "pk.BASE64_SENDER_PUBKEY:nonce.ciphertext"
 */
function parseEncryptedKey(encryptedKey: string): { senderPubKey: string; nonce: string; ciphertext: string } | null {
  const colonIdx = encryptedKey.indexOf(':')
  if (colonIdx === -1) return null

  const prefix = encryptedKey.slice(0, colonIdx)
  const rest = encryptedKey.slice(colonIdx + 1)
  const dotIdx = rest.indexOf('.')
  if (dotIdx === -1) return null

  const nonce = rest.slice(0, dotIdx)
  const ciphertext = rest.slice(dotIdx + 1)

  if (!prefix.startsWith('pk.')) return null
  return { senderPubKey: prefix.slice(3), nonce, ciphertext }
}

/**
 * Get the decrypted channel key for a specific epoch, loading from server if needed.
 * Returns null if no key exists for this device/channel/epoch.
 */
export async function getChannelKeyForEpoch(channelId: string, epoch: number): Promise<CryptoKey | null> {
  const ck = cacheKey(channelId, epoch)
  const cached = channelKeyCache.get(ck)
  if (cached) return cached

  const privKey = getPrivateKey()
  const deviceId = getDeviceId()
  if (!privKey || !deviceId) return null

  try {
    const keys = await api.getChannelKeys(channelId)
    const myEntry = keys.find(k => k.device_id === deviceId && k.epoch === epoch)
    if (!myEntry) return null

    const parsed = parseEncryptedKey(myEntry.encrypted_key)
    if (!parsed) return null

    const sharedKey = await crypto.deriveSharedKey(privKey, parsed.senderPubKey)
    const channelKeyB64 = await crypto.decrypt(sharedKey, parsed.ciphertext, parsed.nonce)
    const channelKey = await crypto.importKey(channelKeyB64)

    channelKeyCache.set(ck, channelKey)
    e2eLog(`🔑 Loaded channel key: channel=${channelId.slice(0,8)}… epoch=${epoch} senderPK=${parsed.senderPubKey.slice(0,12)}… keyPreview=${channelKeyB64.slice(0,16)}…`)
    return channelKey
  } catch (e) {
    e2eWarn(`Failed to load channel key: channel=${channelId.slice(0,8)}… epoch=${epoch}`, e)
    return null
  }
}

/**
 * Get the decrypted channel key for the current (latest) epoch.
 * Returns null if no key exists for this device/channel.
 */
export async function getChannelKey(channelId: string): Promise<CryptoKey | null> {
  const epoch = await getCurrentEpoch(channelId)
  if (epoch < 0) {
    e2eWarn(`getChannelKey(${channelId.slice(0,8)}…) — no epoch found`)
    return null
  }
  const key = await getChannelKeyForEpoch(channelId, epoch)
  e2eLog(`getChannelKey(${channelId.slice(0,8)}…) → epoch=${epoch} key=${key ? 'OK' : 'MISSING'}`)
  return key
}

/**
 * Get the current (latest) epoch from the server, with caching.
 */
export async function getCurrentEpoch(channelId: string): Promise<number> {
  const cached = currentEpochCache.get(channelId)
  if (cached !== undefined) return cached
  try {
    const { epoch } = await api.getChannelEpoch(channelId)
    if (epoch >= 0) currentEpochCache.set(channelId, epoch)
    e2eLog(`getCurrentEpoch(${channelId.slice(0,8)}…) → ${epoch}`)
    return epoch
  } catch {
    return -1
  }
}

/**
 * Build an encrypted_key blob using the device format (embeds sender's public key).
 */
async function buildEncryptedKey(privKey: string, recipientPubKey: string, channelKeyB64: string): Promise<string> {
  const myPubKey = await crypto.publicKeyFromPrivate(privKey)
  const sharedKey = await crypto.deriveSharedKey(privKey, recipientPubKey)
  const { ciphertext, nonce } = await crypto.encrypt(sharedKey, channelKeyB64)
  return `pk.${myPubKey}:${nonce}.${ciphertext}`
}

/**
 * Encrypt the channel key for all devices of all channel members and upload at the given epoch.
 */
async function distributeKeyToDevices(channelId: string, epoch: number, channelKeyB64: string): Promise<void> {
  const privKey = getPrivateKey()
  if (!privKey) return

  const devices = await api.getChannelDevices(channelId)
  e2eLog(`📤 Distributing key: channel=${channelId.slice(0,8)}… epoch=${epoch} to ${devices.length} devices`)
  for (const device of devices) {
    if (!device.public_key) {
      e2eWarn(`  ⚠ Skipping device ${device.id.slice(0,8)}… — no public key`)
      continue
    }
    const encryptedKey = await buildEncryptedKey(privKey, device.public_key, channelKeyB64)
    await api.setChannelKey(channelId, encryptedKey, device.id, epoch)
    e2eLog(`  → Encrypted key for device ${device.id.slice(0,8)}…`)
  }
}

/**
 * Enable E2E encryption for a channel.
 * Generates a random channel key at epoch 0, encrypted ONLY for the calling user's
 * own devices. Other members receive keys through the key_request → rotateKeys flow,
 * which preserves forward secrecy (they only get keys from the epoch they first join).
 */
export async function enableEncryption(channelId: string): Promise<boolean> {
  const privKey = getPrivateKey()
  if (!privKey) return false
  const myDeviceId = getDeviceId()
  if (!myDeviceId) return false

  try {
    const channelKey = await crypto.generateChannelKey()
    const channelKeyB64 = await crypto.exportKey(channelKey)

    const epoch = 0
    e2eLog(`🔐 Enabling encryption: channel=${channelId.slice(0,8)}… epoch=${epoch}`)

    // Only distribute to our own devices — other users get keys via key rotation
    const devices = await api.getChannelDevices(channelId)
    const myDevice = devices.find(d => d.id === myDeviceId)
    const myUserId = myDevice?.user_id
    if (!myUserId) return false

    const myDevices = devices.filter(d => d.user_id === myUserId && d.public_key)
    e2eLog(`📤 Distributing initial key to ${myDevices.length} of my devices (out of ${devices.length} total)`)
    for (const device of myDevices) {
      const encryptedKey = await buildEncryptedKey(privKey, device.public_key, channelKeyB64)
      await api.setChannelKey(channelId, encryptedKey, device.id, epoch)
      e2eLog(`  → Encrypted key for my device ${device.id.slice(0,8)}…`)
    }

    channelKeyCache.set(cacheKey(channelId, epoch), channelKey)
    currentEpochCache.set(channelId, epoch)
    e2eLog(`✅ Encryption enabled: channel=${channelId.slice(0,8)}…`)
    return true
  } catch (e) {
    console.error('Failed to enable encryption:', e)
    return false
  }
}

/**
 * Redistribute the channel key to OTHER devices of the SAME user that are missing it.
 * This preserves forward secrecy — new users won't get old epoch keys.
 * New users must rotate to a new epoch (via rotateKeys) to participate.
 */
export async function redistributeKeys(channelId: string): Promise<void> {
  const privKey = getPrivateKey()
  if (!privKey) return
  const myDeviceId = getDeviceId()
  if (!myDeviceId) return

  const epoch = await getCurrentEpoch(channelId)
  if (epoch < 0) return

  const channelKey = await getChannelKeyForEpoch(channelId, epoch)
  if (!channelKey) return

  try {
    const keys = await api.getChannelKeys(channelId)
    const existingDeviceIds = new Set(keys.filter(k => k.epoch === epoch).map(k => k.device_id))

    const devices = await api.getChannelDevices(channelId)
    const channelKeyB64 = await crypto.exportKey(channelKey)

    // Find our user_id from the device list
    const myDevice = devices.find(d => d.id === myDeviceId)
    const myUserId = myDevice?.user_id
    if (!myUserId) return

    // Only distribute to devices belonging to the same user (multi-device support)
    const missing = devices.filter(d => d.user_id === myUserId && !existingDeviceIds.has(d.id) && d.public_key)
    if (missing.length > 0) {
      e2eLog(`🔄 Redistributing key: channel=${channelId.slice(0,8)}… epoch=${epoch} — ${missing.length} of my device(s) need keys`)
    }
    for (const device of missing) {
      const encryptedKey = await buildEncryptedKey(privKey, device.public_key, channelKeyB64)
      await api.setChannelKey(channelId, encryptedKey, device.id, epoch)
      e2eLog(`  → Redistributed to my device ${device.id.slice(0,8)}…`)
    }
  } catch (e) {
    console.error('Failed to redistribute keys:', e)
  }
}

/**
 * Sign the plaintext content of a message using the device's ECDSA signing key.
 * Returns the base64 signature, or empty string if signing is not available.
 */
async function signContent(content: string): Promise<string> {
  const signingKey = getSigningPrivateKey()
  if (!signingKey) return ''
  try {
    return await crypto.sign(signingKey, content)
  } catch {
    return ''
  }
}

/**
 * Encrypt a plaintext message. Returns the encrypted string with ENC: prefix.
 * Format: ENC:<epoch>:<nonce>:<signature>:<ciphertext>
 */
export async function encryptMessage(channelId: string, plaintext: string): Promise<{ encrypted: string; epoch: number } | null> {
  const epoch = await getCurrentEpoch(channelId)
  if (epoch < 0) return null
  const key = await getChannelKeyForEpoch(channelId, epoch)
  if (!key) return null
  const signature = await signContent(plaintext)
  const { ciphertext, nonce } = await crypto.encrypt(key, plaintext)
  const encrypted = `${ENC_PREFIX}${epoch}:${nonce}:${signature}:${ciphertext}`
  e2eLog(`🔒 Encrypt: channel=${channelId.slice(0,8)}… epoch=${epoch} plainLen=${plaintext.length} → cipherLen=${encrypted.length}`)
  e2eLog(`   Raw output: ${encrypted.slice(0, 80)}${encrypted.length > 80 ? '…' : ''}`)
  return { encrypted, epoch }
}

/**
 * Decrypt a message if it's encrypted. Returns plaintext.
 * If the message isn't encrypted, returns it as-is.
 * Uses the key_epoch from the message to know which key to use.
 */
export async function decryptMessage(channelId: string, content: string, keyEpoch?: number): Promise<string> {
  if (!content.startsWith(ENC_PREFIX)) return content
  e2eLog(`🔓 Decrypt: channel=${channelId.slice(0,8)}… raw=${content.slice(0, 60)}${content.length > 60 ? '…' : ''}`)
  try {
    const payload = content.slice(ENC_PREFIX.length)
    // Format: <epoch>:<nonce>:<signature>:<ciphertext>
    const parts = payload.split(':')
    if (parts.length < 4) {
      // Legacy format: <nonce>:<ciphertext> — use keyEpoch from message or 0
      if (parts.length === 2) {
        const epoch = keyEpoch ?? 0
        e2eLog(`   Legacy format, epoch=${epoch}`)
        const key = await getChannelKeyForEpoch(channelId, epoch)
        if (!key) { e2eWarn('   ✗ Missing key'); return '[encrypted — missing key]' }
        const plain = await crypto.decrypt(key, parts[1]!, parts[0]!)
        e2eLog(`   ✓ Decrypted (${plain.length} chars)`)
        return plain
      }
      e2eWarn('   ✗ Invalid format')
      return '[encrypted — invalid format]'
    }
    const epoch = parseInt(parts[0]!, 10)
    const nonce = parts[1]!
    // parts[2] is signature (verified separately if needed)
    const ciphertext = parts[3]!
    const resolvedEpoch = isNaN(epoch) ? (keyEpoch ?? 0) : epoch
    e2eLog(`   Parsed: epoch=${resolvedEpoch} nonceLen=${nonce.length} ctLen=${ciphertext.length}`)
    const key = await getChannelKeyForEpoch(channelId, resolvedEpoch)
    if (!key) { e2eWarn(`   ✗ Missing key for epoch ${resolvedEpoch}`); return '[encrypted — missing key]' }
    const plain = await crypto.decrypt(key, ciphertext, nonce)
    e2eLog(`   ✓ Decrypted (${plain.length} chars)`)
    return plain
  } catch (err) {
    e2eWarn('   ✗ Decryption failed:', err)
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
 * Clear all cached channel keys for a channel.
 */
export function clearChannelKey(channelId: string) {
  let cleared = 0
  for (const key of channelKeyCache.keys()) {
    if (key.startsWith(channelId + ':')) {
      channelKeyCache.delete(key)
      cleared++
    }
  }
  currentEpochCache.delete(channelId)
  e2eLog(`🗑 Cleared ${cleared} cached key(s) for channel ${channelId.slice(0,8)}…`)
}

/**
 * Rotate the channel key: generate a new key at epoch N+1 and distribute it
 * to all current member devices. Old messages remain encrypted under old epochs.
 * Departed members lose access to new messages; new members can only read from
 * the epoch they received the key for.
 */
export async function rotateKeys(channelId: string): Promise<boolean> {
  const privKey = getPrivateKey()
  if (!privKey) return false

  try {
    const oldEpoch = await getCurrentEpoch(channelId)
    const newEpoch = oldEpoch + 1

    e2eLog(`🔄 Rotating key: channel=${channelId.slice(0,8)}… epoch ${oldEpoch} → ${newEpoch}`)
    const newChannelKey = await crypto.generateChannelKey()
    const newChannelKeyB64 = await crypto.exportKey(newChannelKey)

    await distributeKeyToDevices(channelId, newEpoch, newChannelKeyB64)

    channelKeyCache.set(cacheKey(channelId, newEpoch), newChannelKey)
    currentEpochCache.set(channelId, newEpoch)
    e2eLog(`✅ Key rotated: channel=${channelId.slice(0,8)}… now at epoch ${newEpoch}`)
    return true
  } catch (e) {
    console.error('Failed to rotate channel keys:', e)
    return false
  }
}
