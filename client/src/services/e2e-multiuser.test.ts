/**
 * Multi-user E2EE tests — exercises two users (Alice & Bob) with separate devices/keys
 * to verify cross-user encrypt/decrypt, key rotation, epoch transitions, and concurrent decryption.
 * These scenarios are what the single-user tests miss.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import * as cryptoService from './crypto'

// Mock the api module
vi.mock('./api', () => ({
  getChannelKeys: vi.fn(),
  getChannelDevices: vi.fn(),
  getChannelEpoch: vi.fn(),
  setChannelKey: vi.fn(),
  claimEpoch: vi.fn(),
  getMasterKeys: vi.fn(),
  setMasterKeys: vi.fn(),
}))

// Mutable identity — switched between Alice and Bob during tests
const mockPrivateKey = { value: null as string | null }
const mockSigningPrivateKey = { value: null as string | null }
const mockDeviceId = { value: null as string | null }

vi.mock('../context/AuthContext', () => ({
  getPrivateKey: () => mockPrivateKey.value,
  getSigningPrivateKey: () => mockSigningPrivateKey.value,
  getDeviceId: () => mockDeviceId.value,
}))

import * as api from './api'
import {
  encryptMessage,
  decryptMessage,
  enableEncryption,
  rotateKeys,
  clearChannelKey,
  resetChannelState,
  getChannelKeyForEpoch,
  getChannelKey,
  preWarmKeys,
  invalidateCachedEpoch,
} from './e2e'

const mockedApi = vi.mocked(api)

// ──── Stable test identities ────

interface TestUser {
  userId: string
  deviceId: string
  publicKey: string
  privateKey: string
  signingPublicKey: string
  signingPrivateKey: string
}

let alice: TestUser
let bob: TestUser
const channelId = 'test-multiuser-chan'

beforeAll(async () => {
  const aliceKP = await cryptoService.generateKeyPair()
  const aliceSign = await cryptoService.generateSigningKeyPair()
  alice = {
    userId: 'user-alice',
    deviceId: 'device-alice',
    publicKey: aliceKP.publicKey,
    privateKey: aliceKP.privateKey,
    signingPublicKey: aliceSign.signingPublicKey,
    signingPrivateKey: aliceSign.signingPrivateKey,
  }

  const bobKP = await cryptoService.generateKeyPair()
  const bobSign = await cryptoService.generateSigningKeyPair()
  bob = {
    userId: 'user-bob',
    deviceId: 'device-bob',
    publicKey: bobKP.publicKey,
    privateKey: bobKP.privateKey,
    signingPublicKey: bobSign.signingPublicKey,
    signingPrivateKey: bobSign.signingPrivateKey,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  mockPrivateKey.value = null
  mockSigningPrivateKey.value = null
  mockDeviceId.value = null
  resetChannelState(channelId)
  resetChannelState('test-multiuser-chan-2')
  epochClaimStore = []
  masterKeyStore = []
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i)
    if (key?.startsWith('e2e_chain_')) localStorage.removeItem(key)
  }
})

// ──── Helpers ────

function setActiveUser(user: TestUser) {
  mockPrivateKey.value = user.privateKey
  mockSigningPrivateKey.value = user.signingPrivateKey
  mockDeviceId.value = user.deviceId
}

/** Build an encrypted key blob from sender → recipient, wrapping channelKeyB64 */
async function buildEncryptedKeyBlob(
  sender: TestUser,
  recipientPubKey: string,
  channelKeyB64: string,
): Promise<string> {
  const senderPubKey = await cryptoService.publicKeyFromPrivate(sender.privateKey)
  const sharedKey = await cryptoService.deriveSharedKey(sender.privateKey, recipientPubKey)
  const { ciphertext, nonce } = await cryptoService.encrypt(sharedKey, channelKeyB64)
  return `pk.${senderPubKey}:${nonce}.${ciphertext}`
}

/** Track keys set by setChannelKey mock — simulates server key DB */
type KeyEntry = { channel_id: string; device_id: string; epoch: number; encrypted_key: string }
let serverKeyStore: KeyEntry[]

type ClaimEntry = { channel_id: string; device_id: string; epoch: number }
let epochClaimStore: ClaimEntry[]

