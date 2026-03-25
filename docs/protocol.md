# Relay Chat Protocol

This document describes the Relay API for building alternative clients (CLI, TUI, bots, etc.).

## Base URL

All HTTP endpoints are under `/api/`. WebSocket connects at `/ws`.

Default server address: `http://localhost:8080`

---

## Authentication

### Register

```
POST /api/auth/register
Content-Type: application/json

{
  "username": "alice",
  "email": "alice@example.com",
  "password": "secret123",
  "display_name": "Alice"
}
```

Response:
```json
{
  "token": "eyJhbG...",
  "user": { "id": "...", "username": "alice", "display_name": "Alice", ... }
}
```

### Login

```
POST /api/auth/login
Content-Type: application/json

{
  "email": "alice@example.com",
  "password": "secret123"
}
```

Response: Same as register.

### Using the Token

For **REST requests**, include the header:
```
Authorization: Bearer <token>
```

For **WebSocket**, pass it as a query parameter:
```
ws://localhost:8080/ws?token=<token>
```

Tokens are JWTs valid for 7 days.

---

## REST API

All authenticated endpoints require the `Authorization: Bearer <token>` header.

### Users

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users/me` | Get your own profile |
| PUT | `/api/users/me` | Update display_name, avatar_url |
| GET | `/api/users/{id}` | Get a user's public profile |
| GET | `/api/users/search?q=term` | Search users by username/display name |
| PUT | `/api/users/me/public-key` | Upload your E2E public key |

### Friends

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/friends` | List your friendships (pending + accepted) |
| POST | `/api/friends/request` | Send friend request. Body: `{"friend_id": "..."}` |
| POST | `/api/friends/accept/{friendshipID}` | Accept a pending request |
| DELETE | `/api/friends/{friendshipID}` | Remove a friendship |

### Servers

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/servers` | Create a server. Body: `{"name": "..."}` |
| GET | `/api/servers` | List your servers |
| GET | `/api/servers/{id}` | Get server details |
| PUT | `/api/servers/{id}` | Update server (admin only). Body: `{"name": "..."}` |
| DELETE | `/api/servers/{id}` | Delete server (owner only) |
| POST | `/api/servers/{id}/join` | Join a server |
| POST | `/api/servers/{id}/leave` | Leave a server |
| GET | `/api/servers/{id}/members` | List server members |

When you create a server, it automatically creates a `general` text channel and a `General` voice channel, and makes you an admin.

### Channels

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/servers/{serverID}/channels` | List channels in a server |
| POST | `/api/servers/{serverID}/channels` | Create channel (admin only). Body: `{"name": "...", "type": "text"|"voice"}` |
| DELETE | `/api/channels/{channelID}` | Delete a channel (admin only) |

### Direct Messages

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/dm` | Create/get a DM channel. Body: `{"user_id": "..."}` |
| GET | `/api/dm` | List your DM channels |

DM channels are just channels with no server_id. Creating a DM with the same user twice returns the existing channel.

### Messages

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/channels/{channelID}/messages?limit=50&offset=0` | Get messages (newest first) |

Messages are fetched via REST but **sent via WebSocket** (see below). Max limit: 100, default: 50.

Message objects:
```json
{
  "id": "uuid",
  "channel_id": "uuid",
  "user_id": "uuid",
  "content": "Hello!",
  "nonce": "optional-client-nonce",
  "type": "text",
  "created_at": "2024-01-01T00:00:00Z",
  "author": { "id": "...", "username": "alice", "display_name": "Alice", ... },
  "attachments": []
}
```

### E2E Encryption Keys

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/channels/{channelID}/keys` | Get all encrypted channel keys |
| POST | `/api/channels/{channelID}/keys` | Set your encrypted key. Body: `{"encrypted_key": "..."}` |

### File Upload

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/upload` | Upload a file (multipart/form-data, field: `file`). Max 50MB. |
| GET | `/api/files/{fileID}` | Download a file |

Allowed extensions: jpg, jpeg, png, gif, webp, mp4, webm, mp3, ogg, wav, pdf, txt, zip.

---

## WebSocket Protocol

Connect to `ws://host:port/ws?token=<jwt>`.

All messages are JSON with the envelope format:
```json
{
  "type": "message_type",
  "payload": { ... }
}
```

### Sending Messages

#### Chat Message (client → server)

