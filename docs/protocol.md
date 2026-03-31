# Relay Protocol

Relay is a chat application with a REST API for data operations and a WebSocket for real-time messaging. This document covers the full protocol.

---

## Overview

```
┌─────────┐         HTTPS          ┌──────────┐        SQLite
│  Client  │ ◄────────────────────► │  Server  │ ◄────► relay.db
│ (React,  │                        │  (Go)    │
│  CLI…)   │ ◄── WSS (JSON) ──────►│          │──────► uploads/
└─────────┘    real-time msgs       └──────────┘
```

**Two transports:**
- **REST** (`/api/*`) — login, fetch history, manage servers/channels/friends, upload files
- **WebSocket** (`/api/ws`) — send messages, typing indicators, presence, voice signaling

All data is JSON. All IDs are UUIDs.

---

## 1. Authentication

### Register

```http
POST /api/auth/register
Content-Type: application/json

{"username": "alice", "email": "alice@example.com", "password": "secret", "display_name": "Alice"}
```

### Login

```http
POST /api/auth/login
Content-Type: application/json

{"email": "alice@example.com", "password": "secret"}
```

Both return:
```json
{"token": "eyJhbG...", "user": {"id": "uuid", "username": "alice", ...}}
```

### Using the token

- **REST**: `Authorization: Bearer <token>` header
- **WebSocket**: query param `?token=<token>`

Tokens are JWTs, valid 7 days.

---

## 2. Data Model

```
User
 ├── owns Servers
 ├── has Friendships (pending/accepted)
 └── has DM channels

Server
 ├── has Members (role: admin | member)
 ├── has Channels (type: text | voice)
 ├── has Invites (code, max_uses, expires_at)
 └── owner = admin who created it

Channel
 ├── belongs to a Server  (server channels)
 │   OR has no server_id  (DM channels)
 ├── has Messages
 └── has ChannelKeys (E2E encryption)

Message
 ├── belongs to Channel + User
 ├── has Attachments (uploaded files)
 ├── can reply to another Message (reply_to_id)
 ├── can be edited (tracked in edit history)
 └── can be soft-deleted
```

---

## 3. REST API

All endpoints require `Authorization: Bearer <token>` unless noted.

### Users

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/users/me` | — | Your profile |
| PUT | `/api/users/me` | `{display_name?, avatar_url?}` | Update profile |
| GET | `/api/users/{id}` | — | Get user by ID |
| GET | `/api/users/search?q=term` | — | Search by username/display name |
| PUT | `/api/users/me/public-key` | `{public_key}` | Set E2E public key |

### Friends

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/friends` | — | List friendships (pending + accepted) |
| POST | `/api/friends/request` | `{user_id}` | Send friend request |
| POST | `/api/friends/accept/{id}` | — | Accept request |
| DELETE | `/api/friends/{id}` | — | Remove friendship |

### Servers

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/servers` | `{name}` | Create server (auto-creates `general` text + `General` voice channels) |
| GET | `/api/servers` | — | List your servers |
| GET | `/api/servers/{id}` | — | Get server details |
| PUT | `/api/servers/{id}` | `{name?, icon_url?}` | Update (admin only) |
| DELETE | `/api/servers/{id}` | — | Delete (owner only) |
| POST | `/api/servers/{id}/join` | — | Join server |
| POST | `/api/servers/{id}/leave` | — | Leave server |
| GET | `/api/servers/{id}/members` | — | List members |
| PUT | `/api/servers/{sid}/members/{uid}/role` | `{role}` | Change member role (admin only) |

### Invites

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/servers/{id}/invites` | `{max_uses?, expires_in?}` | Create invite |
| GET | `/api/servers/{id}/invites` | — | List server invites |
| POST | `/api/invites/{code}/join` | — | Join via invite code |
| DELETE | `/api/invites/{id}` | — | Delete invite |

### Channels

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/servers/{id}/channels` | — | List channels |
| POST | `/api/servers/{id}/channels` | `{name, type}` | Create channel (admin only). Type: `text` or `voice` |
| PUT | `/api/channels/{id}` | `{name}` | Rename channel |
| DELETE | `/api/channels/{id}` | — | Delete channel (admin only) |
| PUT | `/api/servers/{id}/channels/positions` | `{positions: {channelId: number}}` | Reorder channels |

### Direct Messages

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/dm` | `{user_id}` | Create/get DM channel with a user |
| GET | `/api/dm` | — | List your DM channels |
| GET | `/api/dm/{id}/participants` | — | Get DM participant user IDs |

DMs are just channels with no `server_id`. Creating a DM with the same user twice returns the existing channel.

### Messages

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/channels/{id}/messages?limit=50&offset=0` | — | Fetch history (newest first, max 100) |
| PUT | `/api/messages/{id}` | `{content}` | Edit message (owner only) |
| DELETE | `/api/messages/{id}` | — | Soft-delete message (owner only) |
| GET | `/api/messages/{id}/history` | — | Get edit history |

**Messages are sent via WebSocket**, not REST (see section 4).

### Files

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/upload` | multipart `file` field | Upload file (max 50 MB) |
| GET | `/api/files/{id}` | — | Download file |

Allowed types: jpg, jpeg, png, gif, webp, mp4, webm, mp3, ogg, wav, pdf, txt, zip.

