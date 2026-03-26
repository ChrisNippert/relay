import { useEffect, useRef, useState, useCallback, type FormEvent, type ChangeEvent } from 'react'
import type { Channel, Message, WSMessage as WSMsg } from '../types'
import * as api from '../services/api'
import { sendChatMessage, sendTypingStart, sendTypingStop, subscribe } from '../services/ws'
import { useAuth } from '../context/AuthContext'

interface Props {
  channel: Channel
  onStartCall?: (userId: string, video: boolean) => void
}

const URL_REGEX = /https?:\/\/[^\s<]+/g
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i

function extractUrls(text: string): string[] {
  return text.match(URL_REGEX) || []
}

function isImageUrl(url: string): boolean {
  return IMAGE_EXT.test(url)
}

// Formatting: ||spoilers||, *italics*, **bold**, ~~strikethrough~~, `code`
function renderFormattedText(text: string, keyPrefix: string): (string | React.ReactElement)[] {
  const FORMAT_REGEX = /(\|\|.+?\|\||\*\*.+?\*\*|\*.+?\*|~~.+?~~|`.+?`)/g
  const parts = text.split(FORMAT_REGEX)
  return parts.map((part, i) => {
    if (part.startsWith('||') && part.endsWith('||')) {
      const inner = part.slice(2, -2)
      return <span key={`${keyPrefix}-${i}`} className="spoiler" onClick={(e) => (e.currentTarget.classList.toggle('revealed'))}>{inner}</span>
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={`${keyPrefix}-${i}`}>{part.slice(1, -1)}</em>
    }
    if (part.startsWith('~~') && part.endsWith('~~')) {
      return <s key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</s>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={`${keyPrefix}-${i}`} className="inline-code">{part.slice(1, -1)}</code>
    }
    return part
  })
}

function renderMessageContent(content: string) {
  const parts = content.split(URL_REGEX)
  const urls = content.match(URL_REGEX) || []
  const result: (string | React.ReactElement)[] = []

  parts.forEach((part, i) => {
    if (part) result.push(...renderFormattedText(part, `f${i}`))
    if (urls[i]) {
      result.push(
        <a key={`u${i}`} href={urls[i]} target="_blank" rel="noreferrer noopener" className="message-link">
          {urls[i]}
        </a>
      )
    }
  })
  return result
}