```json
{
  "type": "chat_message",
  "payload": {
    "channel_id": "uuid",
    "content": "Hello world",
    "nonce": "optional-client-nonce",
    "type": "text"
  }
}
```

The server stores the message and broadcasts it to all channel participants.

#### Chat Message (server → client)

```json
{
  "type": "chat_message",
  "payload": {
    "id": "uuid",
    "channel_id": "uuid",
    "user_id": "uuid",
    "content": "Hello world",
    "nonce": "optional",
    "type": "text",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z",
    "author": {
      "id": "uuid",
      "username": "alice",
      "display_name": "Alice",
      "status": "online"
    }
  }
}
```

The sender also receives their own message back (for confirmation + getting the server-assigned ID).

### Typing Indicators

```json
{"type": "typing_start", "payload": {"channel_id": "uuid"}}
{"type": "typing_stop",  "payload": {"channel_id": "uuid"}}
```

Server relays to other channel participants (excluding sender):
```json
{"type": "typing_start", "payload": {"channel_id": "uuid", "user_id": "uuid"}}
```

### Presence

When a user connects, the server broadcasts:
```json
{"type": "presence", "payload": {"user_id": "uuid", "status": "online"}}
```

When they disconnect:
```json
{"type": "presence", "payload": {"user_id": "uuid", "status": "offline"}}
```

### Voice/Video Call Signaling

Calls use WebRTC with the server acting as a signaling relay. Media flows peer-to-peer.

#### Call Offer (client → server → target)

```json
{
  "type": "call_offer",
  "payload": {
    "target_user_id": "uuid",
    "channel_id": "uuid",
    "signal": { "type": "offer", "sdp": "..." }
  }
}
```

Server relays to target as:
```json
{
  "type": "call_offer",
  "payload": {
    "from_user_id": "uuid",
    "channel_id": "uuid",
    "signal": { "type": "offer", "sdp": "..." }
  }
}
```

#### Call Answer

Same pattern as offer but with `"type": "call_answer"`.

#### ICE Candidate

```json
{
  "type": "ice_candidate",
  "payload": {
    "target_user_id": "uuid",
    "channel_id": "uuid",
    "signal": { "candidate": "...", "sdpMLineIndex": 0, ... }
  }
}
```

#### End Call

```json
{
  "type": "call_end",
  "payload": {
    "target_user_id": "uuid",
    "channel_id": "uuid"
  }
}
```

---

## Minimal CLI Client Flow

Here's the sequence for a bare-bones text chat CLI client:

1. **Login**: `POST /api/auth/login` → save token
2. **List servers**: `GET /api/servers`
3. **List channels**: `GET /api/servers/{id}/channels`
4. **Connect WebSocket**: `ws://host:port/ws?token=<token>`
5. **Load history**: `GET /api/channels/{id}/messages`
6. **Send messages**: Write `{"type":"chat_message","payload":{"channel_id":"...","content":"..."}}` to the WebSocket
7. **Receive messages**: Read `{"type":"chat_message","payload":{...}}` from the WebSocket

That's it for basic text chat. No WebRTC, no encryption needed for a minimal client.

### Example with curl + websocat

```bash
# Login
TOKEN=$(curl -s -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"secret123"}' | jq -r .token)

# List servers
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/servers | jq

# List channels in first server
SERVER_ID=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/servers | jq -r '.[0].id')
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8080/api/servers/$SERVER_ID/channels" | jq

# Get channel ID
CHANNEL_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8080/api/servers/$SERVER_ID/channels" | jq -r '.[0].id')

# Connect and chat via websocat
echo '{"type":"chat_message","payload":{"channel_id":"'$CHANNEL_ID'","content":"Hello from CLI!"}}' | \
  websocat "ws://localhost:8080/ws?token=$TOKEN"
```

---

## Connection Notes

- **Keepalive**: The server sends WebSocket ping frames every 54 seconds. Clients must respond with pong (most libraries handle this automatically). If no pong is received within 60 seconds, the connection is closed.
- **Message size limit**: 64 KB per WebSocket message.
- **Send buffer**: 256 messages. If the buffer is full, the connection is closed.
- **Single session**: Only one WebSocket connection per user. New connections close the old one.
- **Reconnection**: Clients should reconnect on disconnect with a short delay (e.g., 3 seconds).