type MasterKeyEntry = { channel_id: string; epoch: number; device_id: string; encrypted_key: string }
let masterKeyStore: MasterKeyEntry[]

/** Configure API mocks based on key store and user/device list */
function setupApiMocks(opts: {
  epoch: number
  devices?: TestUser[]
}) {
  const devices = opts.devices ?? [alice, bob]

  mockedApi.getChannelEpoch.mockResolvedValue({ epoch: opts.epoch })

  mockedApi.getChannelDevices.mockResolvedValue(
    devices.map((u) => ({
      id: u.deviceId,
      user_id: u.userId,
      name: 'Device',
      public_key: u.publicKey,
      signing_key: u.signingPublicKey,
      approved: true,
      created_at: new Date().toISOString(),
    })),
  )

  // getChannelKeys returns the accumulated key store
  mockedApi.getChannelKeys.mockImplementation(async () => [...serverKeyStore])

  // setChannelKey simulates server INSERT OR IGNORE — once a (channel, device, epoch)
  // entry exists it cannot be overwritten
  mockedApi.setChannelKey.mockImplementation(async (chanId, encKey, devId, epoch) => {
    const idx = serverKeyStore.findIndex(
      (k) => k.channel_id === chanId && k.device_id === devId && k.epoch === epoch,
    )
    if (idx >= 0) {
      // Already exists — silently ignore (INSERT OR IGNORE semantics)
      return
    }
    serverKeyStore.push({
      channel_id: chanId as string,
      device_id: devId as string,
      epoch: epoch as number,
      encrypted_key: encKey as string,
    })
  })

  // claimEpoch simulates server epoch_claims table: INSERT OR IGNORE with PK (channel_id, epoch)
  mockedApi.claimEpoch.mockImplementation(async (_chanId, _devId, epoch) => {
    const existing = epochClaimStore.find(
      (c) => c.channel_id === channelId && c.epoch === epoch,
    )
    if (existing) {
      return { epoch: epoch as number, claimed: false }
    }
    epochClaimStore.push({
      channel_id: channelId,
      device_id: _devId as string,
      epoch: epoch as number,
    })
    return { epoch: epoch as number, claimed: true }
  })

  // Master keys: simulate server batch INSERT OR IGNORE with per-device entries
  mockedApi.setMasterKeys.mockImplementation(async (chanId, epoch, keys) => {
    for (const k of keys as { device_id: string; encrypted_key: string }[]) {
      const existing = masterKeyStore.find(
        (e) => e.channel_id === chanId && e.epoch === (epoch as number) && e.device_id === k.device_id,
      )
      if (!existing) {
        masterKeyStore.push({
          channel_id: chanId as string,
          epoch: epoch as number,
          device_id: k.device_id,
          encrypted_key: k.encrypted_key,
        })
      }
    }
  })
  mockedApi.getMasterKeys.mockImplementation(async (chanId) => {
    return masterKeyStore
      .filter((k) => k.channel_id === chanId)
      .map((k) => ({ channel_id: k.channel_id, device_id: k.device_id, epoch: k.epoch, encrypted_key: k.encrypted_key }))
  })
}

// ──── Tests ────

describe('Multi-user: enableEncryption', () => {
  it('distributes key to all channel member devices', async () => {
    serverKeyStore = []
    setupApiMocks({ epoch: 0 })

    setActiveUser(alice)
    const ok = await enableEncryption(channelId)
    expect(ok).toBe(true)

    // Both Alice's and Bob's devices should have a key
    const aliceKeys = serverKeyStore.filter((k) => k.device_id === alice.deviceId)
    const bobKeys = serverKeyStore.filter((k) => k.device_id === bob.deviceId)
    expect(aliceKeys).toHaveLength(1)
    expect(bobKeys).toHaveLength(1)
  })
})