export default function ChatView({ channel, onStartCall }: Props) {
  const { user } = useAuth()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map())
  const [dmPartnerId, setDmPartnerId] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const initialLoadRef = useRef(true)
  const userNameCache = useRef<Map<string, string>>(new Map())

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

  // Helper to resolve user ID to display name
  const resolveUserName = useCallback(async (userId: string): Promise<string> => {
    const cached = userNameCache.current.get(userId)
    if (cached) return cached
    try {
      const u = await api.getUser(userId)
      const name = u.display_name || u.username
      userNameCache.current.set(userId, name)
      return name
    } catch {
      return userId.slice(0, 8)
    }
  }, [])

  // Load messages on channel change
  useEffect(() => {
    setMessages([])
    setHasMore(true)
    initialLoadRef.current = true
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
            const next = new Map(prev)
            next.delete(m.user_id)
            return next
          })
        }
      } else if (msg.type === 'typing_start') {
        const p = msg.payload as { channel_id: string; user_id: string }
        if (p.channel_id === channel.id && p.user_id !== user?.id) {
          resolveUserName(p.user_id).then((name) => {
            setTypingUsers((prev) => new Map(prev).set(p.user_id, name))
          })
        }
      } else if (msg.type === 'typing_stop') {
        const p = msg.payload as { channel_id: string; user_id: string }
        if (p.channel_id === channel.id) {
          setTypingUsers((prev) => {
            const next = new Map(prev)
            next.delete(p.user_id)
            return next
          })
        }
      }
    })
    return unsub
  }, [channel.id, user?.id, resolveUserName])

  // Scroll to bottom on initial load; smooth-scroll for new messages
  useEffect(() => {
    if (initialLoadRef.current && messages.length > 0) {
      initialLoadRef.current = false
      bottomRef.current?.scrollIntoView()
    } else {
      // Only auto-scroll if user is near bottom
      const list = listRef.current
      if (list) {
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 150
        if (atBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
    }
  }, [messages])

  // Infinite scroll: load older messages when scrolling to top
  const handleScroll = useCallback(() => {
    const list = listRef.current
    if (!list || loadingOlder || !hasMore) return
    if (list.scrollTop < 100) {
      setLoadingOlder(true)
      const prevHeight = list.scrollHeight
      api.getMessages(channel.id, 50, messages.length)
        .then((older) => {
          if (older.length < 50) setHasMore(false)
          if (older.length > 0) {
            setMessages((prev) => [...older.reverse(), ...prev])
            // Preserve scroll position after prepending
            requestAnimationFrame(() => {
              list.scrollTop = list.scrollHeight - prevHeight
            })
          }
        })
        .catch(console.error)
        .finally(() => setLoadingOlder(false))
    }
  }, [channel.id, messages.length, loadingOlder, hasMore])

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

  const handleSend = async (e: FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text && pendingFiles.length === 0) return

    let attachmentIds: string[] = []
    if (pendingFiles.length > 0) {
      setUploading(true)
      try {
        for (const file of pendingFiles) {
          const res = await api.uploadFile(file)
          attachmentIds.push(res.id)
        }
      } catch (err) {
        console.error('Upload failed:', err)
      }
      setUploading(false)
      setPendingFiles([])
    }

    sendChatMessage(channel.id, text || ' ', undefined, attachmentIds.length ? attachmentIds : undefined)
    setInput('')
    sendTypingStop(channel.id)
    clearTimeout(typingTimerRef.current)
  }

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setPendingFiles((prev) => [...prev, ...Array.from(e.target.files!)])
    }
    e.target.value = ''
  }

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index))
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

      <div className="message-list" ref={listRef} onScroll={handleScroll}>
        {loadingOlder && <div className="loading-older">Loading older messages...</div>}
        {messages.map((m, i) => {
          const urls = extractUrls(m.content)
          const embedImages = urls.filter(isImageUrl)
          const embedLinks = urls.filter((u) => !isImageUrl(u))
          const prev = messages[i - 1]
          const isGrouped = prev && prev.user_id === m.user_id &&
            new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60 * 1000

          return (
            <div key={m.id} className={`message ${m.user_id === user?.id ? 'own' : ''} ${isGrouped ? 'grouped' : ''}`}>
              {!isGrouped && (
                <div className="message-header">
                  <span className="message-author">{m.author?.display_name ?? m.user_id}</span>
                  <span className="message-time">{formatTime(m.created_at)}</span>
                </div>
              )}
              <div className="message-body">{renderMessageContent(m.content)}</div>
              {m.attachments && m.attachments.length > 0 && (
                <div className="message-attachments">
                  {m.attachments.map((a) => {
                    const isImage = /^image\//i.test(a.mime_type)
                    return isImage ? (
                      <a key={a.id} href={api.fileURL(a.id)} target="_blank" rel="noreferrer">
                        <img src={api.fileURL(a.id)} alt={a.filename} className="attachment-image" />
                      </a>
                    ) : (
                      <a key={a.id} href={api.fileURL(a.id)} target="_blank" rel="noreferrer" className="attachment-link">
                        📎 {a.filename} ({(a.file_size / 1024).toFixed(1)} KB)
                      </a>
                    )
                  })}
                </div>
              )}
              {embedImages.length > 0 && (
                <div className="message-embeds">
                  {embedImages.map((url, i) => (
                    <a key={i} href={url} target="_blank" rel="noreferrer">
                      <img src={url} alt="" className="embed-image" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    </a>
                  ))}
                </div>
              )}
              {embedLinks.length > 0 && (
                <div className="message-embeds">
                  {embedLinks.map((url, i) => (
                    <div key={i} className="link-embed">
                      <a href={url} target="_blank" rel="noreferrer noopener" className="link-embed-url">{url}</a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {typingUsers.size > 0 && (
        <div className="typing-indicator">
          {Array.from(typingUsers.values()).join(', ')} typing...
        </div>
      )}

      {pendingFiles.length > 0 && (
        <div className="pending-files">
          {pendingFiles.map((f, i) => (
            <div key={i} className="pending-file">
              <span className="pending-file-name">📎 {f.name}</span>
              <button className="pending-file-remove" onClick={() => removePendingFile(i)}>×</button>
            </div>
          ))}
        </div>
      )}

      <form className="message-input" onSubmit={handleSend}>
        <input type="file" ref={fileInputRef} onChange={handleFileSelect} multiple hidden />
        <button type="button" className="upload-btn" onClick={() => fileInputRef.current?.click()} title="Upload file">
          📎
        </button>
        <input
          type="text"
          value={input}
          onChange={(e) => handleInput(e.target.value)}
          placeholder={`Message ${channel.server_id ? '#' + channel.name : channel.name}`}
          autoFocus
        />
        <button type="submit" disabled={uploading}>{uploading ? '...' : 'Send'}</button>
      </form>
    </div>
  )
}
