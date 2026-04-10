# Relay

A self-hosted chat application with servers, channels, direct messages, voice chat, video, and screen sharing. Built with a Go backend and React frontend, inspired by the old IRC/forum aesthetic.

## Features

- **Servers & Channels** — Create servers with text and voice channels, invite links, role management (admin/member)
- **Direct Messages** — Private 1-on-1 conversations with call support
- **Voice Chat** — WebRTC peer-to-peer voice with configurable audio processing (EQ, noise gate, noise suppression, echo cancellation)
- **Video & Screen Sharing** — Camera feeds and screen sharing with resolution/framerate controls and system audio capture
- **End-to-End Encryption** — Optional E2EE for channels using browser crypto APIs
- **File Uploads** — Drag-and-drop file/image sharing
- **Notifications** — Unread indicators, @mention highlights, desktop notifications, per-server/DM badges
- **Themes** — Multiple built-in themes (dark, OLED, light, gradients) plus a custom theme editor
- **Electron App** — Desktop app with custom titlebar, screen picker (Linux), and native packaging
- **CLI Client** — Lightweight terminal client for text chat

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Go, Chi router, SQLite, WebSocket (Gorilla) |
| Frontend | React 19, TypeScript, Vite |
| Desktop | Electron |
| Auth | JWT (7-day tokens), bcrypt |
| Real-time | WebSocket (JSON messages) |
| Voice/Video | WebRTC (peer-to-peer) |
| Encryption | Web Crypto API (AES-GCM + ECDH) |

## Quick Start

### Prerequisites

- Go 1.22+
- Node.js 18+
- npm

### Server

```bash
# Set a JWT secret in config.yaml
# e.g. openssl rand -hex 32
vim config.yaml

# Build and run
make run
```

The server starts on `http://localhost:3002` by default and serves the built client from `client/dist/`.

### Client (Development)

```bash
cd client
npm install
npm run dev
```

Opens at `http://localhost:5173` with hot reload. The Vite dev server proxies API requests to the Go backend on port 3002.

### Electron App

```bash
cd client
npm run electron:dev    # Dev mode (Vite + Electron)
npm run electron:build  # Package for distribution
```

Builds output to `client/release/` as AppImage/deb (Linux), dmg (macOS), or nsis installer (Windows).

## Configuration

Edit `config.yaml` in the project root:

```yaml
host: "0.0.0.0"
port: "3002"
database_path: "relay.db"
jwt_secret: ""          # REQUIRED — set a strong random secret
upload_dir: "uploads"
max_upload_mb: 50
# tls_cert: "certs/cert.pem"
# tls_key: "certs/key.pem"
# static_dir: "client/dist"

# WebRTC ICE servers (defaults to Google STUN)
# ice_servers:
#   - urls: ["turn:your-turn-server.com:3478"]
#     username: "user"
#     credential: "pass"
```

## Docker

```bash
cd server
docker build -t relay .
docker run -p 3002:8080 -v relay-data:/app relay
```

## Project Structure

```
├── server/           Go backend
│   ├── cmd/relay/    Entry point
│   └── internal/
│       ├── api/      HTTP handlers, middleware, router
│       ├── auth/     JWT + bcrypt
│       ├── config/   YAML config loader
│       ├── db/       SQLite data layer
│       ├── models/   Domain types
│       └── ws/       WebSocket hub + handlers
├── client/           React frontend
│   ├── electron/     Electron main/preload
│   └── src/
│       ├── components/   UI components
│       ├── context/      Auth context
│       ├── pages/        Routes (Home, Login)
│       └── services/     API, WebSocket, WebRTC, crypto, settings
├── cli/              Go CLI client
├── docs/             Protocol documentation
└── config.yaml       Server configuration
```

## Protocol

See [docs/protocol.md](docs/protocol.md) for the full REST API and WebSocket message reference.

## License

All rights reserved.