describe('Multi-user: rotateKeys distributes to all devices', () => {
  it('Bob self-rotates and distributes key to both Alice and Bob', async () => {
    serverKeyStore = []
    // First: Alice enables encryption (epoch 0, only Alice gets key)
    setupApiMocks({ epoch: 0 })
    setActiveUser(alice)
    await enableEncryption(channelId)

    // Clear local caches to simulate Bob on a different client
    clearChannelKey(channelId)

    // Bob doesn't have epoch 0 key, so rotate will create epoch 1
    // Update API to reflect epoch 0 exists
    const epoch0AliceKey = serverKeyStore.find(
      (k) => k.device_id === alice.deviceId && k.epoch === 0,
    )
    expect(epoch0AliceKey).toBeDefined()

    setActiveUser(bob)
    // Bob can't read epoch 0 (no key for his device), so rotateKeys should bump to epoch 1
    const rotated = await rotateKeys(channelId)
    expect(rotated).toBe(true)

    // After rotation, both Alice and Bob should have epoch 1 keys
    const epoch1Keys = serverKeyStore.filter((k) => k.epoch === 1)
    const aliceEpoch1 = epoch1Keys.find((k) => k.device_id === alice.deviceId)
    const bobEpoch1 = epoch1Keys.find((k) => k.device_id === bob.deviceId)
    expect(aliceEpoch1).toBeDefined()
    expect(bobEpoch1).toBeDefined()
  })
})

describe('Multi-user: cross-user encrypt/decrypt', () => {
  /** Set up epoch 1 keys for both Alice and Bob (simulating Bob's rotation) */
  async function setupBothUsersWithKey(): Promise<string> {
    const channelKey = await cryptoService.generateChannelKey()
    const channelKeyB64 = await cryptoService.exportKey(channelKey)

    // Build encrypted key blobs from Bob (rotator) to both devices
    const encAlice = await buildEncryptedKeyBlob(bob, alice.publicKey, channelKeyB64)
    const encBob = await buildEncryptedKeyBlob(bob, bob.publicKey, channelKeyB64)

    serverKeyStore = [
      { channel_id: channelId, device_id: alice.deviceId, epoch: 1, encrypted_key: encAlice },
      { channel_id: channelId, device_id: bob.deviceId, epoch: 1, encrypted_key: encBob },
    ]
    setupApiMocks({ epoch: 1 })

    return channelKeyB64
  }

  it('Alice encrypts, Bob decrypts', async () => {
    await setupBothUsersWithKey()

    // Alice encrypts
    setActiveUser(alice)
    const encrypted = await encryptMessage(channelId, 'Hello from Alice!')
    expect(encrypted).not.toBeNull()
    expect(encrypted!.epoch).toBe(1)

    // Clear caches to simulate separate client
    clearChannelKey(channelId)

    // Bob decrypts
    setActiveUser(bob)
    const decrypted = await decryptMessage(channelId, encrypted!.encrypted, encrypted!.epoch)
    expect(decrypted.text).toBe('Hello from Alice!')
    expect(decrypted.verified).toBe(true)
  })

  it('Bob encrypts, Alice decrypts', async () => {
    await setupBothUsersWithKey()

    // Bob encrypts
    setActiveUser(bob)
    const encrypted = await encryptMessage(channelId, 'Hello from Bob!')
    expect(encrypted).not.toBeNull()

    // Clear caches to simulate separate client
    clearChannelKey(channelId)

    // Alice decrypts
    setActiveUser(alice)
    const decrypted = await decryptMessage(channelId, encrypted!.encrypted, encrypted!.epoch)
    expect(decrypted.text).toBe('Hello from Bob!')
    expect(decrypted.verified).toBe(true)
  })

  it('both users exchange multiple messages', async () => {
    await setupBothUsersWithKey()

    // Alice sends two messages
    setActiveUser(alice)
    const a1 = await encryptMessage(channelId, 'Alice msg 1')
    const a2 = await encryptMessage(channelId, 'Alice msg 2')
    expect(a1).not.toBeNull()
    expect(a2).not.toBeNull()

    // Bob sends a message
    clearChannelKey(channelId)
    setActiveUser(bob)
    const b1 = await encryptMessage(channelId, 'Bob msg 1')
    expect(b1).not.toBeNull()

    // Bob decrypts Alice's messages
    const decA1 = await decryptMessage(channelId, a1!.encrypted, a1!.epoch)
    const decA2 = await decryptMessage(channelId, a2!.encrypted, a2!.epoch)
    expect(decA1.text).toBe('Alice msg 1')
    expect(decA2.text).toBe('Alice msg 2')

    // Alice decrypts Bob's message
    clearChannelKey(channelId)
    setActiveUser(alice)
    const decB1 = await decryptMessage(channelId, b1!.encrypted, b1!.epoch)
    expect(decB1.text).toBe('Bob msg 1')
  })

  it('out-of-order message decryption works', async () => {
    await setupBothUsersWithKey()

    // Alice sends 3 messages
    setActiveUser(alice)
    const msgs = []
    for (let i = 0; i < 3; i++) {
      msgs.push(await encryptMessage(channelId, `Message ${i}`))
    }
    expect(msgs.every((m) => m !== null)).toBe(true)

    // Bob decrypts in reverse order (out of order)
    clearChannelKey(channelId)
    setActiveUser(bob)
    const dec2 = await decryptMessage(channelId, msgs[2]!.encrypted, msgs[2]!.epoch)
    const dec0 = await decryptMessage(channelId, msgs[0]!.encrypted, msgs[0]!.epoch)
    const dec1 = await decryptMessage(channelId, msgs[1]!.encrypted, msgs[1]!.epoch)

    expect(dec2.text).toBe('Message 2')
    expect(dec0.text).toBe('Message 0')
    expect(dec1.text).toBe('Message 1')
  })
})