### E2E Encryption Keys

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/channels/{id}/keys` | — | Get encrypted channel keys |
| POST | `/api/channels/{id}/keys` | `{encrypted_key}` | Set your encrypted key for a channel |

### Voice

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/channels/{id}/voice-users` | List users in a voice channel |

### Other

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth required) |
| GET | `/api/og?url=...` | Fetch OpenGraph metadata for a URL |

---

## 4. WebSocket Protocol

### Connection

```
wss://host:port/api/ws?token=<jwt>
```

All messages use a JSON envelope:

```json
{"type": "message_type", "payload": {...}}
```

### Message Types

#### Chat Messages

**Send** (client → server):
```json
{
  "type": "chat_message",
  "payload": {
    "channel_id": "uuid",
    "content": "Hello!",
    "nonce": "client-generated-id",
    "type": "text",
    "attachment_ids": ["uuid", "uuid"],
    "reply_to_id": "uuid"
  }
}
```

Only `channel_id` is required. `content` or `attachment_ids` must be non-empty. `nonce` is optional (for deduplication). `reply_to_id` is optional.

**Receive** (server → all channel members, including sender):
```json
{
  "type": "chat_message",
  "payload": {
    "id": "uuid",
    "channel_id": "uuid",
    "user_id": "uuid",
    "content": "Hello!",
    "nonce": "client-generated-id",
    "type": "text",
    "created_at": "2026-01-01T00:00:00Z",
    "updated_at": "2026-01-01T00:00:00Z",
    "author": {"id": "uuid", "username": "alice", "display_name": "Alice", "status": "online"},
    "attachments": []
  }
}
```

The sender gets their own message back (for confirmation + server-assigned ID).

#### Edit Message

**Send** (client → server):
```json
{"type": "edit_message", "payload": {"message_id": "uuid", "content": "updated text"}}
```

**Receive** (server → channel members):
```json
{"type": "message_edited", "payload": {"id": "uuid", "content": "updated text", "edited": true, ...}}
```

Only the message author can edit.

#### Delete Message

**Send** (client → server):
```json
{"type": "delete_message", "payload": {"message_id": "uuid"}}
```

**Receive** (server → channel members):
```json
{"type": "message_deleted", "payload": {"id": "uuid", "deleted": true, ...}}
```

Only the message author can delete. Deletion is soft (content cleared, `deleted` flag set).

#### Typing Indicators

**Send**: `{"type": "typing_start", "payload": {"channel_id": "uuid"}}`  
**Send**: `{"type": "typing_stop", "payload": {"channel_id": "uuid"}}`

**Receive** (other channel members, not sender):
```json
{"type": "typing_start", "payload": {"channel_id": "uuid", "user_id": "uuid"}}
```

#### Presence

Automatic — no client action needed.

**Receive** (broadcast to all connected users):
```json
{"type": "presence", "payload": {"user_id": "uuid", "status": "online"}}
{"type": "presence", "payload": {"user_id": "uuid", "status": "offline"}}
```

Sent when a user's first connection opens or last connection closes.

#### Voice Channels

**Join**: `{"type": "voice_join", "payload": {"channel_id": "uuid"}}`  
**Leave**: `{"type": "voice_leave", "payload": {"channel_id": "uuid"}}`

**Receive** (channel members):
```json
{"type": "voice_state", "payload": {"channel_id": "uuid", "user_ids": ["uuid", "uuid"]}}
```

On disconnect, the server auto-removes the user from all voice channels and broadcasts updated state.

#### WebRTC Call Signaling

The server relays WebRTC signals between peers. Media flows peer-to-peer, not through the server.

**Send** (client → server, forwarded to target):
```json
{"type": "call_offer",     "payload": {"target_user_id": "uuid", "channel_id": "uuid", "signal": {SDP}}}
{"type": "call_answer",    "payload": {"target_user_id": "uuid", "channel_id": "uuid", "signal": {SDP}}}
{"type": "ice_candidate",  "payload": {"target_user_id": "uuid", "channel_id": "uuid", "signal": {ICE}}}
{"type": "call_end",       "payload": {"target_user_id": "uuid", "channel_id": "uuid"}}
```

**Receive** (target user):
```json
{"type": "call_offer",     "payload": {"from_user_id": "uuid", "channel_id": "uuid", "signal": {SDP}}}
{"type": "call_answer",    "payload": {"from_user_id": "uuid", "channel_id": "uuid", "signal": {SDP}}}
{"type": "ice_candidate",  "payload": {"from_user_id": "uuid", "channel_id": "uuid", "signal": {ICE}}}
{"type": "call_end",       "payload": {"from_user_id": "uuid", "channel_id": "uuid"}}
```

Note: `target_user_id` (outgoing) becomes `from_user_id` (incoming).

---

## 5. Connection Details

| Setting | Value |
|---------|-------|
| Ping interval | 54 seconds |
| Pong timeout | 60 seconds |
| Max message size | 64 KB |
| Send buffer | 256 messages |
| Multi-device | Yes — multiple WS connections per user |
| Reconnection | Client should reconnect after ~3 seconds on disconnect |

---

## 6. Quick Start (Minimal Client)

A bare-bones text client needs only 4 steps:

```
1. POST /api/auth/login          → get token
2. GET  /api/servers             → pick a server
   GET  /api/servers/{id}/channels → pick a channel
3. Connect WSS with token
4. Send/receive {"type": "chat_message", ...} on the WebSocket
```

**Example with curl + websocat:**

