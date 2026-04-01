import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import * as cryptoService from './crypto'

// Mock the api module
vi.mock('./api', () => ({
  getChannelKeys: vi.fn(),
  getChannelDevices: vi.fn(),
  getChannelEpoch: vi.fn(),
  setChannelKey: vi.fn(),
  getMasterKeys: vi.fn(),
  setMasterKeys: vi.fn(),
}))

// Mock AuthContext exports with test values
const mockPrivateKey = { value: null as string | null }
const mockSigningPrivateKey = { value: null as string | null }
const mockDeviceId = { value: null as string | null }

vi.mock('../context/AuthContext', () => ({
  getPrivateKey: () => mockPrivateKey.value,
  getSigningPrivateKey: () => mockSigningPrivateKey.value,
  getDeviceId: () => mockDeviceId.value,
}))

// Import after mocking
import * as api from './api'
import {
  encryptMessage,
  decryptMessage,
  isEncryptedContent,
  clearChannelKey,
  getCurrentEpoch,
  getChannelKeyForEpoch,
} from './e2e'

const mockedApi = vi.mocked(api)

// Shared stable keys — generated once, reused across tests to avoid device cache staleness
let stableAliceKP: { publicKey: string; privateKey: string }
let stableAliceSignKP: { signingPublicKey: string; signingPrivateKey: string }

beforeAll(async () => {
  stableAliceKP = await cryptoService.generateKeyPair()
  stableAliceSignKP = await cryptoService.generateSigningKeyPair()
})

// Helper: generate test keys and configure mocks for a working E2EE setup
async function setupE2ETest() {
  const channelKey = await cryptoService.generateChannelKey()
  const channelKeyB64 = await cryptoService.exportKey(channelKey)
  const deviceId = 'test-device-001'
  const channelId = 'test-channel-001'

  // Configure mocks with stable keys
  mockPrivateKey.value = stableAliceKP.privateKey
  mockSigningPrivateKey.value = stableAliceSignKP.signingPrivateKey
  mockDeviceId.value = deviceId

  // Build encrypted key blob for our device
  const myPubKey = await cryptoService.publicKeyFromPrivate(stableAliceKP.privateKey)
  const sharedKey = await cryptoService.deriveSharedKey(stableAliceKP.privateKey, myPubKey)
  const { ciphertext, nonce } = await cryptoService.encrypt(sharedKey, channelKeyB64)
  const encryptedKeyBlob = `pk.${myPubKey}:${nonce}.${ciphertext}`

  mockedApi.getChannelEpoch.mockResolvedValue({ epoch: 0 })
  mockedApi.getChannelKeys.mockResolvedValue([
    {
      channel_id: channelId,
      device_id: deviceId,
      epoch: 0,
      encrypted_key: encryptedKeyBlob,
    },
  ])
  mockedApi.getChannelDevices.mockResolvedValue([
    {
      id: deviceId,
      user_id: 'user-1',
      name: 'Test Device',
      public_key: myPubKey,
      signing_key: stableAliceSignKP.signingPublicKey,
      approved: true,
      created_at: new Date().toISOString(),
    },
  ])
  mockedApi.setChannelKey.mockResolvedValue(undefined)
  mockedApi.getMasterKeys.mockResolvedValue([])
  mockedApi.setMasterKeys.mockResolvedValue(undefined)

  return { channelKey, channelKeyB64, deviceId, channelId }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrivateKey.value = null
  mockSigningPrivateKey.value = null
  mockDeviceId.value = null
  // Clear all caches by clearing the channel key for any test channels
  clearChannelKey('test-channel-001')
  clearChannelKey('test-channel-002')
  // Reset localStorage keys used by e2e
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i)
    if (key?.startsWith('e2e_chain_')) localStorage.removeItem(key)
  }
})