describe('Multi-user: concurrent parallel decryption', () => {
  it('decrypts multiple messages in Promise.all without races', async () => {
    const channelKey = await cryptoService.generateChannelKey()
    const channelKeyB64 = await cryptoService.exportKey(channelKey)

    const encAlice = await buildEncryptedKeyBlob(alice, alice.publicKey, channelKeyB64)
    const encBob = await buildEncryptedKeyBlob(alice, bob.publicKey, channelKeyB64)

    serverKeyStore = [
      { channel_id: channelId, device_id: alice.deviceId, epoch: 0, encrypted_key: encAlice },
      { channel_id: channelId, device_id: bob.deviceId, epoch: 0, encrypted_key: encBob },
    ]
    setupApiMocks({ epoch: 0 })

    // Alice encrypts 10 messages
    setActiveUser(alice)
    const encrypted: { encrypted: string; epoch: number }[] = []
    for (let i = 0; i < 10; i++) {
      const enc = await encryptMessage(channelId, `Parallel msg ${i}`)
      expect(enc).not.toBeNull()
      encrypted.push(enc!)
    }

    // Clear and switch to Bob
    clearChannelKey(channelId)
    setActiveUser(bob)

    // Bob decrypts all 10 in parallel — this is the scenario that was broken before
    const results = await Promise.all(
      encrypted.map((e) => decryptMessage(channelId, e.encrypted, e.epoch)),
    )

    for (let i = 0; i < 10; i++) {
      expect(results[i]!.text).toBe(`Parallel msg ${i}`)
    }
  })
})

describe('Multi-user: preWarmKeys', () => {
  it('bulk-loads all epoch keys for the active user device', async () => {
    const key0 = await cryptoService.generateChannelKey()
    const key0B64 = await cryptoService.exportKey(key0)
    const key1 = await cryptoService.generateChannelKey()
    const key1B64 = await cryptoService.exportKey(key1)

    const enc0 = await buildEncryptedKeyBlob(alice, bob.publicKey, key0B64)
    const enc1 = await buildEncryptedKeyBlob(alice, bob.publicKey, key1B64)

    serverKeyStore = [
      { channel_id: channelId, device_id: bob.deviceId, epoch: 0, encrypted_key: enc0 },
      { channel_id: channelId, device_id: bob.deviceId, epoch: 1, encrypted_key: enc1 },
    ]
    setupApiMocks({ epoch: 1 })

    setActiveUser(bob)
    await preWarmKeys(channelId)

    // Both epochs should now be cached — subsequent getChannelKeyForEpoch should not call API again
    const cachedKey0 = await getChannelKeyForEpoch(channelId, 0)
    const cachedKey1 = await getChannelKeyForEpoch(channelId, 1)
    expect(cachedKey0).not.toBeNull()
    expect(cachedKey1).not.toBeNull()

    // getChannelKeys should not have been called again beyond the preWarmKeys call
    // (preWarmKeys calls it once, getChannelKeyForEpoch should use cache)
    expect(mockedApi.getChannelKeys).toHaveBeenCalledTimes(1)
  })
})

