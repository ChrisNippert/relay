// Domain types matching the Go backend models

export interface User {
  id: string
  username: string
  email?: string
  display_name: string
  public_key?: string
  avatar_url?: string
  status: string
  created_at: string
  updated_at: string
}

export interface Friendship {
  id: string
  user_id: string
  friend_id: string
  status: string // "pending" | "accepted"
  created_at: string
}

export interface Server {
  id: string
  name: string
  owner_id: string
  icon_url?: string
  created_at: string
  updated_at: string
}

export interface ServerMember {
  server_id: string
  user_id: string
  role: string // "admin" | "member"
  joined_at: string
}

export interface Channel {
  id: string
  server_id?: string
  name: string
  type: string // "text" | "voice"
  position: number
  created_at: string
}

export interface Message {
  id: string
  channel_id: string
  user_id: string
  content: string
  nonce?: string
  type: string
  reply_to_id?: string
  reply_to?: Message
  edited: boolean
  created_at: string
  updated_at: string
  attachments?: Attachment[]
  author?: User
  edit_history?: MessageEdit[]
}

export interface MessageEdit {
  id: string
  message_id: string
  content: string
  edited_at: string
}

export interface Attachment {
  id: string
  message_id: string
  filename: string
  file_size: number
  mime_type: string
  created_at: string
}

export interface ChannelKey {
  channel_id: string
  user_id: string
  encrypted_key: string
}

// WebSocket message envelope
export interface WSMessage<T = unknown> {
  type: string
  payload: T
}

// Auth responses
export interface AuthResponse {
  token: string
  user: User
}

// Call signal payloads
export interface CallSignalPayload {
  target_user_id: string
  channel_id: string
  signal: RTCSessionDescriptionInit | RTCIceCandidateInit
}

export interface IncomingCallSignal {
  from_user_id: string
  channel_id: string
  signal: RTCSessionDescriptionInit | RTCIceCandidateInit
}

export interface ServerInvite {
  id: string
  server_id: string
  creator_id: string
  code: string
  max_uses: number
  uses: number
  expires_at?: string
  created_at: string
}
