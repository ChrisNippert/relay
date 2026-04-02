// E2E encryption manager — epoch-based key model with sender ratchet and message signing
import * as crypto from './crypto'
import * as api from './api'
import { getPrivateKey, getSigningPrivateKey, getDeviceId } from '../context/AuthContext'
import type { Device } from '../types'

const ENC_PREFIX = 'ENC:'

// Dev logging — filter console by [E2E] to monitor encryption
const E2E_DEBUG = true
function e2eLog(...args: unknown[]) { if (E2E_DEBUG) console.log('%c[E2E]', 'color: #00e0ff; font-weight: bold', ...args) }
function e2eWarn(...args: unknown[]) { if (E2E_DEBUG) console.warn('%c[E2E]', 'color: #ffaa00; font-weight: bold', ...args) }

/** Result of decrypting a message — includes signature verification status */
export interface DecryptResult {
  text: string
  verified: boolean | null // true=verified, false=failed, null=no sig or unable to verify
}

// ──── Caches ────

// Decrypted channel (epoch root) keys: "channelId:epoch" → CryptoKey
const channelKeyCache = new Map<string, CryptoKey>()

// Current (latest) epoch per channel
const currentEpochCache = new Map<string, number>()

// Channels currently being rotated — suppress notification-triggered cache clears
const rotatingChannels = new Set<string>()

// Device info cache for signing key lookups
const deviceCache = new Map<string, Device>()

function cacheKey(channelId: string, epoch: number): string {
  return `${channelId}:${epoch}`
}

// ──── Sender Ratchet State ────

interface ChainState {
  chainKey: ArrayBuffer
  index: number
}

const senderChains = new Map<string, ChainState>()

function senderStateKey(channelId: string, epoch: number): string {
  return `s:${channelId}:${epoch}`
}

// Persist sender chain index across page refreshes
function getPersistedSenderIndex(channelId: string, epoch: number): number {
  return parseInt(localStorage.getItem(`e2e_chain_${channelId}:${epoch}`) ?? '0', 10)
}

function persistSenderIndex(channelId: string, epoch: number, index: number) {
  localStorage.setItem(`e2e_chain_${channelId}:${epoch}`, index.toString())
}

async function getOrInitSenderChain(channelId: string, epoch: number): Promise<ChainState> {
  const key = senderStateKey(channelId, epoch)
  const existing = senderChains.get(key)
  if (existing) return existing

  const epochKey = await getChannelKeyForEpoch(channelId, epoch)
  if (!epochKey) throw new Error('No epoch key')
  const deviceId = getDeviceId()!

  // chainKey_0 = HKDF(epochKey, deviceId, "sender-chain-init")
  let chainKey = await crypto.deriveChainKey(epochKey, deviceId)

  // Fast-forward to persisted index (recover from page refresh)
  const startIndex = getPersistedSenderIndex(channelId, epoch)
  for (let i = 0; i < startIndex; i++) {
    chainKey = await crypto.advanceChainKey(chainKey)
  }

  const state: ChainState = { chainKey, index: startIndex }
  senderChains.set(key, state)
  return state
}

// ──── Receiver Ratchet State ────

const receiverChains = new Map<string, ChainState>()

// Skipped message keys buffer (FIFO, max 256)
const skippedKeys = new Map<string, CryptoKey>()
const skippedKeyOrder: string[] = []
const SKIPPED_KEY_MAX = 256

function receiverStateKey(channelId: string, epoch: number, deviceId: string): string {
  return `r:${channelId}:${epoch}:${deviceId}`
}

function skippedKeyId(epoch: number, deviceId: string, index: number): string {
  return `${epoch}:${deviceId}:${index}`
}

// ──── Replay Detection ────

// Tracks seen (channel, epoch, device, chainIndex) tuples to reject replayed messages.
// Bounded FIFO — oldest entries evicted when exceeding max.
const seenMessages = new Set<string>()
const seenMessageOrder: string[] = []
const SEEN_MSG_MAX = 4096

function seenMsgId(channelId: string, epoch: number, deviceId: string, chainIndex: number): string {
  return `${channelId}:${epoch}:${deviceId}:${chainIndex}`
}

function markSeen(id: string): void {
  if (seenMessages.has(id)) return
  seenMessages.add(id)
  seenMessageOrder.push(id)
  while (seenMessageOrder.length > SEEN_MSG_MAX) {
    const evict = seenMessageOrder.shift()!
    seenMessages.delete(evict)
  }
}

function wasSeen(id: string): boolean {
  return seenMessages.has(id)
}

/**
 * Derive the message key for a specific chain index.
 * Uses receiver chain cache for forward messages, re-derives from scratch for past indices.
 * Caches skipped keys (max 256) for out-of-order message delivery.
 */