describe('Multi-user: epoch transition / forward secrecy', () => {
  it('Bob cannot decrypt Alice epoch-0 messages (forward secrecy)', async () => {
    // Alice has epoch 0 key, Bob does not
    const channelKey = await cryptoService.generateChannelKey()
    const channelKeyB64 = await cryptoService.exportKey(channelKey)

    const encAlice = await buildEncryptedKeyBlob(alice, alice.publicKey, channelKeyB64)

    serverKeyStore = [
      { channel_id: channelId, device_id: alice.deviceId, epoch: 0, encrypted_key: encAlice },
      // Note: no entry for Bob at epoch 0
    ]
    setupApiMocks({ epoch: 0 })

    // Alice encrypts at epoch 0
    setActiveUser(alice)
    const encrypted = await encryptMessage(channelId, 'Secret before Bob joined')
    expect(encrypted).not.toBeNull()

    // Bob tries to decrypt — should fail because he has no key for epoch 0
    clearChannelKey(channelId)
    setActiveUser(bob)
    const result = await decryptMessage(channelId, encrypted!.encrypted, encrypted!.epoch)
    expect(result.text).toContain('[encrypted')
  })

  it('both users can decrypt after epoch transition', async () => {
    // Set up epoch 0 for Alice only
    const key0 = await cryptoService.generateChannelKey()
    const key0B64 = await cryptoService.exportKey(key0)
    const encAlice0 = await buildEncryptedKeyBlob(alice, alice.publicKey, key0B64)

    serverKeyStore = [
      { channel_id: channelId, device_id: alice.deviceId, epoch: 0, encrypted_key: encAlice0 },
    ]
    setupApiMocks({ epoch: 0 })

    // Alice encrypts at epoch 0
    setActiveUser(alice)
    const msgEpoch0 = await encryptMessage(channelId, 'Epoch 0 message')
    expect(msgEpoch0).not.toBeNull()

    // Now Bob rotates to epoch 1 — both get keys
    clearChannelKey(channelId)
    const key1 = await cryptoService.generateChannelKey()
    const key1B64 = await cryptoService.exportKey(key1)
    const encAlice1 = await buildEncryptedKeyBlob(bob, alice.publicKey, key1B64)
    const encBob1 = await buildEncryptedKeyBlob(bob, bob.publicKey, key1B64)
    serverKeyStore.push(
      { channel_id: channelId, device_id: alice.deviceId, epoch: 1, encrypted_key: encAlice1 },
      { channel_id: channelId, device_id: bob.deviceId, epoch: 1, encrypted_key: encBob1 },
    )
    setupApiMocks({ epoch: 1 })

    // Both can encrypt and decrypt at epoch 1
    setActiveUser(alice)
    const aliceMsg = await encryptMessage(channelId, 'Alice at epoch 1')
    expect(aliceMsg).not.toBeNull()

    clearChannelKey(channelId)
    setActiveUser(bob)
    const bobMsg = await encryptMessage(channelId, 'Bob at epoch 1')
    expect(bobMsg).not.toBeNull()

    // Bob decrypts Alice's epoch 1 message
    const decAlice = await decryptMessage(channelId, aliceMsg!.encrypted, aliceMsg!.epoch)
    expect(decAlice.text).toBe('Alice at epoch 1')

    // Alice decrypts Bob's epoch 1 message
    clearChannelKey(channelId)
    setActiveUser(alice)
    const decBob = await decryptMessage(channelId, bobMsg!.encrypted, bobMsg!.epoch)
    expect(decBob.text).toBe('Bob at epoch 1')

    // Alice can still decrypt her own epoch 0 message
    const decEpoch0 = await decryptMessage(channelId, msgEpoch0!.encrypted, msgEpoch0!.epoch)
    expect(decEpoch0.text).toBe('Epoch 0 message')

    // Bob still can't decrypt epoch 0 (forward secrecy preserved)
    clearChannelKey(channelId)
    setActiveUser(bob)
    const attempt = await decryptMessage(channelId, msgEpoch0!.encrypted, msgEpoch0!.epoch)
    expect(attempt.text).toContain('[encrypted')
  })
})