```bash
# Login
TOKEN=$(curl -sk -X POST https://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@user.com","password":"password"}' | jq -r .token)

# Find a channel
SERVER=$(curl -sk -H "Authorization: Bearer $TOKEN" https://localhost:8080/api/servers | jq -r '.[0].id')
CHANNEL=$(curl -sk -H "Authorization: Bearer $TOKEN" "https://localhost:8080/api/servers/$SERVER/channels" | jq -r '.[0].id')

# Chat
echo '{"type":"chat_message","payload":{"channel_id":"'$CHANNEL'","content":"Hello!"}}' | \
  websocat -k "wss://localhost:8080/api/ws?token=$TOKEN"
```

---

## 7. All WebSocket Message Types (Summary)

| Type | Direction | Purpose |
|------|-----------|---------|
| `chat_message` | client → server | Send a message |
| `chat_message` | server → client | New message received |
| `edit_message` | client → server | Edit own message |
| `message_edited` | server → client | Message was edited |
| `delete_message` | client → server | Delete own message |
| `message_deleted` | server → client | Message was deleted |
| `typing_start` | both | User started typing |
| `typing_stop` | both | User stopped typing |
| `presence` | server → client | User online/offline |
| `voice_join` | client → server | Join voice channel |
| `voice_leave` | client → server | Leave voice channel |
| `voice_state` | server → client | Updated list of voice users |
| `call_offer` | both | WebRTC offer (SDP) |
| `call_answer` | both | WebRTC answer (SDP) |
| `ice_candidate` | both | WebRTC ICE candidate |
| `call_end` | both | End a call |
| `key_request` | both | Request channel key (E2E) |
| `channel_keys_updated` | server → client | New E2E key available |

---

## 8. End-to-End Encryption (E2EE)

Relay supports optional per-channel E2EE. When enabled, the **server never sees plaintext** — it only stores opaque ciphertext and encrypted key blobs. Encryption is channel-scoped and epoch-based, providing forward secrecy when keys are rotated.

### 8.1 Cryptographic Primitives

| Purpose | Algorithm | Details |
|---------|-----------|---------|
| Device key exchange | ECDH P-256 | Each device generates a key pair on registration |
| Message signing | ECDSA P-256 + SHA-256 | Each device signs messages it sends |
| Channel key (epoch root) | AES-256-GCM | Random symmetric key per channel per epoch |
| Sender ratchet | HKDF-SHA256 hash chain | Per-sender chain derived from epoch key; advances every message |
| Message key | AES-256-GCM | Derived from current ratchet state; unique per message |
| Key wrapping | ECDH shared secret → AES-256-GCM | Channel key encrypted to each device individually |
| Nonce | 96-bit random IV | Fresh per encryption operation |

All keys and ciphertexts use **base64** encoding on the wire.

### 8.2 Device Identity

Each client (browser tab, CLI session, etc.) registers as a **device** on first login. A device has:

- **ECDH P-256 key pair** — used for key exchange (deriving shared secrets to encrypt/decrypt channel keys)
- **ECDSA P-256 signing key pair** — used to sign message content

The public halves are uploaded to the server; private keys **never leave the device**.

```
POST /api/devices
{
  "public_key": "<base64 ECDH public key>",
  "signing_key": "<base64 ECDSA public key>",
  "name": "Firefox on laptop"
}
→ 201 {"id": "device-uuid", "user_id": "user-uuid", ...}
```

A user can have multiple devices. All devices for all members of a channel can be queried:

```
GET /api/channels/{id}/devices
→ [{"id": "dev-uuid", "user_id": "user-uuid", "public_key": "...", "signing_key": "...", ...}, ...]
```

### 8.3 Key Model — Epochs + Sender Ratchet

Channel encryption uses an **epoch-based** key model with a **per-sender hash ratchet** for per-message forward secrecy.

#### Epochs

- Each channel has an integer **epoch** counter starting at 0.
- Each epoch has its own random **AES-256-GCM epoch root key**.
- The epoch root key is encrypted individually for each device using ECDH (sender's private key + recipient device's public key → shared secret → AES-256-GCM wrapping).
- Key entries are immutable: once `(channel_id, device_id, epoch)` is stored, it cannot be overwritten.
- Messages embed the epoch they were encrypted under, so old messages remain decryptable with old epoch keys.

#### Sender Ratchet (per-message forward secrecy)

Within a single epoch, each **sending device** maintains a symmetric hash-chain ratchet so that every message is encrypted with a unique key. Compromising one message key does not reveal past or future messages within the same epoch.

```
chainKey_0  = HKDF-SHA256(epochRootKey, deviceId, "sender-chain-init")

For message N:
  messageKey_N = HKDF-SHA256(chainKey_N, "message-key")
  chainKey_N+1 = HKDF-SHA256(chainKey_N, "chain-advance")
  // chainKey_N is deleted after deriving both values
```

- `chainKey_0` is deterministically derived from the epoch root key + the sender's device ID, so every recipient can independently compute the same chain.
- The sender includes a monotonically increasing **chain index** in each message so recipients can fast-forward the ratchet if messages arrive out of order.
- Recipients SHOULD cache a small window of future message keys (e.g. 256) to handle reordering, and MUST delete message keys after use.
- When the epoch rotates, every sender's chain resets from the new epoch root key.

