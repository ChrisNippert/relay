import { describe, it, expect } from 'vitest'
import {
  generateKeyPair,
  generateSigningKeyPair,
  generateChannelKey,
  deriveSharedKey,
  encrypt,
  decrypt,
  exportKey,
  importKey,
  sign,
  verify,
  publicKeyFromPrivate,
  deriveChainKey,
  deriveMessageKey,
  advanceChainKey,
  hkdf,
} from './crypto'

describe('Key Generation', () => {
  it('generates an ECDH key pair with public and private keys', async () => {
    const kp = await generateKeyPair()
    expect(kp.publicKey).toBeTruthy()
    expect(kp.privateKey).toBeTruthy()
    // Public key is base64-encoded P-256 raw key (65 bytes uncompressed)
    expect(kp.publicKey.length).toBeGreaterThan(0)
    // Private key is JWK JSON
    const jwk = JSON.parse(kp.privateKey)
    expect(jwk.kty).toBe('EC')
    expect(jwk.crv).toBe('P-256')
  })

  it('generates unique key pairs each time', async () => {
    const kp1 = await generateKeyPair()
    const kp2 = await generateKeyPair()
    expect(kp1.publicKey).not.toBe(kp2.publicKey)
    expect(kp1.privateKey).not.toBe(kp2.privateKey)
  })

  it('generates a signing key pair (ECDSA P-256)', async () => {
    const kp = await generateSigningKeyPair()
    expect(kp.signingPublicKey).toBeTruthy()
    expect(kp.signingPrivateKey).toBeTruthy()
    const jwk = JSON.parse(kp.signingPrivateKey)
    expect(jwk.kty).toBe('EC')
    expect(jwk.crv).toBe('P-256')
  })

  it('generates a random AES-256-GCM channel key', async () => {
    const key = await generateChannelKey()
    expect(key.type).toBe('secret')
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
  })
})

describe('ECDH Key Exchange', () => {
  it('derives the same shared key from both sides', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()

    const sharedAB = await deriveSharedKey(alice.privateKey, bob.publicKey)
    const sharedBA = await deriveSharedKey(bob.privateKey, alice.publicKey)

    // Export both shared keys and compare
    const rawAB = await crypto.subtle.exportKey('raw', sharedAB)
    const rawBA = await crypto.subtle.exportKey('raw', sharedBA)

    expect(Buffer.from(rawAB).toString('hex')).toBe(Buffer.from(rawBA).toString('hex'))
  })

  it('derives different keys with different partners', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const charlie = await generateKeyPair()

    const sharedAB = await deriveSharedKey(alice.privateKey, bob.publicKey)
    const sharedAC = await deriveSharedKey(alice.privateKey, charlie.publicKey)

    const rawAB = await crypto.subtle.exportKey('raw', sharedAB)
    const rawAC = await crypto.subtle.exportKey('raw', sharedAC)

    expect(Buffer.from(rawAB).toString('hex')).not.toBe(Buffer.from(rawAC).toString('hex'))
  })
})

describe('publicKeyFromPrivate', () => {
  it('extracts the matching public key from a private key', async () => {
    const kp = await generateKeyPair()
    const derivedPub = await publicKeyFromPrivate(kp.privateKey)
    expect(derivedPub).toBe(kp.publicKey)
  })
})

describe('AES-256-GCM Encryption/Decryption', () => {
  it('encrypts and decrypts a message round-trip', async () => {
    const key = await generateChannelKey()
    const plaintext = 'Hello, encrypted world!'

    const { ciphertext, nonce } = await encrypt(key, plaintext)
    expect(ciphertext).toBeTruthy()
    expect(nonce).toBeTruthy()

    const decrypted = await decrypt(key, ciphertext, nonce)
    expect(decrypted).toBe(plaintext)
  })

  it('produces different ciphertexts for the same plaintext (random IV)', async () => {
    const key = await generateChannelKey()
    const plaintext = 'Same message'

    const enc1 = await encrypt(key, plaintext)
    const enc2 = await encrypt(key, plaintext)

    // Nonces and ciphertexts should be different
    expect(enc1.nonce).not.toBe(enc2.nonce)
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext)

    // Both should decrypt to the same plaintext
    expect(await decrypt(key, enc1.ciphertext, enc1.nonce)).toBe(plaintext)
    expect(await decrypt(key, enc2.ciphertext, enc2.nonce)).toBe(plaintext)
  })

  it('fails to decrypt with the wrong key', async () => {
    const key1 = await generateChannelKey()
    const key2 = await generateChannelKey()
    const { ciphertext, nonce } = await encrypt(key1, 'secret')

    await expect(decrypt(key2, ciphertext, nonce)).rejects.toThrow()
  })

  it('handles empty string', async () => {
    const key = await generateChannelKey()
    const { ciphertext, nonce } = await encrypt(key, '')
    const decrypted = await decrypt(key, ciphertext, nonce)
    expect(decrypted).toBe('')
  })

  it('handles unicode text', async () => {
    const key = await generateChannelKey()
    const plaintext = '🔐 Héllo Wörld! 你好世界 🌍'
    const { ciphertext, nonce } = await encrypt(key, plaintext)
    const decrypted = await decrypt(key, ciphertext, nonce)
    expect(decrypted).toBe(plaintext)
  })
})