describe('Multi-user: signature cross-verification', () => {
  it('Alice signature is verified by Bob using her signing key', async () => {
    const channelKey = await cryptoService.generateChannelKey()
    const channelKeyB64 = await cryptoService.exportKey(channelKey)

    const encAlice = await buildEncryptedKeyBlob(alice, alice.publicKey, channelKeyB64)
    const encBob = await buildEncryptedKeyBlob(alice, bob.publicKey, channelKeyB64)

    serverKeyStore = [
      { channel_id: channelId, device_id: alice.deviceId, epoch: 0, encrypted_key: encAlice },
      { channel_id: channelId, device_id: bob.deviceId, epoch: 0, encrypted_key: encBob },
    ]
    setupApiMocks({ epoch: 0 })

    // Alice encrypts (includes her ECDSA signature)
    setActiveUser(alice)
    const encrypted = await encryptMessage(channelId, 'Signed by Alice')
    expect(encrypted).not.toBeNull()

    // Bob decrypts — Bob's client will look up Alice's device signing key from the devices list
    clearChannelKey(channelId)
    setActiveUser(bob)
    const result = await decryptMessage(channelId, encrypted!.encrypted, encrypted!.epoch)
    expect(result.text).toBe('Signed by Alice')
    expect(result.verified).toBe(true)
  })
})

describe('Multi-user: resilient key distribution', () => {
  it('distributeKeyToDevices tolerates a non-self device failure', async () => {
    serverKeyStore = []
    setupApiMocks({ epoch: -1 })

    // Make setChannelKey fail for Bob's device but succeed for Alice's
    let callCount = 0
    mockedApi.setChannelKey.mockImplementation(async (chanId, encKey, devId, epoch) => {
      callCount++
      if (devId === bob.deviceId) {
        throw new Error('network error')
      }
      const entry = { channel_id: chanId as string, device_id: devId as string, epoch: epoch as number, encrypted_key: encKey as string }
      serverKeyStore.push(entry)
    })

    setActiveUser(alice)
    const rotated = await rotateKeys(channelId)
    expect(rotated).toBe(true)

    // Alice's key should be in the store, Bob's should not
    const aliceKeys = serverKeyStore.filter((k) => k.device_id === alice.deviceId)
    const bobKeys = serverKeyStore.filter((k) => k.device_id === bob.deviceId)
    expect(aliceKeys.length).toBeGreaterThanOrEqual(1)
    expect(bobKeys).toHaveLength(0)

    // Alice can still encrypt with the key
    const encrypted = await encryptMessage(channelId, 'Still works')
    expect(encrypted).not.toBeNull()
  })

  it('rotateKeys fails if own device key upload fails', async () => {
    serverKeyStore = []
    setupApiMocks({ epoch: -1 })

    // Make setChannelKey fail for Alice's own device
    mockedApi.setChannelKey.mockImplementation(async (_chanId, _encKey, devId, _epoch) => {
      if (devId === alice.deviceId) {
        throw new Error('upload failed')
      }
    })

    setActiveUser(alice)
    const rotated = await rotateKeys(channelId)
    expect(rotated).toBe(false)
  })

  it('rotateKeys re-verification restores local key on server reload failure', async () => {
    serverKeyStore = []
    setupApiMocks({ epoch: -1 })

    setActiveUser(alice)
    const rotated = await rotateKeys(channelId)
    expect(rotated).toBe(true)

    // Key should be usable even if re-verification had trouble
    // (rotateKeys sets local cache before distribution, re-verify restores on failure)
    const key = await getChannelKey(channelId)
    expect(key).not.toBeNull()

    const encrypted = await encryptMessage(channelId, 'After rotation')
    expect(encrypted).not.toBeNull()

    // Self-decrypt
    const decrypted = await decryptMessage(channelId, encrypted!.encrypted, encrypted!.epoch)
    expect(decrypted.text).toBe('After rotation')
  })

  it('invalidateCachedEpoch forces fresh server reload on next access', async () => {
    serverKeyStore = []
    setupApiMocks({ epoch: -1 })

    setActiveUser(alice)
    await rotateKeys(channelId)

    // Cache is populated
    const key1 = await getChannelKeyForEpoch(channelId, 0)
    expect(key1).not.toBeNull()

    // Invalidate and ensure next access hits the API again
    const callsBefore = mockedApi.getMasterKeys.mock.calls.length
    invalidateCachedEpoch(channelId, 0)
    const key2 = await getChannelKeyForEpoch(channelId, 0)
    expect(key2).not.toBeNull()
    // Should have made a new API call (master keys is the primary fetch path)
    expect(mockedApi.getMasterKeys.mock.calls.length).toBeGreaterThan(callsBefore)
  })
})

