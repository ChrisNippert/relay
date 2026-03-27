import type { WSMessage } from '../types'
import { getToken, getServerUrl } from './api'

type MessageHandler = (msg: WSMessage) => void

let ws: WebSocket | null = null
let handlers: MessageHandler[] = []
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

export function connect() {
  const token = getToken()
  if (!token) return

  // Close existing connection to prevent duplicates (e.g. React StrictMode double-mount)
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.onclose = null // prevent reconnect timer
    ws.close()
  }

  const serverUrl = getServerUrl()
  let wsUrl: string
  if (serverUrl) {
    const parsed = new URL(serverUrl)
    const proto = parsed.protocol === 'https:' ? 'wss' : 'ws'
    wsUrl = `${proto}://${parsed.host}/api/ws`
  } else {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    wsUrl = `${proto}://${location.host}/api/ws`
  }
  // Send JWT via Sec-WebSocket-Protocol header to avoid leaking it in the URL
  ws = new WebSocket(wsUrl, ['auth', token])

  ws.onopen = () => {
    console.log('WebSocket connected')
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  ws.onmessage = (ev) => {
    try {
      const msg: WSMessage = JSON.parse(ev.data)
      handlers.forEach((h) => h(msg))
    } catch (e) {
      console.error('WS parse error:', e)
    }
  }

  ws.onclose = () => {
    console.log('WebSocket disconnected, reconnecting in 3s...')
    ws = null
    reconnectTimer = setTimeout(connect, 3000)
  }

  ws.onerror = (err) => {
    console.error('WebSocket error:', err)
    ws?.close()
  }
}

export function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  ws?.close()
  ws = null
}

export function send(type: string, payload: unknown) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('WebSocket not connected')
    return
  }
  ws.send(JSON.stringify({ type, payload }))
}

export function subscribe(handler: MessageHandler): () => void {
  handlers.push(handler)
  return () => {
    handlers = handlers.filter((h) => h !== handler)
  }
}

// Convenience senders
export function sendChatMessage(channelId: string, content: string, nonce?: string, attachmentIds?: string[], replyToId?: string) {
  send('chat_message', { channel_id: channelId, content, nonce, type: 'text', attachment_ids: attachmentIds, reply_to_id: replyToId })
}

export function sendEditMessage(messageId: string, content: string) {
  send('edit_message', { message_id: messageId, content })
}

export function sendDeleteMessage(messageId: string) {
  send('delete_message', { message_id: messageId })
}

export function sendTypingStart(channelId: string) {
  send('typing_start', { channel_id: channelId })
}

export function sendTypingStop(channelId: string) {
  send('typing_stop', { channel_id: channelId })
}

export function sendCallOffer(targetUserId: string, channelId: string, signal: RTCSessionDescriptionInit) {
  send('call_offer', { target_user_id: targetUserId, channel_id: channelId, signal })
}

export function sendCallAnswer(targetUserId: string, channelId: string, signal: RTCSessionDescriptionInit) {
  send('call_answer', { target_user_id: targetUserId, channel_id: channelId, signal })
}

export function sendIceCandidate(targetUserId: string, channelId: string, signal: RTCIceCandidateInit) {
  send('ice_candidate', { target_user_id: targetUserId, channel_id: channelId, signal })
}

export function sendCallEnd(targetUserId: string, channelId: string) {
  send('call_end', { target_user_id: targetUserId, channel_id: channelId })
}

export function sendVoiceJoin(channelId: string) {
  send('voice_join', { channel_id: channelId })
}

export function sendVoiceLeave(channelId: string) {
  send('voice_leave', { channel_id: channelId })
}

export function sendVoiceKick(channelId: string, userId: string) {
  send('voice_kick', { channel_id: channelId, user_id: userId })
}