describe('Key Export/Import', () => {
  it('exports and imports a channel key preserving functionality', async () => {
    const original = await generateChannelKey()
    const exported = await exportKey(original)
    expect(typeof exported).toBe('string')
    expect(exported.length).toBeGreaterThan(0)

    const imported = await importKey(exported)
    expect(imported.type).toBe('secret')

    // Verify the imported key can decrypt data encrypted with the original
    const { ciphertext, nonce } = await encrypt(original, 'test message')
    const decrypted = await decrypt(imported, ciphertext, nonce)
    expect(decrypted).toBe('test message')
  })

  it('exported key is base64 with consistent length', async () => {
    const key1 = await generateChannelKey()
    const key2 = await generateChannelKey()
    const exp1 = await exportKey(key1)
    const exp2 = await exportKey(key2)
    // AES-256 is 32 bytes → base64 is always 44 chars
    expect(exp1.length).toBe(44)
    expect(exp2.length).toBe(44)
    expect(exp1).not.toBe(exp2)
  })
})

describe('ECDSA Signing/Verification', () => {
  it('signs and verifies a message', async () => {
    const kp = await generateSigningKeyPair()
    const message = 'Sign this message'

    const signature = await sign(kp.signingPrivateKey, message)
    expect(signature).toBeTruthy()

    const valid = await verify(kp.signingPublicKey, message, signature)
    expect(valid).toBe(true)
  })

  it('rejects a tampered message', async () => {
    const kp = await generateSigningKeyPair()
    const signature = await sign(kp.signingPrivateKey, 'original message')

    const valid = await verify(kp.signingPublicKey, 'tampered message', signature)
    expect(valid).toBe(false)
  })

  it('rejects a signature from a different key', async () => {
    const kp1 = await generateSigningKeyPair()
    const kp2 = await generateSigningKeyPair()
    const signature = await sign(kp1.signingPrivateKey, 'message')

    const valid = await verify(kp2.signingPublicKey, 'message', signature)
    expect(valid).toBe(false)
  })
})

describe('HKDF Key Derivation', () => {
  it('derives deterministic output from the same inputs', async () => {
    const ikm = new Uint8Array(32)
    crypto.getRandomValues(ikm)
    const salt = new Uint8Array(16).buffer as ArrayBuffer
    const info = 'test-info'

    const result1 = await hkdf(ikm.buffer as ArrayBuffer, salt, info)
    const result2 = await hkdf(ikm.buffer as ArrayBuffer, salt, info)

    expect(Buffer.from(result1).toString('hex')).toBe(Buffer.from(result2).toString('hex'))
  })

  it('produces different output for different info strings', async () => {
    const ikm = new Uint8Array(32)
    crypto.getRandomValues(ikm)
    const salt = new Uint8Array(16).buffer as ArrayBuffer

    const result1 = await hkdf(ikm.buffer as ArrayBuffer, salt, 'info-a')
    const result2 = await hkdf(ikm.buffer as ArrayBuffer, salt, 'info-b')

    expect(Buffer.from(result1).toString('hex')).not.toBe(Buffer.from(result2).toString('hex'))
  })
})

