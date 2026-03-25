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
