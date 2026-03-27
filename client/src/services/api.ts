import type { AuthResponse, Channel, ChannelKey, Friendship, Message, Server, ServerInvite, ServerMember, User } from '../types'

let serverUrl: string = localStorage.getItem('relay_server_url') || ''

function getBase(): string {
  return serverUrl ? `${serverUrl}/api` : '/api'
}

export function setServerUrl(url: string) {
  // Normalize: strip trailing slash, ensure https:// if no protocol
  let normalized = url.trim().replace(/\/+$/, '')
  if (normalized && !/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`
  }
  serverUrl = normalized
  if (normalized) {
    localStorage.setItem('relay_server_url', normalized)
  } else {
    localStorage.removeItem('relay_server_url')
  }
}

export function getServerUrl(): string {
  return serverUrl
}

let token: string | null = localStorage.getItem('relay_token')

export function setToken(t: string | null) {
  token = t
  if (t) {
    localStorage.setItem('relay_token', t)
  } else {
    localStorage.removeItem('relay_token')
  }
}

export function getToken(): string | null {
  return token
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (body) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${getBase()}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || res.statusText)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// Auth
export const register = (username: string, email: string, password: string, display_name: string) =>
  request<AuthResponse>('POST', '/auth/register', { username, email, password, display_name })

export const login = (email: string, password: string) =>
  request<AuthResponse>('POST', '/auth/login', { email, password })

export const logout = () =>
  request<void>('POST', '/auth/logout')

// Users
export const getMe = () => request<User>('GET', '/users/me')
export const updateMe = (data: Partial<Pick<User, 'display_name' | 'avatar_url' | 'custom_status' | 'name_color'>>) =>
  request<User>('PUT', '/users/me', data)
export const getUser = (id: string) => request<User>('GET', `/users/${encodeURIComponent(id)}`)
export const searchUsers = (q: string) => request<User[]>('GET', `/users/search?q=${encodeURIComponent(q)}`)
export const updatePublicKey = (public_key: string) =>
  request<void>('PUT', '/users/me/public-key', { public_key })

// Friends
export const getFriends = () => request<Friendship[]>('GET', '/friends')
export const sendFriendRequest = (userId: string) =>
  request<Friendship>('POST', '/friends/request', { user_id: userId })
export const acceptFriendRequest = (friendshipId: string) =>
  request<Friendship>('POST', `/friends/accept/${encodeURIComponent(friendshipId)}`)
export const removeFriend = (friendshipId: string) =>
  request<void>('DELETE', `/friends/${encodeURIComponent(friendshipId)}`)

// Servers
export const createServer = (name: string) => request<Server>('POST', '/servers', { name })
export const getServers = () => request<Server[]>('GET', '/servers')
export const getServer = (id: string) => request<Server>('GET', `/servers/${encodeURIComponent(id)}`)
export const updateServer = (id: string, data: Partial<Pick<Server, 'name' | 'icon_url'>>) =>
  request<Server>('PUT', `/servers/${encodeURIComponent(id)}`, data)
export const deleteServer = (id: string) => request<void>('DELETE', `/servers/${encodeURIComponent(id)}`)
export const joinServer = (id: string) => request<void>('POST', `/servers/${encodeURIComponent(id)}/join`)
export const leaveServer = (id: string) => request<void>('POST', `/servers/${encodeURIComponent(id)}/leave`)
export const getMembers = (id: string) => request<ServerMember[]>('GET', `/servers/${encodeURIComponent(id)}/members`)
export const getOnlineUsers = (id: string) => request<string[]>('GET', `/servers/${encodeURIComponent(id)}/online`)
export const updateMemberRole = (serverId: string, userId: string, role: string) =>
  request<{ role: string }>('PUT', `/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}/role`, { role })
export const kickMember = (serverId: string, userId: string) =>
  request<void>('DELETE', `/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}`)

// Server invites
export const createInvite = (serverId: string, maxUses = 0, expiresIn = 0) =>
  request<ServerInvite>('POST', `/servers/${encodeURIComponent(serverId)}/invites`, { max_uses: maxUses, expires_in: expiresIn })
export const getInvites = (serverId: string) =>
  request<ServerInvite[]>('GET', `/servers/${encodeURIComponent(serverId)}/invites`)
export const joinByInvite = (code: string) =>
  request<Server>('POST', `/invites/${encodeURIComponent(code)}/join`)
export const deleteInvite = (inviteId: string) =>
  request<void>('DELETE', `/invites/${encodeURIComponent(inviteId)}`)

// Channels
export const getChannels = (serverId: string) =>
  request<Channel[]>('GET', `/servers/${encodeURIComponent(serverId)}/channels`)
export const createChannel = (serverId: string, name: string, type: string, description = '') =>
  request<Channel>('POST', `/servers/${encodeURIComponent(serverId)}/channels`, { name, type, description })
export const deleteChannel = (channelId: string) =>
  request<void>('DELETE', `/channels/${encodeURIComponent(channelId)}`)
export const updateChannel = (channelId: string, name: string, description = '') =>
  request<Channel>('PUT', `/channels/${encodeURIComponent(channelId)}`, { name, description })
export const updateChannelPositions = (serverId: string, positions: Record<string, number>) =>
  request<void>('PUT', `/servers/${encodeURIComponent(serverId)}/channels/positions`, { positions })

// DMs
export const createDM = (userId: string) => request<Channel>('POST', '/dm', { user_id: userId })
export const getDMs = () => request<Channel[]>('GET', '/dm')
export const getDMParticipants = (channelId: string) =>
  request<string[]>('GET', `/dm/${encodeURIComponent(channelId)}/participants`)

// Messages
export const getMessages = (channelId: string, limit = 50, offset = 0) =>
  request<Message[]>('GET', `/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}&offset=${offset}`)
export const searchMessages = (channelId: string, query: string, limit = 50) =>
  request<Message[]>('GET', `/channels/${encodeURIComponent(channelId)}/messages/search?q=${encodeURIComponent(query)}&limit=${limit}`)
export const editMessage = (messageId: string, content: string) =>
  request<Message>('PUT', `/messages/${encodeURIComponent(messageId)}`, { content })
export const deleteMessage = (messageId: string) =>
  request<Message>('DELETE', `/messages/${encodeURIComponent(messageId)}`)
export const getEditHistory = (messageId: string) =>
  request<import('../types').MessageEdit[]>('GET', `/messages/${encodeURIComponent(messageId)}/history`)

// Channel keys (E2E)
export const getChannelKeys = (channelId: string) =>
  request<ChannelKey[]>('GET', `/channels/${encodeURIComponent(channelId)}/keys`)
export const setChannelKey = (channelId: string, encrypted_key: string, user_id?: string) =>
  request<void>('POST', `/channels/${encodeURIComponent(channelId)}/keys`, { encrypted_key, ...(user_id ? { user_id } : {}) })
export const deleteChannelKeys = (channelId: string) =>
  request<void>('DELETE', `/channels/${encodeURIComponent(channelId)}/keys`)
export const deleteMyChannelKeys = () =>
  request<void>('DELETE', '/users/me/channel-keys')

// File upload
const MAX_UPLOAD_MB = 50

export function uploadFile(
  file: File,
  onProgress?: (pct: number) => void
): Promise<{ id: string; filename: string }> {
  const sizeMB = file.size / 1024 / 1024
  if (sizeMB > MAX_UPLOAD_MB) {
    return Promise.reject(new Error(`File too large (${sizeMB.toFixed(1)} MB) — max is ${MAX_UPLOAD_MB} MB`))
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const form = new FormData()
    form.append('file', file)

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error('Invalid response from server'))
        }
      } else {
        let msg = xhr.responseText
        try { const p = JSON.parse(msg); if (p.error) msg = p.error } catch {}
        reject(new Error(msg || `Upload failed (HTTP ${xhr.status})`))
      }
    })

    xhr.addEventListener('error', () => {
      reject(new Error(`Network error uploading ${file.name} (${sizeMB.toFixed(1)} MB)`))
    })

    xhr.addEventListener('abort', () => {
      reject(new Error('Upload cancelled'))
    })

    xhr.open('POST', `${getBase()}/upload`)
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.send(form)
  })
}

export const fileURL = (fileId: string) => {
  const base = `${getBase()}/files/${encodeURIComponent(fileId)}`
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

// Voice state
export const getVoiceUsers = (channelId: string) =>
  request<string[]>('GET', `/channels/${encodeURIComponent(channelId)}/voice-users`)

// OpenGraph metadata
export interface OGData {
  url: string
  title?: string
  description?: string
  image?: string
  site_name?: string
  video_embed?: string
}

export const fetchOG = (url: string) =>
  request<OGData>('GET', `/og?url=${encodeURIComponent(url)}`)