describe('isEncryptedContent', () => {
  it('returns true for ENC: prefixed content', () => {
    expect(isEncryptedContent('ENC:some-encrypted-data')).toBe(true)
  })

  it('returns false for plaintext', () => {
    expect(isEncryptedContent('Hello world')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isEncryptedContent('')).toBe(false)
  })
})

describe('encryptMessage', () => {
  it('returns null when no private key is set', async () => {
    mockedApi.getChannelEpoch.mockResolvedValue({ epoch: 0 })
    const result = await encryptMessage('test-channel-001', 'hello')
    expect(result).toBeNull()
  })

  it('encrypts a message in the ratchet format', async () => {
    const { channelId } = await setupE2ETest()

    const result = await encryptMessage(channelId, 'Hello, encrypted!')
    expect(result).not.toBeNull()
    expect(result!.epoch).toBe(0)
    expect(result!.encrypted.startsWith('ENC:')).toBe(true)

    // Parse the ratchet format: ENC:<epoch>:<chainIndex>:<deviceId>:<nonce>:<signature>:<ciphertext>
    const payload = result!.encrypted.slice(4) // remove ENC:
    const parts = payload.split(':')
    expect(parts.length).toBe(6)
    expect(parts[0]).toBe('0') // epoch
    expect(parts[1]).toBe('0') // first message → chain index 0
    expect(parts[2]).toBe('test-device-001') // device ID
  })

  it('increments chain index for sequential messages', async () => {
    const { channelId } = await setupE2ETest()

    const msg1 = await encryptMessage(channelId, 'First message')
    const msg2 = await encryptMessage(channelId, 'Second message')
    const msg3 = await encryptMessage(channelId, 'Third message')

    expect(msg1).not.toBeNull()
    expect(msg2).not.toBeNull()
    expect(msg3).not.toBeNull()

    const idx1 = msg1!.encrypted.slice(4).split(':')[1]
    const idx2 = msg2!.encrypted.slice(4).split(':')[1]
    const idx3 = msg3!.encrypted.slice(4).split(':')[1]

    expect(idx1).toBe('0')
    expect(idx2).toBe('1')
    expect(idx3).toBe('2')
  })

  it('produces different ciphertexts for identical messages (ratchet)', async () => {
    const { channelId } = await setupE2ETest()

    const msg1 = await encryptMessage(channelId, 'Same text')
    const msg2 = await encryptMessage(channelId, 'Same text')

    expect(msg1).not.toBeNull()
    expect(msg2).not.toBeNull()
    expect(msg1!.encrypted).not.toBe(msg2!.encrypted)
  })
})

describe('decryptMessage', () => {
  it('passes through plaintext unchanged', async () => {
    const result = await decryptMessage('chan', 'Hello world')
    expect(result.text).toBe('Hello world')
    expect(result.verified).toBeNull()
  })

  it('decrypts own encrypted message (round-trip)', async () => {
    const { channelId } = await setupE2ETest()

    const encrypted = await encryptMessage(channelId, 'Secret message')
    expect(encrypted).not.toBeNull()

    const decrypted = await decryptMessage(channelId, encrypted!.encrypted, encrypted!.epoch)
    expect(decrypted.text).toBe('Secret message')
  })

  it('verifies signature on decrypted message', async () => {
    const { channelId } = await setupE2ETest()

    const encrypted = await encryptMessage(channelId, 'Signed message')
    expect(encrypted).not.toBeNull()

    const decrypted = await decryptMessage(channelId, encrypted!.encrypted, encrypted!.epoch)
    expect(decrypted.text).toBe('Signed message')
    expect(decrypted.verified).toBe(true)
  })

  it('detects replayed messages', async () => {
    const { channelId } = await setupE2ETest()

    const encrypted = await encryptMessage(channelId, 'Original')
    expect(encrypted).not.toBeNull()

    // First decryption succeeds
    const first = await decryptMessage(channelId, encrypted!.encrypted, encrypted!.epoch)
    expect(first.text).toBe('Original')

    // Second decryption of the same message is detected as replay
    const replayed = await decryptMessage(channelId, encrypted!.encrypted, encrypted!.epoch)
    expect(replayed.text).toBe('[encrypted — replayed message]')
    expect(replayed.verified).toBe(false)
  })

  it('decrypts multiple sequential messages', async () => {
    const { channelId } = await setupE2ETest()

    const messages = ['First', 'Second', 'Third', 'Fourth', 'Fifth']
    const encrypted = []
    for (const msg of messages) {
      const enc = await encryptMessage(channelId, msg)
      expect(enc).not.toBeNull()
      encrypted.push(enc!)
    }

    // Decrypt all in order
    for (let i = 0; i < messages.length; i++) {
      const dec = await decryptMessage(channelId, encrypted[i]!.encrypted, encrypted[i]!.epoch)
      expect(dec.text).toBe(messages[i])
    }
  })

  it('returns error text for invalid encrypted format', async () => {
    const result = await decryptMessage('chan', 'ENC:invalid')
    expect(result.text).toContain('[encrypted')
  })

  it('handles missing key gracefully', async () => {
    mockDeviceId.value = 'no-device'
    mockedApi.getChannelKeys.mockResolvedValue([])
    mockedApi.getChannelEpoch.mockResolvedValue({ epoch: 0 })

    const result = await decryptMessage('chan', 'ENC:0:0:dev1:nonce:sig:cipher', 0)
    expect(result.text).toContain('[encrypted')
  })
})