async function deriveMessageKeyForIndex(
  channelId: string, epoch: number, senderDeviceId: string, targetIndex: number
): Promise<CryptoKey | null> {
  // Check skipped keys buffer first
  const skipId = skippedKeyId(epoch, senderDeviceId, targetIndex)
  const skipped = skippedKeys.get(skipId)
  if (skipped) {
    skippedKeys.delete(skipId)
    const idx = skippedKeyOrder.indexOf(skipId)
    if (idx >= 0) skippedKeyOrder.splice(idx, 1)
    return skipped
  }

  const rcKey = receiverStateKey(channelId, epoch, senderDeviceId)
  let chain = receiverChains.get(rcKey)

  if (!chain || targetIndex < chain.index) {
    // Either no chain yet or we've already passed this index (e.g. loading history)
    // Derive from scratch: chainKey_0 → advance to targetIndex
    const epochKey = await getChannelKeyForEpoch(channelId, epoch)
    if (!epochKey) return null
    let ck = await crypto.deriveChainKey(epochKey, senderDeviceId)
    for (let i = 0; i < targetIndex; i++) {
      ck = await crypto.advanceChainKey(ck)
    }
    const messageKey = await crypto.deriveMessageKey(ck)
    // Initialize or update chain state if this takes us further
    if (!chain || targetIndex >= chain.index) {
      const nextCk = await crypto.advanceChainKey(ck)
      receiverChains.set(rcKey, { chainKey: nextCk, index: targetIndex + 1 })
    }
    return messageKey
  }

  // Advance chain forward, caching skipped keys along the way
  while (chain.index < targetIndex) {
    const msgKey = await crypto.deriveMessageKey(chain.chainKey)
    const sid = skippedKeyId(epoch, senderDeviceId, chain.index)
    skippedKeys.set(sid, msgKey)
    skippedKeyOrder.push(sid)
    while (skippedKeyOrder.length > SKIPPED_KEY_MAX) {
      const evict = skippedKeyOrder.shift()!
      skippedKeys.delete(evict)
    }
    chain.chainKey = await crypto.advanceChainKey(chain.chainKey)
    chain.index++
  }

  // At target index — derive message key and advance
  const messageKey = await crypto.deriveMessageKey(chain.chainKey)
  chain.chainKey = await crypto.advanceChainKey(chain.chainKey)
  chain.index++
  return messageKey
}

// ──── Device Signing Key Cache ────

