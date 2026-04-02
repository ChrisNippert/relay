// E2E encryption: X25519 key exchange + AES-256-GCM
// Uses the Web Crypto API

// Generate an X25519-style key pair using ECDH with P-256
// (Web Crypto doesn't support X25519 directly in all browsers, P-256 is widely supported)
export async function generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  )

  const pubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey)
  const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)

  return {
    publicKey: bufToBase64(pubRaw),
    privateKey: JSON.stringify(privJwk),
  }
}

// Derive a shared AES-256-GCM key from our private key + their public key
export async function deriveSharedKey(privateKeyJwk: string, publicKeyBase64: string): Promise<CryptoKey> {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(privateKeyJwk),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey']
  )

  const publicKey = await crypto.subtle.importKey(
    'raw',
    base64ToBuf(publicKeyBase64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )

  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )
}

// Generate a random AES-256-GCM key for a channel
export async function generateChannelKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )
}

// Export a channel key as base64
export async function exportKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key)
  return bufToBase64(raw)
}

// Import a channel key from base64
export async function importKey(base64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    base64ToBuf(base64),
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )
}

// Encrypt plaintext with AES-256-GCM, returns "nonce:ciphertext" both base64
export async function encrypt(key: CryptoKey, plaintext: string): Promise<{ ciphertext: string; nonce: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  )

  return {
    ciphertext: bufToBase64(encrypted),
    nonce: bufToBase64(iv.buffer as ArrayBuffer),
  }
}

// Decrypt ciphertext with AES-256-GCM
export async function decrypt(key: CryptoKey, ciphertext: string, nonce: string): Promise<string> {
  const iv = base64ToBuf(nonce)
  const data = base64ToBuf(ciphertext)

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  )

  return new TextDecoder().decode(decrypted)
}

// Encrypt an ArrayBuffer with AES-256-GCM, returns IV prepended to ciphertext
export async function encryptBlob(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)
  const result = new Uint8Array(iv.byteLength + encrypted.byteLength)
  result.set(iv)
  result.set(new Uint8Array(encrypted), iv.byteLength)
  return result.buffer as ArrayBuffer
}

// Decrypt an ArrayBuffer (IV-prepended ciphertext) with AES-256-GCM
export async function decryptBlob(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = data.slice(0, 12)
  const ciphertext = data.slice(12)
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, ciphertext)
}

// Derive the public key (base64) from a private key JWK string
export async function publicKeyFromPrivate(privateKeyJwk: string): Promise<string> {
  const jwk = JSON.parse(privateKeyJwk)
  const pubJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, key_ops: [] as string[], ext: true }
  const pubKey = await crypto.subtle.importKey(
    'jwk',
    pubJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  )
  const raw = await crypto.subtle.exportKey('raw', pubKey)
  return bufToBase64(raw)
}

// Generate an ECDSA P-256 signing key pair
export async function generateSigningKeyPair(): Promise<{ signingPublicKey: string; signingPrivateKey: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )
  const pubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey)
  const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
  return {
    signingPublicKey: bufToBase64(pubRaw),
    signingPrivateKey: JSON.stringify(privJwk),
  }
}

// Sign data with ECDSA P-256
export async function sign(privateKeyJwk: string, data: string): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(privateKeyJwk),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  )
  const encoded = new TextEncoder().encode(data)
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoded
  )
  return bufToBase64(signature)
}

// Verify an ECDSA P-256 signature
export async function verify(publicKeyBase64: string, data: string, signatureBase64: string): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey(
    'raw',
    base64ToBuf(publicKeyBase64),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )
  const encoded = new TextEncoder().encode(data)
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    base64ToBuf(signatureBase64),
    encoded
  )
}

// HKDF-SHA256: derive a key from input keying material with info string
export async function hkdf(ikm: ArrayBuffer, salt: ArrayBuffer, info: string, length: number = 32): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) },
    key,
    length * 8
  )
}

// Derive the initial chain key for a sender in a given epoch
// chainKey_0 = HKDF(epochRootKey, deviceId, "sender-chain-init")
export async function deriveChainKey(epochKey: CryptoKey, deviceId: string): Promise<ArrayBuffer> {
  const ikm = await crypto.subtle.exportKey('raw', epochKey)
  const salt = new TextEncoder().encode(deviceId).buffer as ArrayBuffer
  return hkdf(ikm, salt, 'sender-chain-init')
}

// Derive a message key from the current chain key
// messageKey = HKDF(chainKey, empty salt, "message-key")
export async function deriveMessageKey(chainKey: ArrayBuffer): Promise<CryptoKey> {
  const derived = await hkdf(chainKey, new Uint8Array(32).buffer as ArrayBuffer, 'message-key')
  return crypto.subtle.importKey('raw', derived, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

// Advance the chain key
// chainKey_{N+1} = HKDF(chainKey_N, empty salt, "chain-advance")
export async function advanceChainKey(chainKey: ArrayBuffer): Promise<ArrayBuffer> {
  return hkdf(chainKey, new Uint8Array(32).buffer as ArrayBuffer, 'chain-advance')
}

// Helpers
function bufToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

function base64ToBuf(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}