```
 Epoch N                              Epoch N+1
 ───────                              ─────────
 chainKey_0 ──► msgKey_0              chainKey_0' ──► msgKey_0'
     │                                    │
 chainKey_1 ──► msgKey_1              chainKey_1' ──► msgKey_1'
     │                                    │
 chainKey_2 ──► msgKey_2                 ...
     │
    ...
```

#### Encrypted Key Blob Format

```
pk.<base64 sender public key>:<base64 nonce>.<base64 ciphertext>
```

The sender's public key is embedded so the recipient can derive the same shared secret using their own private key.

#### DB Schema

```sql
channel_keys (
  channel_id  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  epoch       INTEGER NOT NULL DEFAULT 0,
  encrypted_key TEXT NOT NULL,   -- the blob above
  created_at  DATETIME,
  PRIMARY KEY (channel_id, device_id, epoch)
)
```

### 8.4 Encrypted Message Format

Messages with E2EE enabled are stored as opaque strings on the server:

```
ENC:<epoch>:<chainIndex>:<senderDeviceId>:<base64 nonce>:<base64 ECDSA signature>:<base64 AES-GCM ciphertext>
```

| Field | Description |
|-------|-------------|
| `ENC:` | Prefix — tells clients this is encrypted |
| `epoch` | Integer — which epoch root key to use |
| `chainIndex` | Integer — position in the sender's ratchet chain |
| `senderDeviceId` | UUID — identifies which device's ratchet chain to follow |
| `nonce` | 12-byte random IV (base64) |
| `signature` | ECDSA-SHA256 signature of the **plaintext** (base64), or empty |
| `ciphertext` | AES-256-GCM encrypted with the derived `messageKey` (base64) |

The `key_epoch` field on the message JSON mirrors the epoch so the server can store it without parsing the ciphertext.

**Decryption steps:**
1. Look up the epoch root key for `epoch`
2. Derive `chainKey_0` = HKDF(epochRootKey, senderDeviceId, "sender-chain-init")
3. Advance the chain `chainIndex` times to get `chainKey_N`
4. Derive `messageKey_N` = HKDF(chainKey_N, "message-key")
5. AES-256-GCM decrypt using `messageKey_N` + `nonce`
6. Delete `messageKey_N` (and all prior chain keys) after use

### 8.5 Lifecycle Flows

#### 8.5.1 Enabling Encryption on a Channel

When an admin enables E2EE on a channel, the client generates a random channel key at epoch 0 and encrypts it **only for the admin's own devices**. Other members receive the key when they self-rotate on join (§8.5.3).

```
┌──────────┐                           ┌──────────┐
│  Admin   │                           │  Server  │
│ (Device) │                           │          │
└────┬─────┘                           └────┬─────┘
     │                                      │
     │  1. Generate random AES-256-GCM key  │
     │     (channelKey) at epoch=0          │
     │                                      │
     │  2. GET /channels/{id}/devices       │
     │ ───────────────────────────────────► │
     │                                      │
     │  3. List of all member devices       │
     │ ◄─────────────────────────────────── │
     │                                      │
     │  4. For each of MY OWN devices:      │
     │     • ECDH(myPrivKey, devicePubKey)  │
     │       → sharedKey                    │
     │     • AES-GCM-Encrypt(sharedKey,     │
     │       channelKeyBase64) → blob       │
     │                                      │
     │  5. POST /channels/{id}/keys         │
     │     {encrypted_key: blob,            │
     │      device_id: <own-dev>,           │
     │      epoch: 0}                       │
     │ ───────────────────────────────────► │
     │     (repeated per own device)        │
     │                                      │
     │  6. 204 No Content                   │
     │ ◄─────────────────────────────────── │
     │                                      │
```

#### 8.5.2 Sending an Encrypted Message

```
┌──────────┐                           ┌──────────┐                    ┌──────────┐
│  Alice   │                           │  Server  │                    │   Bob    │
│ (Device) │                           │          │                    │ (Device) │
└────┬─────┘                           └────┬─────┘                    └────┬─────┘
     │                                      │                               │
     │  1. Look up current epoch (cached    │                               │
     │     or GET /channels/{id}/epoch)     │                               │
     │                                      │                               │
     │  2. Get channel key for epoch        │                               │
     │     (cached or fetch + decrypt)      │                               │
     │                                      │                               │
     │  3. Sign plaintext with ECDSA        │                               │
     │     signingKey → signature           │                               │
     │                                      │                               │
     │  4. AES-256-GCM encrypt plaintext    │                               │
     │     → nonce + ciphertext             │                               │
     │                                      │                               │
     │  5. WS: chat_message                 │                               │
     │     content: "ENC:0:<nonce>:         │                               │
     │       <signature>:<ciphertext>"      │                               │
     │     key_epoch: 0                     │                               │
     │ ───────────────────────────────────► │                               │
     │                                      │  6. WS: chat_message          │
     │                                      │     (relayed verbatim)        │
     │                                      │ ─────────────────────────────►│
     │                                      │                               │
     │                                      │     7. Parse ENC: prefix      │
     │                                      │     8. Extract epoch from msg │
     │                                      │     9. Fetch channel key for  │
     │                                      │        that epoch (cached or  │
     │                                      │        GET + ECDH decrypt)    │
     │                                      │    10. AES-256-GCM decrypt    │
     │                                      │        → plaintext            │
     │                                      │    11. (Optional) verify      │
     │                                      │        ECDSA signature        │
     │                                      │                               │
```

#### 8.5.3 New Member Joining — Self-Rotation

