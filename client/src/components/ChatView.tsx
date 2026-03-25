import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Channel, Message, WSMessage as WSMsg } from '../types'
import * as api from '../services/api'
import { sendChatMessage, sendTypingStart, sendTypingStop, subscribe } from '../services/ws'
import { useAuth } from '../context/AuthContext'

interface Props {
  channel: Channel
  onStartCall?: (userId: string, video: boolean) => void
}

export default function ChatView({ channel, onStartCall }: Props) {
  const { user } = useAuth()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set())
  const [dmPartnerId, setDmPartnerId] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Resolve DM partner for call buttons
  useEffect(() => {
    if (!channel.server_id && onStartCall) {
      api.getDMParticipants(channel.id).then((parts) => {
        const other = parts.find((id: string) => id !== user?.id)
        setDmPartnerId(other ?? null)
      }).catch(() => setDmPartnerId(null))
    } else {
      setDmPartnerId(null)
    }
  }, [channel.id, channel.server_id, user?.id, onStartCall])

  // Load messages on channel change
  useEffect(() => {
    setMessages([])
    api.getMessages(channel.id).then((msgs) => {
      setMessages(msgs.reverse()) // API returns DESC, we want ASC
    }).catch(console.error)
  }, [channel.id])

  // Subscribe to WebSocket messages
  useEffect(() => {
    const unsub = subscribe((msg: WSMsg) => {
      if (msg.type === 'chat_message') {
        const m = msg.payload as Message
        if (m.channel_id === channel.id) {
          setMessages((prev) => prev.some((x) => x.id === m.id) ? prev : [...prev, m])
          // Remove sender from typing
          setTypingUsers((prev) => {
            const next = new Set(prev)
            next.delete(m.user_id)
            return next
          })
        }
      } else if (msg.type === 'typing_start') {
        const p = msg.payload as { channel_id: string; user_id: string }
        if (p.channel_id === channel.id && p.user_id !== user?.id) {
          setTypingUsers((prev) => new Set(prev).add(p.user_id))
        }
      } else if (msg.type === 'typing_stop') {
        const p = msg.payload as { channel_id: string; user_id: string }
        if (p.channel_id === channel.id) {
          setTypingUsers((prev) => {
            const next = new Set(prev)
            next.delete(p.user_id)
            return next
          })
        }
      }
    })
    return unsub
  }, [channel.id, user?.id])

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleInput = (value: string) => {
    setInput(value)
    if (value) {
      sendTypingStart(channel.id)
      clearTimeout(typingTimerRef.current)
      typingTimerRef.current = setTimeout(() => sendTypingStop(channel.id), 3000)
    } else {
      sendTypingStop(channel.id)
      clearTimeout(typingTimerRef.current)
    }
  }

  const handleSend = (e: FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text) return
    sendChatMessage(channel.id, text)
    setInput('')
    sendTypingStop(channel.id)
    clearTimeout(typingTimerRef.current)
  }

  const formatTime = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="chat-view">
      <div className="chat-header">
        <span className="chat-header-name">
          {channel.server_id ? '#' : '💬'} {channel.name}
        </span>
        {dmPartnerId && onStartCall && (
          <div className="chat-header-actions">
            <button className="chat-call-btn" onClick={() => onStartCall(dmPartnerId, false)} title="Voice Call">
              📞
            </button>
            <button className="chat-call-btn" onClick={() => onStartCall(dmPartnerId, true)} title="Video Call">
              📹
            </button>
          </div>
        )}
      </div>

      <div className="message-list">
        {messages.map((m) => (
          <div key={m.id} className={`message ${m.user_id === user?.id ? 'own' : ''}`}>
            <div className="message-header">
              <span className="message-author">{m.author?.display_name ?? m.user_id}</span>
              <span className="message-time">{formatTime(m.created_at)}</span>
            </div>
            <div className="message-body">{m.content}</div>
            {m.attachments && m.attachments.length > 0 && (
              <div className="message-attachments">
                {m.attachments.map((a) => (
                  <a key={a.id} href={api.fileURL(a.id)} target="_blank" rel="noreferrer" className="attachment-link">
                    📎 {a.filename} ({(a.file_size / 1024).toFixed(1)} KB)
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {typingUsers.size > 0 && (
        <div className="typing-indicator">
          {Array.from(typingUsers).join(', ')} typing...
        </div>
      )}

      <form className="message-input" onSubmit={handleSend}>
        <input
          type="text"
          value={input}
          onChange={(e) => handleInput(e.target.value)}
          placeholder={`Message ${channel.server_id ? '#' + channel.name : channel.name}`}
          autoFocus
        />
        <button type="submit">Send</button>
      </form>
    </div>
  )
}