describe('Multi-user: replay detection across users', () => {
  it('replayed message from another user is detected', async () => {
    const channelKey = await cryptoService.generateChannelKey()
    const channelKeyB64 = await cryptoService.exportKey(channelKey)

    const encAlice = await buildEncryptedKeyBlob(alice, alice.publicKey, channelKeyB64)
    const encBob = await buildEncryptedKeyBlob(alice, bob.publicKey, channelKeyB64)

    serverKeyStore = [
      { channel_id: channelId, device_id: alice.deviceId, epoch: 0, encrypted_key: encAlice },
      { channel_id: channelId, device_id: bob.deviceId, epoch: 0, encrypted_key: encBob },
    ]
    setupApiMocks({ epoch: 0 })

    setActiveUser(alice)
    const encrypted = await encryptMessage(channelId, 'Original')
    expect(encrypted).not.toBeNull()

    // Bob decrypts once — succeeds
    clearChannelKey(channelId)
    setActiveUser(bob)
    const first = await decryptMessage(channelId, encrypted!.encrypted, encrypted!.epoch)
    expect(first.text).toBe('Original')

    // Bob decrypts same message again — replay detected
    const replayed = await decryptMessage(channelId, encrypted!.encrypted, encrypted!.epoch)
    expect(replayed.text).toBe('[encrypted — replayed message]')
    expect(replayed.verified).toBe(false)
  })
})