When a new member joins an encrypted channel, they **immediately rotate the key themselves** — no need to wait for an existing member to be online. The new member generates a new epoch key, wraps it for every device in the channel, and uploads it. They can start sending right away.

This preserves **forward secrecy**: the new member only has the key from their join epoch onward and cannot decrypt older messages.

```
┌──────────┐                           ┌──────────┐                    ┌──────────┐
│   Bob    │                           │  Server  │                    │  Alice   │
│  (new)   │                           │          │                    │(existing)│
└────┬─────┘                           └────┬─────┘                    └────┬─────┘
     │                                      │                               │
     │  1. Join encrypted channel,          │                               │
     │     no key found for my device       │                               │
     │                                      │                               │
     │  2. GET /channels/{id}/epoch         │                               │
     │ ────────────────────────────────────►│                               │
     │     → currentEpoch = N               │                               │
     │ ◄────────────────────────────────────│                               │
     │                                      │                               │
     │  3. Generate new AES-256-GCM key     │                               │
     │     newEpoch = N + 1                 │                               │
     │                                      │                               │
     │  4. GET /channels/{id}/devices       │                               │
     │ ────────────────────────────────────►│                               │
     │     → all devices (Alice's + Bob's)  │                               │
     │ ◄────────────────────────────────────│                               │
     │                                      │                               │
     │  5. For EVERY device of EVERY        │                               │
     │     current member (inc. self):      │                               │
     │     • ECDH(myPrivKey, devPubKey)     │                               │
     │       → sharedKey                    │                               │
     │     • AES-GCM wrap newKey → blob     │                               │
     │                                      │                               │
     │  6. POST /channels/{id}/keys         │                               │
     │     {encrypted_key, device_id,       │                               │
     │      epoch: N+1}                     │                               │
     │     (repeated per device)            │                               │
     │ ────────────────────────────────────►│                               │
     │                                      │  7. WS: channel_keys_updated  │
     │                                      │     {channel_id, epoch: N+1}  │
     │                                      │ ─────────────────────────────►│
     │                                      │                               │
     │  8. Bob can now send + receive       │                               │
     │     messages at epoch N+1            │                               │
     │     immediately — no waiting.        │                               │
     │                                      │     9. Alice receives the     │
     │                                      │        notification, fetches  │
     │                                      │        + decrypts epoch N+1   │
     │                                      │        key, continues as      │
     │                                      │        normal.                │
     │                                      │                               │
```

The old `key_request` WebSocket message is kept as a **fallback** for edge cases (e.g. a device that was already a member but lost its local key store). In the normal join flow, no `key_request` is needed — the joining client acts unilaterally.

**Race condition handling:** If two members join simultaneously and both try to create epoch N+1, the server's `INSERT OR IGNORE` on `(channel_id, device_id, epoch)` means the first writer wins per-device. The second joiner detects that epoch N+1 already has entries, fetches those keys instead, and either uses them or bumps to N+2.

#### 8.5.4 Key Rotation (Member Leave / Admin-Initiated / Periodic)

Key rotation generates a new epoch key and distributes it to all current devices. Triggers include:

- **Member departure** — any remaining member rotates. The departed member's devices are no longer in the channel device list, so they don't receive the new epoch key.
- **Admin-initiated** — a channel or server admin can force a rotation at any time (e.g. to recover from a suspected compromise or to override a malicious rotation). The admin's client sends `rotate_channel_key` over the WebSocket, which the server validates against admin role.
- **Periodic** — clients MAY rotate after a configurable interval (e.g. every 24h or every 1000 messages) for hygiene.

```
┌──────────┐                           ┌──────────┐
│  Alice   │                           │  Server  │
│ (admin)  │                           │          │
└────┬─────┘                           └────┬─────┘
     │                                      │
     │  1. Detect trigger (member left,     │
     │     admin button, or timer)          │
     │                                      │
     │  2. currentEpoch = GET               │
     │     /channels/{id}/epoch             │
     │ ───────────────────────────────────► │
     │ ◄─────────────────────────────────── │
     │                                      │
     │  3. Generate new AES-256-GCM key     │
     │     newEpoch = currentEpoch + 1      │
     │                                      │
     │  4. GET /channels/{id}/devices       │
     │ ───────────────────────────────────► │
     │ ◄─────────────────────────────────── │
     │     (departed member's devices are   │
     │      no longer in the list)          │
     │                                      │
     │  5. For each remaining device:       │
     │     ECDH wrap → POST key             │
     │ ───────────────────────────────────► │
     │                                      │
     │  6. Server notifies all members:     │
     │     WS: channel_keys_updated         │
     │     {channel_id, epoch: newEpoch}    │
     │                                      │
```

**Admin override:** If an admin suspects a malicious rotation (see §8.9), they can rotate again. Since the admin distributes the new key to all legitimate devices and epoch keys are immutable once written, the malicious client's epoch becomes stale. All honest clients move to the admin's new epoch.

#### 8.5.5 Offline Key Delivery

Keys are distributed by encrypting the epoch root key for each device and `POST`ing it to the server. The server **stores these encrypted blobs persistently** — it does not need the target device to be online. When the device reconnects:

1. On WebSocket connect, the server sends any pending `channel_keys_updated` notifications that occurred while the device was offline.
2. The client calls `GET /channels/{id}/keys` for each channel and checks for new epoch entries it doesn't have locally.
3. The client ECDH-decrypts any new key blobs and caches them.