describe('getCurrentEpoch', () => {
  it('returns epoch from server', async () => {
    mockedApi.getChannelEpoch.mockResolvedValue({ epoch: 5 })
    clearChannelKey('test-channel-epoch')
    const epoch = await getCurrentEpoch('test-channel-epoch')
    expect(epoch).toBe(5)
  })

  it('caches the epoch after first fetch', async () => {
    mockedApi.getChannelEpoch.mockResolvedValue({ epoch: 3 })
    clearChannelKey('test-channel-cache')
    await getCurrentEpoch('test-channel-cache')
    await getCurrentEpoch('test-channel-cache')
    // Should only call API once due to caching
    expect(mockedApi.getChannelEpoch).toHaveBeenCalledTimes(1)
  })

  it('returns -1 on error', async () => {
    mockedApi.getChannelEpoch.mockRejectedValue(new Error('network error'))
    clearChannelKey('test-channel-err')
    const epoch = await getCurrentEpoch('test-channel-err')
    expect(epoch).toBe(-1)
  })
})

describe('clearChannelKey', () => {
  it('clears cached keys and epoch for a channel', async () => {
    const { channelId } = await setupE2ETest()

    // Load a key into cache
    await getCurrentEpoch(channelId)
    await getChannelKeyForEpoch(channelId, 0)

    // Clear cache
    clearChannelKey(channelId)

    // Next getCurrentEpoch should re-fetch from server
    mockedApi.getChannelEpoch.mockResolvedValue({ epoch: 0 })
    await getCurrentEpoch(channelId)
    // Should have been called again after clear
    expect(mockedApi.getChannelEpoch.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('Encrypted message format', () => {
  it('produces the correct ratchet format structure', async () => {
    const { channelId, deviceId } = await setupE2ETest()

    const result = await encryptMessage(channelId, 'Format test')
    expect(result).not.toBeNull()

    const content = result!.encrypted
    expect(content.startsWith('ENC:')).toBe(true)

    const payload = content.slice(4)
    const [epoch, chainIndex, msgDeviceId, nonce, signature, ciphertext] = payload.split(':')

    expect(epoch).toBe('0')
    expect(chainIndex).toBe('0')
    expect(msgDeviceId).toBe(deviceId)
    expect(nonce!.length).toBeGreaterThan(0) // base64 nonce
    expect(signature!.length).toBeGreaterThan(0) // base64 signature
    expect(ciphertext!.length).toBeGreaterThan(0) // base64 ciphertext
  })
})