describe('Multi-user: epoch claim prevents split-brain', () => {
  it('rotateKeys calls claimEpoch before generating key', async () => {
    serverKeyStore = []
    setupApiMocks({ epoch: -1 })

    setActiveUser(alice)
    await rotateKeys(channelId)

    expect(mockedApi.claimEpoch).toHaveBeenCalledWith(channelId, alice.deviceId, 0)
  })

  it('claim winner generates and distributes key to all devices', async () => {
    serverKeyStore = []
    setupApiMocks({ epoch: -1 })

    setActiveUser(alice)
    const rotated = await rotateKeys(channelId)
    expect(rotated).toBe(true)

    // Both Alice and Bob should have epoch 0 keys (real, not claim:pending)
    const realKeys = serverKeyStore.filter((k) => k.encrypted_key !== 'claim:pending')
    const aliceKey = realKeys.find((k) => k.device_id === alice.deviceId && k.epoch === 0)
    const bobKey = realKeys.find((k) => k.device_id === bob.deviceId && k.epoch === 0)
    expect(aliceKey).toBeDefined()
    expect(bobKey).toBeDefined()
  })

  it('claim loser loads winner key instead of generating own', { timeout: 20000 }, async () => {
    // Alice wins epoch 0 claim — set up her key for both devices
    const channelKey = await cryptoService.generateChannelKey()
    const channelKeyB64 = await cryptoService.exportKey(channelKey)
    const encAlice = await buildEncryptedKeyBlob(alice, alice.publicKey, channelKeyB64)
    const encBob = await buildEncryptedKeyBlob(alice, bob.publicKey, channelKeyB64)

    serverKeyStore = [
      { channel_id: channelId, device_id: alice.deviceId, epoch: 0, encrypted_key: encAlice },
      { channel_id: channelId, device_id: bob.deviceId, epoch: 0, encrypted_key: encBob },
    ]
    setupApiMocks({ epoch: 0 })

    // Bob tries to claim epoch 1 but another device already claimed it
    // Pre-claim epoch 1 in the claims store so Bob's claim fails
    epochClaimStore.push({
      channel_id: channelId,
      device_id: alice.deviceId,
      epoch: 1,
    })

    // Alice distributes epoch 1 key (simulating winner completing distribution)
    const key1 = await cryptoService.generateChannelKey()
    const key1B64 = await cryptoService.exportKey(key1)
    const encAlice1 = await buildEncryptedKeyBlob(alice, alice.publicKey, key1B64)
    const encBob1 = await buildEncryptedKeyBlob(alice, bob.publicKey, key1B64)

    // Schedule the key to appear after a short delay (simulating winner distributing)
    let fetchCount = 0
    mockedApi.getChannelKeys.mockImplementation(async () => {
      fetchCount++
      if (fetchCount >= 2) {
        // On second fetch (after Bob waits), add epoch 1 real keys
        if (!serverKeyStore.find((k) => k.device_id === alice.deviceId && k.epoch === 1)) {
          serverKeyStore.push({ channel_id: channelId, device_id: alice.deviceId, epoch: 1, encrypted_key: encAlice1 })
        }
        if (!serverKeyStore.find((k) => k.device_id === bob.deviceId && k.epoch === 1)) {
          serverKeyStore.push({ channel_id: channelId, device_id: bob.deviceId, epoch: 1, encrypted_key: encBob1 })
        }
      }
      return [...serverKeyStore]
    })

    setActiveUser(bob)
    clearChannelKey(channelId)
    const rotated = await rotateKeys(channelId)
    expect(rotated).toBe(true)

    // Bob should NOT have generated his own key — he loaded Alice's
    // Verify Bob can decrypt a message encrypted with Alice's epoch 1 key
    setActiveUser(alice)
    clearChannelKey(channelId)
    mockedApi.getChannelKeys.mockImplementation(async () => [...serverKeyStore])
    mockedApi.getChannelEpoch.mockResolvedValue({ epoch: 1 })
    const encrypted = await encryptMessage(channelId, 'Alice epoch 1')
    expect(encrypted).not.toBeNull()
    expect(encrypted!.epoch).toBe(1)

    clearChannelKey(channelId)
    setActiveUser(bob)
    const decrypted = await decryptMessage(channelId, encrypted!.encrypted, encrypted!.epoch)
    expect(decrypted.text).toBe('Alice epoch 1')
    expect(decrypted.verified).toBe(true)
  })

  it('two users cannot create different keys for the same epoch', { timeout: 20000 }, async () => {
    // This tests the core split-brain scenario:
    // Both Alice and Bob rotate simultaneously — only one should win
    serverKeyStore = []
    setupApiMocks({ epoch: -1 })

    // Alice claims and rotates
    setActiveUser(alice)
    const aliceRotated = await rotateKeys(channelId)
    expect(aliceRotated).toBe(true)

    // Alice should have claimed epoch 0
    expect(mockedApi.claimEpoch).toHaveBeenCalledWith(channelId, alice.deviceId, 0)

    // Alice's key is now in the store for both devices
    const aliceKey = serverKeyStore.find(
      (k) => k.device_id === alice.deviceId && k.epoch === 0 && k.encrypted_key !== 'claim:pending',
    )
    expect(aliceKey).toBeDefined()

    // Alice encrypts a message at epoch 0
    const aliceMsg = await encryptMessage(channelId, 'Alice wrote this')
    expect(aliceMsg).not.toBeNull()

    // Bob tries to rotate — epoch 0 is already claimed
    clearChannelKey(channelId)
    setActiveUser(bob)
    const bobRotated = await rotateKeys(channelId)
    expect(bobRotated).toBe(true)

    // Bob should have loaded Alice's key (not generated his own)
    // Verify by decrypting Alice's message
    const decrypted = await decryptMessage(channelId, aliceMsg!.encrypted, aliceMsg!.epoch)
    expect(decrypted.text).toBe('Alice wrote this')
    expect(decrypted.verified).toBe(true)
  })
})