This means key distribution works even if the target device is offline for days. The encrypted key blobs sit in the `channel_keys` table until the device fetches them. No real-time WebSocket is required for key delivery — it just speeds up the notification.

```
┌───────────┐                         ┌──────────┐
│  Alice     │                        │  Server  │
│  (offline) │                        │          │
└────┬───────┘                        └────┬─────┘
     │                                     │
     ×  (device offline — Bob rotates      │
     ×   key, POSTs encrypted key          │
     ×   for Alice's device at epoch N+1)  │
     │                                     │
     │  ── reconnects ──                   │
     │                                     │
     │  1. WSS connect                     │
     │ ──────────────────────────────────► │
     │                                     │
     │  2. WS: channel_keys_updated        │
     │     {channel_id, epoch: N+1}        │
     │ ◄────────────────────────────────── │
     │                                     │
     │  3. GET /channels/{id}/keys         │
     │ ──────────────────────────────────► │
     │ ◄────────────────────────────────── │
     │     (finds new entry at epoch N+1   │
     │      for this device_id)            │
     │                                     │
     │  4. ECDH decrypt → epoch N+1 key    │
     │     Cache locally, resume normal    │
     │     encrypt/decrypt.                │
     │                                     │
```

#### 8.5.6 Device Approval (New Device Key Distribution)

New devices are treated as **untrusted by default**. When a user registers a new device, it does **not** automatically receive channel keys. Instead, the user's existing devices must explicitly approve the new device.

```
┌──────────┐    ┌──────────┐                  ┌──────────┐
│  Alice's  │   │  Alice's │                  │  Server  │
│ Device A  │   │ Device B │                  │          │
│ (trusted) │   │  (new)   │                  │          │
└────┬──────┘   └────┬─────┘                  └────┬─────┘
     │               │                             │
     │               │  1. Register device         │
     │               │     POST /api/devices       │
     │               │ ──────────────────────────► │
     │               │     → 201 {id, ...}         │
     │               │ ◄────────────────────────── │
     │               │                             │
     │               │  2. WS: device_key_request  │
     │               │     {channel_id: "..."}     │
     │               │ ──────────────────────────► │
     │               │                             │
     │  3. WS: device_key_request                  │
     │     {device_id: B, channel_id,              │
     │      device_name: "Chrome on phone",        │
     │      public_key: "..."}                     │
     │ ◄────────────────────────────────────────── │
     │                                             │
     │  4. Alice sees prompt on Device A:          │
     │     "Your new device 'Chrome on phone'      │
     │      is requesting channel keys.            │
     │      Approve or Deny?"                      │
     │                                             │
     │  5a. APPROVE: Wrap epoch key for            │
     │      Device B's public key,                 │
     │      POST /channels/{id}/keys              │
     │      {device_id: B, epoch: N, ...}          │
     │ ──────────────────────────────────────────► │
     │                                             │
     │               │  6. WS: channel_keys_updated│
     │               │     {channel_id, epoch: N}  │
     │               │ ◄────────────────────────── │
     │               │                             │
     │               │  7. Fetch + decrypt key,    │
     │               │     now fully operational   │
     │               │                             │
     │  5b. DENY: No keys sent. Device B           │
     │      remains unable to decrypt.             │
     │      (Can optionally revoke device:         │
     │       DELETE /api/devices/{B})              │
     │                                             │
```

**Why this matters:**
- If Device B was registered by an attacker who stole the session token, the real user sees the approval prompt and can deny it.
- Compromised devices can't silently join and start reading encrypted channels.
- The approval is per-channel — the user can approve a device for some channels and not others.

**Fallback:** If no other device is online/available to approve, the user can approve from any of their trusted devices when they next come online (the `device_key_request` is stored server-side like any other pending notification).

| WS Type | Direction | Payload | Description |
|---------|-----------|---------|-------------|
| `device_key_request` | client → server | `{channel_id}` | New device requesting keys |
| `device_key_request` | server → user's other devices | `{device_id, channel_id, device_name, public_key}` | Prompt for approval |

### 8.6 API Reference (E2E-specific)

