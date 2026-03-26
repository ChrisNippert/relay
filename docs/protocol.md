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
  -d '{"email":"alice@example.com","password":"secret"}' | jq -r .token)

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