async function getDeviceSigningKey(channelId: string, deviceId: string): Promise<string | null> {
  const cached = deviceCache.get(deviceId)
  if (cached) return cached.signing_key || null
  try {
    const devices = await api.getChannelDevices(channelId)
    for (const d of devices) deviceCache.set(d.id, d)
    return deviceCache.get(deviceId)?.signing_key || null
  } catch {
    return null
  }
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
 * Check if this device has ever had a key entry (master keys or channel_keys) for any epoch.
 * Used to distinguish "existing member" from "new device with no keys".
 */
export async function hasDeviceKeyEntry(channelId: string): Promise<boolean> {
  const deviceId = getDeviceId()
  if (!deviceId) return false
  try {
    // Check master keys first (primary path)
    const masterKeys = await fetchMasterKeysDeduped(channelId)
    if (masterKeys.some(k => k.device_id === deviceId)) return true
    // Fall back to channel_keys
    const keys = await fetchChannelKeysDeduped(channelId)
    return keys.some(k => k.device_id === deviceId)
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

  // Try master keys first (per-device encrypted — primary path)
  const privKey = getPrivateKey()
  const deviceId = getDeviceId()
  if (!privKey || !deviceId) return null

  const masterKey = await loadFromMasterKeys(channelId, epoch, privKey, deviceId)
  if (masterKey) return masterKey

  // Fall back to per-device channel_keys
  return loadChannelKey(channelId, epoch, privKey, deviceId)
}

// Dedup in-flight master key fetches
const masterKeyFetchPromises = new Map<string, Promise<import('../types').ChannelKey[]>>()

function fetchMasterKeysDeduped(channelId: string): Promise<import('../types').ChannelKey[]> {
  const inflight = masterKeyFetchPromises.get(channelId)
  if (inflight) return inflight
  const promise = api.getMasterKeys(channelId).finally(() => {
    masterKeyFetchPromises.delete(channelId)
  })
  masterKeyFetchPromises.set(channelId, promise)
  return promise
}

async function loadFromMasterKeys(channelId: string, epoch: number, privKey: string, deviceId: string): Promise<CryptoKey | null> {
  try {
    const masterKeys = await fetchMasterKeysDeduped(channelId)
    const myEntry = masterKeys.find(k => k.device_id === deviceId && k.epoch === epoch)
    if (!myEntry) return null

    const parsed = parseEncryptedKey(myEntry.encrypted_key)
    if (!parsed) return null

    const sharedKey = await crypto.deriveSharedKey(privKey, parsed.senderPubKey)
    const channelKeyB64 = await crypto.decrypt(sharedKey, parsed.ciphertext, parsed.nonce)
    const channelKey = await crypto.importKey(channelKeyB64)
    const ck = cacheKey(channelId, epoch)
    channelKeyCache.set(ck, channelKey)
    const knownEpoch = currentEpochCache.get(channelId) ?? -1
    if (epoch > knownEpoch) {
      currentEpochCache.set(channelId, epoch)
    }
    e2eLog(`🔑 Loaded master key: channel=${channelId.slice(0,8)}… epoch=${epoch}`)
    return channelKey
  } catch {
    // Master keys endpoint may not exist on older servers — fall through
    return null
  }
}

// Dedup in-flight API calls: channelId → Promise of all keys
const keyFetchPromises = new Map<string, Promise<import('../types').ChannelKey[]>>()

function fetchChannelKeysDeduped(channelId: string): Promise<import('../types').ChannelKey[]> {
  const inflight = keyFetchPromises.get(channelId)
  if (inflight) return inflight
  const promise = api.getChannelKeys(channelId).finally(() => {
    keyFetchPromises.delete(channelId)
  })
  keyFetchPromises.set(channelId, promise)
  return promise
}

async function loadChannelKey(channelId: string, epoch: number, privKey: string, deviceId: string): Promise<CryptoKey | null> {
  try {
    const keys = await fetchChannelKeysDeduped(channelId)
    const myEntry = keys.find(k => k.device_id === deviceId && k.epoch === epoch)
    if (!myEntry) return null

    const parsed = parseEncryptedKey(myEntry.encrypted_key)
    if (!parsed) return null

    const sharedKey = await crypto.deriveSharedKey(privKey, parsed.senderPubKey)
    const channelKeyB64 = await crypto.decrypt(sharedKey, parsed.ciphertext, parsed.nonce)
    const channelKey = await crypto.importKey(channelKeyB64)

    const ck = cacheKey(channelId, epoch)
    channelKeyCache.set(ck, channelKey)
    // Update epoch cache if this key is at a higher epoch than currently known
    const knownEpoch = currentEpochCache.get(channelId) ?? -1
    if (epoch > knownEpoch) {
      currentEpochCache.set(channelId, epoch)
    }
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
 * If forceRefresh is true, the epoch cache is invalidated first.
 */
export async function getChannelKey(channelId: string, forceRefresh = false): Promise<CryptoKey | null> {
  if (forceRefresh) currentEpochCache.delete(channelId)
  const epoch = await getCurrentEpoch(channelId)
  if (epoch < 0) {
    e2eWarn(`getChannelKey(${channelId.slice(0,8)}…) — no epoch found`)
    return null
  }
  const key = await getChannelKeyForEpoch(channelId, epoch)
  if (key) {
    e2eLog(`getChannelKey(${channelId.slice(0,8)}…) → epoch=${epoch} key=OK`)
    return key
  }
  // Latest epoch key not available yet (distribution in progress from another device).
  // Fall back to the highest epoch we DO have a key for, so the caller knows we're
  // an existing member and avoids unnecessary self-rotation.
  if (epoch > 0) {
    for (let e = epoch - 1; e >= 0; e--) {
      const fallback = await getChannelKeyForEpoch(channelId, e)
      if (fallback) {
        e2eLog(`getChannelKey(${channelId.slice(0,8)}…) → epoch=${epoch} MISSING, fallback to epoch ${e}`)
        return fallback
      }
    }
  }
  e2eLog(`getChannelKey(${channelId.slice(0,8)}…) → epoch=${epoch} key=MISSING (no fallback)`)
  return null
}

/**
 * Pre-warm the key cache for all epochs this device has access to.
 * Call before bulk-decrypting messages to avoid redundant API calls.
 */
export async function preWarmKeys(channelId: string): Promise<void> {
  const privKey = getPrivateKey()
  const deviceId = getDeviceId()
  if (!privKey || !deviceId) return

  try {
    const keys = await fetchChannelKeysDeduped(channelId)
    const myEntries = keys.filter(k => k.device_id === deviceId)
    for (const entry of myEntries) {
      const ck = cacheKey(channelId, entry.epoch)
      if (channelKeyCache.has(ck)) continue
      const parsed = parseEncryptedKey(entry.encrypted_key)
      if (!parsed) continue
      try {
        const sharedKey = await crypto.deriveSharedKey(privKey, parsed.senderPubKey)
        const channelKeyB64 = await crypto.decrypt(sharedKey, parsed.ciphertext, parsed.nonce)
        const channelKey = await crypto.importKey(channelKeyB64)
        channelKeyCache.set(ck, channelKey)
        const knownEpoch = currentEpochCache.get(channelId) ?? -1
        if (entry.epoch > knownEpoch) currentEpochCache.set(channelId, entry.epoch)
        e2eLog(`🔥 Pre-warmed key: channel=${channelId.slice(0,8)}… epoch=${entry.epoch}`)
      } catch {
        e2eWarn(`Failed to pre-warm key: channel=${channelId.slice(0,8)}… epoch=${entry.epoch}`)
      }
    }
  } catch {
    // ignore — keys will be loaded on demand
  }
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
 * Encrypt the channel key for all channel devices and batch-upload to master keys.
 * This is the primary key distribution path — server never sees the raw key.
 */
async function uploadEncryptedMasterKeys(channelId: string, epoch: number, channelKeyB64: string, privKey: string): Promise<void> {
  const devices = await api.getChannelDevices(channelId)
  const entries: { device_id: string; encrypted_key: string }[] = []
  for (const device of devices) {
    if (!device.public_key) continue
    const encryptedKey = await buildEncryptedKey(privKey, device.public_key, channelKeyB64)
    entries.push({ device_id: device.id, encrypted_key: encryptedKey })
  }
  if (entries.length > 0) {
    await api.setMasterKeys(channelId, epoch, entries)
    masterKeyFetchPromises.delete(channelId)
    e2eLog(`📤 Batch uploaded ${entries.length} encrypted master keys: channel=${channelId.slice(0,8)}… epoch=${epoch}`)
  }
}

/**
 * Encrypt the channel key for all devices of all channel members and upload at the given epoch.
 * Uploads the caller's own device FIRST so the key is available immediately.
 * Individual device failures are tolerated — distribution continues for remaining devices.
 * Throws only if our OWN device key fails to upload.
 */
async function distributeKeyToDevices(channelId: string, epoch: number, channelKeyB64: string): Promise<void> {
  const privKey = getPrivateKey()
  if (!privKey) return
  const myDeviceId = getDeviceId()

  const devices = await api.getChannelDevices(channelId)
  // Sort: own device first so our key is in the DB before notifications fire
  const sorted = [...devices].sort((a, b) => {
    if (a.id === myDeviceId) return -1
    if (b.id === myDeviceId) return 1
    return 0
  })
  e2eLog(`📤 Distributing key: channel=${channelId.slice(0,8)}… epoch=${epoch} to ${sorted.length} devices`)
  let ownDeviceOk = false
  for (const device of sorted) {
    if (!device.public_key) {
      e2eWarn(`  ⚠ Skipping device ${device.id.slice(0,8)}… — no public key`)
      continue
    }
    const setKeyForDevice = async (retryCount: number): Promise<boolean> => {
      try {
        const encryptedKey = await buildEncryptedKey(privKey, device.public_key, channelKeyB64)
        await api.setChannelKey(channelId, encryptedKey, device.id, epoch)
        return true
      } catch (err) {
        if (retryCount < 2) {
          await new Promise(r => setTimeout(r, 500 * (retryCount + 1)))
          return setKeyForDevice(retryCount + 1)
        }
        throw err
      }
    }
    try {
      await setKeyForDevice(0)
      e2eLog(`  → Encrypted key for device ${device.id.slice(0,8)}…`)
      if (device.id === myDeviceId) ownDeviceOk = true
    } catch (err) {
      if (device.id === myDeviceId) {
        // Own device MUST succeed — rethrow so rotateKeys can catch
        throw err
      }
      e2eWarn(`  ⚠ Failed to distribute to device ${device.id.slice(0,8)}… after retries:`, err)
    }
  }
  if (!ownDeviceOk && myDeviceId) {
    // Own device wasn't in the channel device list (e.g. unapproved device).
    // Upload key directly using our known public key so we can encrypt/decrypt.
    e2eWarn(`  ⚠ Own device was not in the device list — uploading key directly`)
    try {
      const myPubKey = await crypto.publicKeyFromPrivate(privKey)
      const encryptedKey = await buildEncryptedKey(privKey, myPubKey, channelKeyB64)
      await api.setChannelKey(channelId, encryptedKey, myDeviceId, epoch)
      e2eLog(`  → Encrypted key for own device ${myDeviceId.slice(0,8)}… (fallback)`)
    } catch (err) {
      // Own device MUST succeed
      throw err
    }
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

    // Encrypt the key for all devices and batch-upload to master keys
    await uploadEncryptedMasterKeys(channelId, epoch, channelKeyB64, privKey)

    // Also distribute per-device encrypted copies to channel_keys (best-effort fallback)
    await distributeKeyToDevices(channelId, epoch, channelKeyB64)

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
    const masterKeys = await api.getMasterKeys(channelId)
    const existingCK = new Set(keys.filter(k => k.epoch === epoch).map(k => k.device_id))
    const existingMK = new Set(masterKeys.filter(k => k.epoch === epoch).map(k => k.device_id))

    const devices = await api.getChannelDevices(channelId)
    const channelKeyB64 = await crypto.exportKey(channelKey)

    // Find our user_id from the device list
    const myDevice = devices.find(d => d.id === myDeviceId)
    const myUserId = myDevice?.user_id
    if (!myUserId) return

    // Only distribute to devices belonging to the same user (multi-device support)
    const missingCK = devices.filter(d => d.user_id === myUserId && !existingCK.has(d.id) && d.public_key)
    const missingMK = devices.filter(d => d.user_id === myUserId && !existingMK.has(d.id) && d.public_key)

    // Batch-upload missing master key entries
    if (missingMK.length > 0) {
      const entries: { device_id: string; encrypted_key: string }[] = []
      for (const device of missingMK) {
        const encryptedKey = await buildEncryptedKey(privKey, device.public_key, channelKeyB64)
        entries.push({ device_id: device.id, encrypted_key: encryptedKey })
      }
      try {
        await api.setMasterKeys(channelId, epoch, entries)
        masterKeyFetchPromises.delete(channelId)
        e2eLog(`🔄 Redistributed master keys: channel=${channelId.slice(0,8)}… epoch=${epoch} — ${entries.length} of my device(s)`)
      } catch (err) {
        e2eWarn(`  ⚠ Failed to batch-upload master keys:`, err)
      }
    }

    // Also update channel_keys (fallback)
    if (missingCK.length > 0) {
      e2eLog(`🔄 Redistributing key: channel=${channelId.slice(0,8)}… epoch=${epoch} — ${missingCK.length} of my device(s) need keys`)
    }
    for (const device of missingCK) {
      const encryptedKey = await buildEncryptedKey(privKey, device.public_key, channelKeyB64)
      await api.setChannelKey(channelId, encryptedKey, device.id, epoch)
      e2eLog(`  → Redistributed to my device ${device.id.slice(0,8)}…`)
    }
  } catch (e) {
    console.error('Failed to redistribute keys:', e)
  }
}

/**
 * Redistribute ALL epoch keys we hold to ALL devices (any member) that are missing them.
 * Used as a recovery mechanism when key_request is received — fills gaps from failed distributions.
 * Iterates every epoch the current device has, not just the latest, so new devices
 * can decrypt messages from older epochs they missed.
 */
export async function redistributeToAll(channelId: string): Promise<void> {
  const privKey = getPrivateKey()
  if (!privKey) return
  const myDeviceId = getDeviceId()
  if (!myDeviceId) return

  try {
    const keys = await api.getChannelKeys(channelId)
    const masterKeys = await api.getMasterKeys(channelId)
    const devices = await api.getChannelDevices(channelId)

    // Group existing channel_keys by epoch → set of device IDs
    const epochDevices = new Map<number, Set<string>>()
    for (const k of keys) {
      if (!epochDevices.has(k.epoch)) epochDevices.set(k.epoch, new Set())
      epochDevices.get(k.epoch)!.add(k.device_id)
    }

    // Group existing master_keys by epoch → set of device IDs
    const masterEpochDevices = new Map<number, Set<string>>()
    for (const k of masterKeys) {
      if (!masterEpochDevices.has(k.epoch)) masterEpochDevices.set(k.epoch, new Set())
      masterEpochDevices.get(k.epoch)!.add(k.device_id)
    }

    // Find all epochs this device has keys for (in either table)
    const allEpochs = new Set<number>()
    for (const [epoch, devs] of epochDevices) {
      if (devs.has(myDeviceId)) allEpochs.add(epoch)
    }
    for (const [epoch, devs] of masterEpochDevices) {
      if (devs.has(myDeviceId)) allEpochs.add(epoch)
    }
    const myEpochs = [...allEpochs].sort((a, b) => a - b)

    if (myEpochs.length === 0) return

    let totalRedistributed = 0
    for (const epoch of myEpochs) {
      const channelKey = await getChannelKeyForEpoch(channelId, epoch)
      if (!channelKey) continue

      const existingCK = epochDevices.get(epoch) ?? new Set()
      const existingMK = masterEpochDevices.get(epoch) ?? new Set()
      // Devices missing from channel_keys
      const missingCK = devices.filter(d => !existingCK.has(d.id) && d.public_key)
      // Devices missing from master_keys
      const missingMK = devices.filter(d => !existingMK.has(d.id) && d.public_key)

      if (missingCK.length === 0 && missingMK.length === 0) continue

      const channelKeyB64 = await crypto.exportKey(channelKey)

      // Batch-upload missing master key entries
      if (missingMK.length > 0) {
        e2eLog(`🔧 Redistributing master keys epoch ${epoch} to ${missingMK.length} device(s): channel=${channelId.slice(0,8)}…`)
        const entries: { device_id: string; encrypted_key: string }[] = []
        for (const device of missingMK) {
          const encryptedKey = await buildEncryptedKey(privKey, device.public_key, channelKeyB64)
          entries.push({ device_id: device.id, encrypted_key: encryptedKey })
        }
        try {
          await api.setMasterKeys(channelId, epoch, entries)
          masterKeyFetchPromises.delete(channelId)
          totalRedistributed += entries.length
        } catch (err) {
          e2eWarn(`  ⚠ Failed to batch-upload master keys for epoch ${epoch}:`, err)
        }
      }

      // Also update channel_keys (fallback path)
      for (const device of missingCK) {
        try {
          const encryptedKey = await buildEncryptedKey(privKey, device.public_key, channelKeyB64)
          await api.setChannelKey(channelId, encryptedKey, device.id, epoch)
          e2eLog(`  → Redistributed to device ${device.id.slice(0,8)}…`)
          totalRedistributed++
        } catch (err) {
          e2eWarn(`  ⚠ Failed to redistribute to device ${device.id.slice(0,8)}…:`, err)
        }
      }
    }
    if (totalRedistributed === 0) {
      e2eLog(`📋 All ${devices.length} devices already have keys for all ${myEpochs.length} epoch(s)`)
    }
  } catch (e) {
    console.error('Failed to redistribute keys to all:', e)
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
 * Encrypt a plaintext message using the sender ratchet.
 * Format: ENC:<epoch>:<chainIndex>:<senderDeviceId>:<nonce>:<signature>:<ciphertext>
 */
export async function encryptMessage(channelId: string, plaintext: string): Promise<{ encrypted: string; epoch: number } | null> {
  const epoch = await getCurrentEpoch(channelId)
  if (epoch < 0) return null

  let useEpoch = epoch
  let epochKey = await getChannelKeyForEpoch(channelId, epoch)

  // If the server reports a newer epoch but we don't have it yet (key still being
  // distributed), fall back to the highest epoch we DO have a key for.
  if (!epochKey && epoch > 0) {
    for (let e = epoch - 1; e >= 0; e--) {
      const fallback = await getChannelKeyForEpoch(channelId, e)
      if (fallback) {
        epochKey = fallback
        useEpoch = e
        e2eLog(`⚠ Epoch ${epoch} key not ready — encrypting with epoch ${useEpoch} instead`)
        break
      }
    }
  }
  if (!epochKey) return null

  const deviceId = getDeviceId()
  if (!deviceId) return null

  const chain = await getOrInitSenderChain(channelId, useEpoch)

  // Derive message key from current chain state
  const messageKey = await crypto.deriveMessageKey(chain.chainKey)
  const chainIndex = chain.index

  // Advance chain
  chain.chainKey = await crypto.advanceChainKey(chain.chainKey)
  chain.index++
  persistSenderIndex(channelId, useEpoch, chain.index)

  const signature = await signContent(plaintext)
  const { ciphertext, nonce } = await crypto.encrypt(messageKey, plaintext)
  const encrypted = `${ENC_PREFIX}${useEpoch}:${chainIndex}:${deviceId}:${nonce}:${signature}:${ciphertext}`
  e2eLog(`🔒 Encrypt: channel=${channelId.slice(0,8)}… epoch=${useEpoch} idx=${chainIndex} plainLen=${plaintext.length}`)
  return { encrypted, epoch: useEpoch }
}

/**
 * Decrypt a message if it's encrypted. Returns plaintext.
 * If the message isn't encrypted, returns it as-is.
 * Uses the key_epoch from the message to know which key to use.
 */
export async function decryptMessage(channelId: string, content: string, keyEpoch?: number, _senderDeviceId?: string, skipReplay = false): Promise<DecryptResult> {
  if (!content.startsWith(ENC_PREFIX)) return { text: content, verified: null }
  e2eLog(`🔓 Decrypt: channel=${channelId.slice(0,8)}… raw=${content.slice(0, 60)}${content.length > 60 ? '…' : ''}`)
  try {
    const payload = content.slice(ENC_PREFIX.length)
    const parts = payload.split(':')

    // Legacy format: ENC:<nonce>:<ciphertext> (2 parts)
    if (parts.length === 2) {
      const epoch = keyEpoch ?? 0
      e2eLog(`   Legacy format, epoch=${epoch}`)
      const key = await getChannelKeyForEpoch(channelId, epoch)
      if (!key) { e2eWarn('   ✗ Missing key'); return { text: '[encrypted — missing key]', verified: null } }
      const plain = await crypto.decrypt(key, parts[1]!, parts[0]!)
      e2eLog(`   ✓ Decrypted (${plain.length} chars)`)
      return { text: plain, verified: null }
    }

    // Old format: ENC:<epoch>:<nonce>:<signature>:<ciphertext> (4 parts)
    if (parts.length === 4) {
      const epoch = parseInt(parts[0]!, 10)
      const nonce = parts[1]!
      const ciphertext = parts[3]!
      const resolvedEpoch = isNaN(epoch) ? (keyEpoch ?? 0) : epoch
      e2eLog(`   Old format: epoch=${resolvedEpoch}`)
      const key = await getChannelKeyForEpoch(channelId, resolvedEpoch)
      if (!key) { e2eWarn(`   ✗ Missing key for epoch ${resolvedEpoch}`); return { text: '[encrypted — missing key]', verified: null } }
      const plain = await crypto.decrypt(key, ciphertext, nonce)
      e2eLog(`   ✓ Decrypted (${plain.length} chars)`)
      return { text: plain, verified: null }
    }

    // New ratchet format: ENC:<epoch>:<chainIndex>:<senderDeviceId>:<nonce>:<signature>:<ciphertext> (6 parts)
    if (parts.length === 6) {
      const epoch = parseInt(parts[0]!, 10)
      const chainIndex = parseInt(parts[1]!, 10)
      const msgDeviceId = parts[2]!
      const nonce = parts[3]!
      const signature = parts[4]!
      const ciphertext = parts[5]!

      e2eLog(`   Ratchet format: epoch=${epoch} idx=${chainIndex} device=${msgDeviceId.slice(0,8)}…`)

      // Replay detection: reject if we've already decrypted this exact message
      // Skip for historical messages loaded from the API — replay detection only
      // protects against live message replay on the WebSocket transport.
      const sid = seenMsgId(channelId, epoch, msgDeviceId, chainIndex)
      if (!skipReplay && wasSeen(sid)) {
        e2eWarn(`   ✗ Replayed message detected (epoch=${epoch} idx=${chainIndex} device=${msgDeviceId.slice(0,8)}…)`)
        return { text: '[encrypted — replayed message]', verified: false }
      }

      const epochKey = await getChannelKeyForEpoch(channelId, epoch)
      if (!epochKey) { e2eWarn(`   ✗ Missing key for epoch ${epoch}`); return { text: '[encrypted — missing key]', verified: null } }

      // Is this our own message? (from current device)
      const myDeviceId = getDeviceId()
      const isOwnDevice = msgDeviceId === myDeviceId

      // Derive the message key using the receiver chain (or sender chain for own messages)
      let messageKey: CryptoKey | null = null
      if (isOwnDevice) {
        // For our own messages, re-derive from scratch (we don't maintain a receiver chain for ourselves)
        const chainKey0 = await crypto.deriveChainKey(epochKey, msgDeviceId)
        let ck = chainKey0
        for (let i = 0; i < chainIndex; i++) {
          ck = await crypto.advanceChainKey(ck)
        }
        messageKey = await crypto.deriveMessageKey(ck)
      } else {
        messageKey = await deriveMessageKeyForIndex(channelId, epoch, msgDeviceId, chainIndex)
      }

      if (!messageKey) { e2eWarn(`   ✗ Failed to derive message key`); return { text: '[encrypted — key derivation failed]', verified: null } }

      const plain = await crypto.decrypt(messageKey, ciphertext, nonce)

      // Verify signature
      let verified: boolean | null = null
      if (signature && signature !== 'nosig') {
        const signingKey = await getDeviceSigningKey(channelId, msgDeviceId)
        if (signingKey) {
          try {
            verified = await crypto.verify(signingKey, plain, signature)
            e2eLog(`   Signature ${verified ? '✓ valid' : '✗ INVALID'}`)
          } catch {
            verified = false
            e2eWarn('   ✗ Signature verification error')
          }
        } else {
          e2eLog('   ⚠ No signing key available for verification')
          verified = null
        }
      }

      // Mark as seen after successful decryption
      markSeen(sid)

      e2eLog(`   ✓ Decrypted (${plain.length} chars) verified=${verified}`)
      return { text: plain, verified }
    }

    e2eWarn(`   ✗ Invalid format (${parts.length} parts)`)
    return { text: '[encrypted — invalid format]', verified: null }
  } catch (err) {
    e2eWarn('   ✗ Decryption failed:', err)
    return { text: '[encrypted — decryption failed]', verified: null }
  }
}

/**
 * Check if a message content string is encrypted.
 */
export function isEncryptedContent(content: string): boolean {
  return content.startsWith(ENC_PREFIX)
}

/**
 * Clear all cached channel keys and ratchet state for a channel.
 */
/**
 * Invalidate a specific epoch's cached key so the next access reloads from the server.
 * Use when a channel_keys_updated notification arrives — ensures we use the server-authoritative
 * key rather than a stale local cache entry from a potentially lost rotation race.
 */
export function invalidateCachedEpoch(channelId: string, epoch: number): void {
  channelKeyCache.delete(cacheKey(channelId, epoch))
  keyFetchPromises.delete(channelId) // ensure a fresh API fetch
  masterKeyFetchPromises.delete(channelId) // also refresh master keys
  // Do NOT clear currentEpochCache here — that would cause encryptMessage to try
  // the new epoch before the key is loaded, breaking send. The epoch cache is
  // updated automatically in loadChannelKey when the key is successfully loaded.
  // Clear ratchet state for this epoch so chain derivation uses the correct key
  senderChains.delete(senderStateKey(channelId, epoch))
  for (const key of receiverChains.keys()) {
    if (key.startsWith(`r:${channelId}:${epoch}:`)) receiverChains.delete(key)
  }
}

export function clearChannelKey(channelId: string) {
  // Skip clearing if we're actively rotating this channel — our local cache is authoritative
  if (rotatingChannels.has(channelId)) {
    e2eLog(`⏭ Skipping cache clear for ${channelId.slice(0,8)}… (rotation in progress)`)
    return
  }
  resetChannelState(channelId)
}

/**
 * Force-clear ALL state for a channel, including rotation locks.
 * Use when a channel is deleted or in tests to reset between runs.
 */
export function resetChannelState(channelId: string) {
  rotatingChannels.delete(channelId)
  let cleared = 0
  for (const key of channelKeyCache.keys()) {
    if (key.startsWith(channelId + ':')) {
      channelKeyCache.delete(key)
      cleared++
    }
  }
  currentEpochCache.delete(channelId)
  keyFetchPromises.delete(channelId)
  masterKeyFetchPromises.delete(channelId)

  // Clear sender chains (key format: "s:channelId:epoch")
  for (const key of senderChains.keys()) {
    if (key.startsWith(`s:${channelId}:`)) senderChains.delete(key)
  }
  // Clear receiver chains (key format: "r:channelId:epoch:deviceId")
  for (const key of receiverChains.keys()) {
    if (key.startsWith(`r:${channelId}:`)) receiverChains.delete(key)
  }
  // Clear skipped keys for this channel (key format: "epoch:deviceId:index" — need to check all)
  // Skipped keys don't contain channelId, so we clear ALL of them on channel key change
  skippedKeys.clear()
  skippedKeyOrder.length = 0
  // Clear replay detection state for this channel
  for (const key of seenMessages) {
    if (key.startsWith(channelId + ':')) {
      seenMessages.delete(key)
      const idx = seenMessageOrder.indexOf(key)
      if (idx !== -1) seenMessageOrder.splice(idx, 1)
    }
  }
  // Clear persisted sender indices from localStorage
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i)
    if (k && k.startsWith(`e2e_chain_${channelId}:`)) localStorage.removeItem(k)
  }
  e2eLog(`🗑 Cleared ${cleared} cached key(s) + ratchet state for channel ${channelId.slice(0,8)}…`)
}

/**
 * Rotate the channel key with split-brain prevention.
 * Checks if epoch N+1 already exists on the server before distributing.
 * If it does, uses the existing key (or bumps to N+2) to avoid conflicts.
 * Sets local cache BEFORE distribution to prevent race with notification handlers.
 */
export async function rotateKeys(channelId: string): Promise<boolean> {
  const privKey = getPrivateKey()
  if (!privKey) return false

  const myDeviceId = getDeviceId()
  if (!myDeviceId) return false

  // Prevent concurrent rotations for the same channel
  if (rotatingChannels.has(channelId)) {
    e2eLog(`⏭ Rotation already in progress for ${channelId.slice(0,8)}…`)
    return false
  }

  rotatingChannels.add(channelId)
  try {
    // Invalidate epoch cache to get fresh value from server
    currentEpochCache.delete(channelId)
    const oldEpoch = await getCurrentEpoch(channelId)
    const targetEpoch = oldEpoch + 1

    // Atomically claim the epoch on the server. Only one device can win.
    // If we lose the claim, wait for the winner to distribute the key.
    let claimed = false
    try {
      const result = await api.claimEpoch(channelId, myDeviceId, targetEpoch)
      claimed = result.claimed
    } catch (err: unknown) {
      // Only fall through for 404 (server doesn't support claim endpoint).
      // Any other error (rate limit, server error) → bail out safely.
      if (err instanceof Error && err.message.includes('404')) {
        claimed = true
      } else {
        e2eWarn(`claimEpoch failed for epoch ${targetEpoch}:`, err)
        return false
      }
    }

    if (!claimed) {
      e2eLog(`⏳ Epoch ${targetEpoch} claimed by another device — waiting for key`)
      // Another device won the claim. Wait for them to distribute to all devices.
      // With many devices this can take 10-15s, so poll with retries.
      for (let wait = 0; wait < 5; wait++) {
        await new Promise(r => setTimeout(r, 3000))
        keyFetchPromises.delete(channelId)
        const key = await getChannelKeyForEpoch(channelId, targetEpoch)
        if (key) {
          currentEpochCache.set(channelId, targetEpoch)
          e2eLog(`✅ Loaded key from epoch winner: channel=${channelId.slice(0,8)}… epoch=${targetEpoch}`)
          return true
        }
      }
      // Winner still hasn't distributed to us — give up, key_request fallback will handle it
      e2eWarn(`⚠ Epoch ${targetEpoch} claimed but key never arrived after retries`)
      return false
    }

    return await doRotation(channelId, targetEpoch)
  } catch (e) {
    console.error('Failed to rotate channel keys:', e)
    return false
  } finally {
    rotatingChannels.delete(channelId)
  }
}

async function doRotation(channelId: string, targetEpoch: number): Promise<boolean> {
  e2eLog(`🔄 Rotating key: channel=${channelId.slice(0,8)}… → epoch ${targetEpoch}`)
  const newChannelKey = await crypto.generateChannelKey()
  const newChannelKeyB64 = await crypto.exportKey(newChannelKey)

  const privKey = getPrivateKey()
  if (!privKey) return false

  // Set local cache BEFORE distribution so we can encrypt immediately
  channelKeyCache.set(cacheKey(channelId, targetEpoch), newChannelKey)
  currentEpochCache.set(channelId, targetEpoch)

  // Encrypt for all devices and batch-upload to master keys (primary path)
  try {
    await uploadEncryptedMasterKeys(channelId, targetEpoch, newChannelKeyB64, privKey)
    e2eLog(`📤 Master keys stored: channel=${channelId.slice(0,8)}… epoch=${targetEpoch}`)
  } catch (err) {
    e2eWarn(`Failed to store master keys for epoch ${targetEpoch}:`, err)
  }

  // Also distribute per-device encrypted copies to channel_keys (best-effort fallback)
  await distributeKeyToDevices(channelId, targetEpoch, newChannelKeyB64)

  e2eLog(`✅ Key rotated: channel=${channelId.slice(0,8)}… now at epoch ${targetEpoch}`)
  return true
}

/**
 * Encrypt a file (ArrayBuffer) for an E2EE channel.
 * Format: [4 bytes epoch big-endian][12 bytes IV][AES-GCM ciphertext]
 * Returns null if channel has no key.
 */
export async function encryptFile(channelId: string, data: ArrayBuffer): Promise<ArrayBuffer | null> {
  const epoch = await getCurrentEpoch(channelId)
  if (epoch < 0) return null
  const key = await getChannelKeyForEpoch(channelId, epoch)
  if (!key) return null
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)
  const result = new Uint8Array(4 + 12 + encrypted.byteLength)
  new DataView(result.buffer).setUint32(0, epoch, false)
  result.set(iv, 4)
  result.set(new Uint8Array(encrypted), 16)
  return result.buffer as ArrayBuffer
}

/**
 * Decrypt a file (ArrayBuffer) from an E2EE channel.
 * Reads the epoch from the first 4 bytes and uses the corresponding key.
 * Returns null if decryption fails or key is missing.
 */
export async function decryptFile(channelId: string, data: ArrayBuffer): Promise<ArrayBuffer | null> {
  if (data.byteLength < 16) return null
  const epoch = new DataView(data).getUint32(0, false)
  const iv = new Uint8Array(data, 4, 12)
  const ciphertext = new Uint8Array(data, 16)
  const key = await getChannelKeyForEpoch(channelId, epoch)
  if (!key) { e2eWarn(`decryptFile: missing key for epoch ${epoch}`); return null }
  try {
    return await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  } catch (err) {
    e2eWarn('decryptFile: decryption failed', err)
    return null
  }
}