#### REST

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/devices` | `{public_key, signing_key, name}` | Register a device |
| GET | `/api/devices` | — | List your devices |
| GET | `/api/users/{id}/devices` | — | List another user's devices |
| DELETE | `/api/devices/{id}` | — | Remove a device |
| GET | `/api/channels/{id}/devices` | — | All devices for channel members |
| GET | `/api/channels/{id}/keys` | — | All encrypted key entries for a channel |
| POST | `/api/channels/{id}/keys` | `{encrypted_key, device_id, epoch}` | Set encrypted key for a device+epoch |
| GET | `/api/channels/{id}/epoch` | — | Get current (max) epoch |
| DELETE | `/api/channels/{id}/keys` | — | Delete all keys (disable E2E) |

#### WebSocket

| Type | Direction | Payload | Description |
|------|-----------|---------|-------------|
| `key_request` | client → server | `{channel_id}` | Fallback: "I need the channel key" (legacy/edge-case) |
| `key_request` | server → others | `{channel_id, user_id}` | Relayed to channel members (triggers rotation by a peer) |
| `channel_keys_updated` | server → client | `{channel_id, epoch}` | New key available — refetch |
| `device_key_request` | client → server | `{channel_id}` | New device requesting keys from user's other devices |
| `device_key_request` | server → user's devices | `{device_id, channel_id, device_name, public_key}` | Approval prompt for key sharing |
| `rotate_channel_key` | client → server | `{channel_id}` | Admin-only: force epoch rotation (server validates role) |

### 8.7 Security Properties

| Property | How it's achieved |
|----------|-------------------|
| **Confidentiality** | Messages encrypted with AES-256-GCM; server stores only ciphertext |
| **Authenticity** | Messages signed with sender's ECDSA device key |
| **Forward secrecy (epoch)** | Key rotation on member join/leave — new epoch key is independent |
| **Forward secrecy (message)** | Sender ratchet — each message uses a unique derived key; old chain keys are deleted |
| **Post-compromise recovery** | Rotating to a new epoch locks out the attacker from new messages |
| **Immediate join** | New members self-rotate the epoch key — no waiting for online peers |
| **Multi-device support** | Each device has its own ECDH key pair; channel keys are wrapped per-device |
| **Device approval** | New devices must be approved by existing trusted devices before receiving keys |
| **Offline key delivery** | Encrypted key blobs stored server-side; devices fetch on reconnect |
| **Admin override** | Admins can force-rotate keys to recover from malicious rotations |
| **Server-blind** | Server relays encrypted blobs — it cannot derive channel keys or read messages |
| **Immutable key entries** | `INSERT OR IGNORE` — a key entry for (channel, device, epoch) cannot be tampered with after creation |

### 8.8 Threat Model & Limitations

- **Trust on first use (TOFU)**: Device public keys are not independently verified (no QR-code / safety-number comparison yet). A compromised server could substitute a device's public key.
- **Metadata visible**: The server sees who sends messages to which channels, timestamps, and message sizes. Only content is encrypted.
- **Ratchet is sender-only**: Unlike Signal's Double Ratchet, there is no DH ratchet step between each message pair. Forward secrecy within an epoch is per-sender (hash chain), not per-conversation-turn. Full epoch rotation is needed to recover from a compromised epoch root key.
- **No key verification UI**: There's currently no way for users to manually verify device fingerprints out-of-band.

### 8.9 Malicious Client Mitigations

Since any channel member can initiate epoch rotations and submit encrypted keys, a malicious or compromised client can attempt several attacks. Here's each attack vector and its mitigation:

#### 8.9.1 Epoch Rotation Flooding

**Attack:** A malicious client rapidly rotates the epoch (N → N+1 → N+2 → ...) to cause churn, waste bandwidth, and confuse other clients.

**Mitigations:**
- **Server-side rate limit:** The server limits epoch rotations per channel to e.g. 1 per 30 seconds per user. Excess attempts are rejected with `429 Too Many Requests`.
- **Admin override:** An admin can rotate the key (§8.5.4) and then kick/ban the offending member, which also removes their devices from future epoch distributions.
- **Epoch monotonicity:** Clients always use the highest epoch they have a key for. Rapid rotations don't break anything — they just advance the epoch counter. Clients that fall behind simply fetch the latest key on their next message.

#### 8.9.2 Key Withholding

**Attack:** A malicious client rotates the epoch but deliberately skips distributing the key to some devices, locking those users out of the conversation.

**Mitigations:**
- **Detection:** If a client receives a `channel_keys_updated` notification but can't find a key entry for its own device at the new epoch, it knows a key was withheld.
- **Recovery:** The affected client sends `key_request` as a fallback. Any honest peer with the key responds by redistributing it to the missing devices. If the key was genuinely withheld from everyone, an admin performs a fresh rotation.
- **Admin rotation:** Admins always have the authority to overwrite a malicious epoch by rotating to epoch N+2 and distributing to all devices properly.

#### 8.9.3 Fake Key Injection

**Attack:** A malicious client distributes a key blob that encrypts to the wrong symmetric key, so decryption produces garbage.

**Mitigations:**
- **Immutable entries:** `INSERT OR IGNORE` means the first valid key written to `(channel, device, epoch)` wins. A malicious client cannot overwrite a legitimate key that was already stored.
- **Self-generated keys are self-consistent:** When a client rotates, the key it generates is used by all recipients. If the key is corrupted, messages encrypted under it will fail AES-GCM authentication (GCM detects tampering), and clients will flag the epoch as broken.
- **Fallback:** Clients that detect decryption failures on a new epoch can refuse to advance and request an admin rotation.

#### 8.9.4 Signature Forgery / Impersonation

**Attack:** A malicious client sends messages signed with someone else's device key, or with no signature.

**Mitigations:**
- **Signature verification:** Recipients verify the ECDSA signature against the `senderDeviceId`'s known signing public key. Mismatches are flagged to the user (e.g. "⚠ unverified message").
- **Missing signatures:** Messages with empty signatures are displayed with a visual indicator. Clients SHOULD treat unsigned messages in an E2E channel as suspicious.
- **Device signing keys are registered at device creation** and stored server-side. A malicious client cannot register a signing key for someone else's device.

#### 8.9.5 Rogue Device Registration

**Attack:** An attacker who steals a session token registers a new device to silently join encrypted channels.

**Mitigations:**
- **Device approval (§8.5.6):** New devices do not automatically receive channel keys. The user's existing trusted devices must explicitly approve the new device.
- **Device list visibility:** Users can view all their registered devices (`GET /api/devices`) and revoke any they don't recognize (`DELETE /api/devices/{id}`).
- **Revocation cascades:** Deleting a device also deletes its key entries (`ON DELETE CASCADE`), and an epoch rotation should follow to lock it out of future messages.

#### 8.9.6 Replay Attacks

**Attack:** An attacker (or the server) replays an old encrypted message.

**Mitigations:**
- **Ratchet chain index:** Each message includes `(epoch, senderDeviceId, chainIndex)`. Recipients track the highest chain index seen per sender per epoch. A replayed message will have a duplicate or lower index and is rejected.
- **AES-GCM nonce uniqueness:** Even if a message is replayed byte-for-byte, clients that track seen nonces per epoch can detect duplicates.

### 8.10 Concurrency & Ordering

Group chat with multiple senders, epoch rotations, and unreliable network order creates concurrency challenges. This section addresses them.

#### 8.10.1 Out-of-Order Messages (Ratchet)

Since messages from the same sender may arrive out of order (network reordering, server fanout delays), the ratchet must tolerate gaps:

1. **Each message carries `(epoch, senderDeviceId, chainIndex)`** — this fully identifies which key decrypts it.
2. **Recipients maintain per-sender ratchet state** — for each `(epoch, senderDeviceId)` pair, the recipient tracks `highestProcessedIndex`.
3. **Skipped key caching:** If a message arrives at index 15 but the recipient is at index 12, the recipient:
   - Advances the chain from 12 → 15, deriving `messageKey_12`, `messageKey_13`, `messageKey_14`, `messageKey_15`.
   - Caches `messageKey_12..14` in a bounded **skipped keys buffer** (max 256 entries; FIFO eviction).
   - Uses `messageKey_15` to decrypt the current message.
   - When messages 12–14 eventually arrive, they're decrypted from the cache.
4. **Late arrivals beyond the window** (index < highestProcessed - 256) are undecryptable. The client shows "[message too old to decrypt]".
5. **Duplicate detection:** If `chainIndex ≤ highestProcessedIndex` and the key was already consumed, the message is a replay or duplicate — reject it.

```
Sender chain state:  ... → chainKey_12 → chainKey_13 → chainKey_14 → chainKey_15
                              │              │              │              │
                          msgKey_12      msgKey_13      msgKey_14      msgKey_15