describe('Sender Ratchet Chain', () => {
  it('derives a chain key from an epoch key and device ID', async () => {
    const epochKey = await generateChannelKey()
    const chainKey = await deriveChainKey(epochKey, 'device-123')

    expect(chainKey).toBeInstanceOf(ArrayBuffer)
    expect(chainKey.byteLength).toBe(32)
  })

  it('produces different chain keys for different devices', async () => {
    const epochKey = await generateChannelKey()
    const ck1 = await deriveChainKey(epochKey, 'device-1')
    const ck2 = await deriveChainKey(epochKey, 'device-2')

    expect(Buffer.from(ck1).toString('hex')).not.toBe(Buffer.from(ck2).toString('hex'))
  })

  it('derives a usable message key from a chain key', async () => {
    const epochKey = await generateChannelKey()
    const chainKey = await deriveChainKey(epochKey, 'device-1')
    const messageKey = await deriveMessageKey(chainKey)

    expect(messageKey.type).toBe('secret')
    // Verify the message key can encrypt/decrypt
    const { ciphertext, nonce } = await encrypt(messageKey, 'hello from ratchet')
    const plain = await decrypt(messageKey, ciphertext, nonce)
    expect(plain).toBe('hello from ratchet')
  })

  it('advances the chain key deterministically', async () => {
    const epochKey = await generateChannelKey()
    const ck0 = await deriveChainKey(epochKey, 'device-1')

    const ck1a = await advanceChainKey(ck0)
    const ck1b = await advanceChainKey(ck0)

    // Same input → same output
    expect(Buffer.from(ck1a).toString('hex')).toBe(Buffer.from(ck1b).toString('hex'))

    // Advancing again gives a different key
    const ck2 = await advanceChainKey(ck1a)
    expect(Buffer.from(ck2).toString('hex')).not.toBe(Buffer.from(ck1a).toString('hex'))
  })

  it('produces unique message keys for each ratchet step', async () => {
    const epochKey = await generateChannelKey()
    let chainKey = await deriveChainKey(epochKey, 'device-1')

    // Message keys are non-extractable, so test uniqueness via encryption output
    const ciphertexts: string[] = []
    const plaintext = 'test-uniqueness'
    for (let i = 0; i < 5; i++) {
      const mk = await deriveMessageKey(chainKey)
      const { ciphertext, nonce } = await encrypt(mk, plaintext)
      ciphertexts.push(`${nonce}:${ciphertext}`)
      // Verify each key can decrypt its own ciphertext
      const decrypted = await decrypt(mk, ciphertext, nonce)
      expect(decrypted).toBe(plaintext)
      chainKey = await advanceChainKey(chainKey)
    }

    // Ciphertexts should all be different (different keys + different IVs)
    const uniqueCiphertexts = new Set(ciphertexts)
    expect(uniqueCiphertexts.size).toBe(5)
  })

  it('sender and receiver derive the same message key for the same index', async () => {
    const epochKey = await generateChannelKey()
    const deviceId = 'device-sender'

    // Sender side: derive chain, advance to index 3
    let senderCK = await deriveChainKey(epochKey, deviceId)
    for (let i = 0; i < 3; i++) senderCK = await advanceChainKey(senderCK)
    const senderMK = await deriveMessageKey(senderCK)

    // Receiver side: independently derive chain, advance to index 3
    let receiverCK = await deriveChainKey(epochKey, deviceId)
    for (let i = 0; i < 3; i++) receiverCK = await advanceChainKey(receiverCK)
    const receiverMK = await deriveMessageKey(receiverCK)

    // The receiver can decrypt what the sender encrypted (proves same key)
    const { ciphertext, nonce } = await encrypt(senderMK, 'ratchet message')
    const plain = await decrypt(receiverMK, ciphertext, nonce)
    expect(plain).toBe('ratchet message')
  })
})

describe('Full E2EE Flow (crypto primitives)', () => {
  it('simulates key exchange + channel key distribution + message encryption', async () => {
    // Alice and Bob generate key pairs
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()

    // Alice generates a channel key
    const channelKey = await generateChannelKey()
    const channelKeyB64 = await exportKey(channelKey)

    // Alice encrypts the channel key for Bob using ECDH
    const sharedKeyAliceToBob = await deriveSharedKey(alice.privateKey, bob.publicKey)
    const { ciphertext: encChKey, nonce: chKeyNonce } = await encrypt(sharedKeyAliceToBob, channelKeyB64)

    // Bob decrypts the channel key
    const sharedKeyBobFromAlice = await deriveSharedKey(bob.privateKey, alice.publicKey)
    const decChKeyB64 = await decrypt(sharedKeyBobFromAlice, encChKey, chKeyNonce)
    const bobChannelKey = await importKey(decChKeyB64)

    // Both should derive the same chain keys
    const aliceCK = await deriveChainKey(channelKey, 'alice-device')
    const bobCK = await deriveChainKey(bobChannelKey, 'alice-device')
    expect(Buffer.from(aliceCK).toString('hex')).toBe(Buffer.from(bobCK).toString('hex'))

    // Alice encrypts a message using ratchet
    const aliceMK = await deriveMessageKey(aliceCK)
    const { ciphertext, nonce } = await encrypt(aliceMK, 'Hello Bob, this is encrypted!')

    // Bob derives the same message key and decrypts
    const bobMK = await deriveMessageKey(bobCK)
    const plaintext = await decrypt(bobMK, ciphertext, nonce)
    expect(plaintext).toBe('Hello Bob, this is encrypted!')
  })

  it('simulates signed + encrypted message with verification', async () => {
    const sigKP = await generateSigningKeyPair()
    const channelKey = await generateChannelKey()
    const deviceId = 'signer-device'

    // Sign the plaintext
    const message = 'This is authenticated'
    const signature = await sign(sigKP.signingPrivateKey, message)

    // Encrypt with ratchet
    const chainKey = await deriveChainKey(channelKey, deviceId)
    const messageKey = await deriveMessageKey(chainKey)
    const { ciphertext, nonce } = await encrypt(messageKey, message)

    // Receiver decrypts
    const recvChainKey = await deriveChainKey(channelKey, deviceId)
    const recvMK = await deriveMessageKey(recvChainKey)
    const decrypted = await decrypt(recvMK, ciphertext, nonce)

    // Verify signature
    const valid = await verify(sigKP.signingPublicKey, decrypted, signature)
    expect(valid).toBe(true)
    expect(decrypted).toBe(message)
  })
})