Message arrives: index=15 (skipping 12,13,14)
 → derive keys 12-15, cache 12-14, use 15
 → when msg index=13 arrives later, pull msgKey_13 from cache
```

#### 8.10.2 Concurrent Epoch Rotations

Two clients may try to rotate the key at the same time (e.g. two members join simultaneously, or a member leaves while an admin is rotating).

**Resolution:**
- The server's `INSERT OR IGNORE` on `(channel_id, device_id, epoch)` means the **first key written per device per epoch** wins. Later writes for the same tuple are silently dropped.
- If Client A and Client B both try to create epoch N+1:
  - For **their own devices**, whoever writes first sets the key. The second writer's attempt is ignored.
  - For **other people's devices**, the first key written per device wins.
  - One rotator's key may "win" for some devices and the other's for other devices — but this is fine because the same symmetric channel key was generated by one rotator.
  - **Wait — that's a split-brain!** If A generated `keyA` and B generated `keyB`, different devices may end up with different keys for epoch N+1.

**Split-brain prevention:**
- Before distributing keys for epoch N+1, the rotating client first checks whether epoch N+1 already has **any** entries: `GET /channels/{id}/keys` filtered for epoch N+1.
- If entries already exist, the client **abandons its own key**, fetches the existing epoch N+1 key for its own device (if present), and uses it. If its device has no entry yet, it bumps to epoch N+2 instead.
- This creates a simple "first writer wins" protocol per epoch, with automatic fallback to the next epoch.

```
Client A (rotating)            Server              Client B (rotating)
     │                           │                       │
     │  Check: epoch N+1 exists? │                       │
     │ ────────────────────────► │                       │
     │  → No entries             │  Check: N+1 exists?  │
     │ ◄──────────────────────── │ ◄──────────────────── │
     │                           │  → No entries         │
     │  POST keys for epoch N+1  │ ────────────────────► │
     │  (keyA, first!)           │                       │
     │ ────────────────────────► │  POST keys for N+1    │
     │                           │  (keyB — INSERT OR    │
     │                           │   IGNORE, some skip)  │
     │                           │ ◄──────────────────── │
     │                           │                       │
     │       … B discovers some of its writes were ignored …
     │                           │                       │
     │                           │  B fetches epoch N+1  │
     │                           │  keys, finds keyA was │
     │                           │  written for most     │
     │                           │  devices. B either:   │
     │                           │  (a) uses keyA if its │
     │                           │      device has it, or│
     │                           │  (b) rotates to N+2   │
     │                           │ ────────────────────► │
```

#### 8.10.3 Messages During Epoch Transition

When an epoch rotation occurs, some clients may still be sending messages under the old epoch while others have moved to the new one.

- **Messages carry their epoch.** Recipients use whatever epoch is in the message to look up the correct key.
- **Clients SHOULD switch to the new epoch as soon as they receive the key**, but old-epoch messages already in flight are still decryptable.
- **Recipients keep old epoch keys** for a grace period (e.g. 5 minutes or 50 messages) to handle stragglers, then MAY delete them.
- **Sender ratchet chains are per-epoch.** Each new epoch starts a fresh `chainKey_0` for every sender device — there's no carryover or confusion between epoch ratchet states.
