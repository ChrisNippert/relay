import { useEffect, useRef, useState, useCallback, type FormEvent, type ChangeEvent } from 'react'
import type { Channel, Message, MessageEdit, User, ServerMember, WSMessage as WSMsg } from '../types'
import * as api from '../services/api'
import hljs from 'highlight.js'
import { sendChatMessage, sendTypingStart, sendTypingStop, sendEditMessage, sendDeleteMessage, subscribe } from '../services/ws'
import { useAuth } from '../context/AuthContext'
import UserPopover from './UserPopover'
import * as e2e from '../services/e2e'

interface Props {
  channel: Channel
  onStartCall?: (userId: string, video: boolean) => void
  onDMUser?: (userId: string) => void
  showMembersToggle?: boolean
  showMembers?: boolean
  onToggleMembers?: () => void
  isAdmin?: boolean
  serverId?: string
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

function renderCodeBlock(lang: string, code: string, key: string): React.ReactElement {
  let highlighted: string
  try {
    if (lang && hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(code, { language: lang }).value
    } else {
      highlighted = hljs.highlightAuto(code).value
    }
  } catch {
    highlighted = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  return (
    <pre key={key} className="code-block">
      {lang && <span className="code-block-lang">{lang}</span>}
      <code dangerouslySetInnerHTML={{ __html: highlighted }} />
    </pre>
  )
}

function renderMessageContent(content: string) {
  const result: (string | React.ReactElement)[] = []
  // Split on triple-backtick code blocks first
  const CODE_BLOCK_REGEX = /```([\w]*)?\n?([\s\S]*?)```/g
  let lastIndex = 0
  let blockIndex = 0
  let match: RegExpExecArray | null

  while ((match = CODE_BLOCK_REGEX.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index)
    if (before) renderInlineContent(before, `pre${blockIndex}`, result)
    const lang = (match[1] ?? '').trim()
    const code = match[2] ?? ''
    result.push(renderCodeBlock(lang, code, `cb${blockIndex}`))
    lastIndex = match.index + match[0].length
    blockIndex++
  }
  const remaining = content.slice(lastIndex)
  if (remaining) renderInlineContent(remaining, `pre${blockIndex}`, result)
  return result
}

function renderInlineContent(text: string, keyPrefix: string, result: (string | React.ReactElement)[]) {
  // Split by URLs, then by newlines
  const parts = text.split(URL_REGEX)
  const urls = text.match(URL_REGEX) || []

  parts.forEach((part, i) => {
    if (part) {
      const lines = part.split(/\n/)
      lines.forEach((line, j) => {
        if (line) result.push(...renderFormattedText(line, `${keyPrefix}-f${i}-${j}`))
        if (j < lines.length - 1) result.push(<br key={`${keyPrefix}-br-${i}-${j}`} />)
      })
    }
    if (urls[i]) {
      result.push(
        <a key={`${keyPrefix}-u${i}`} href={urls[i]} target="_blank" rel="noreferrer noopener" className="message-link">
          {urls[i]}
        </a>
      )
    }
  })
}

const YOUTUBE_RE = /(?:youtube\.com\/watch\?.*v=|youtu\.be\/)([\w-]{11})/

// Global OG cache shared across all messages
const ogCache = new Map<string, api.OGData | null>()

function LinkEmbed({ url, onImageLoad }: { url: string; onImageLoad?: () => void }) {
  const [og, setOG] = useState<api.OGData | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (ogCache.has(url)) {
      setOG(ogCache.get(url) ?? null)
      setLoaded(true)
      return
    }
    let cancelled = false
    api.fetchOG(url).then((data) => {
      if (cancelled) return
      ogCache.set(url, data)
      setOG(data)
      setLoaded(true)
    }).catch(() => {
      if (cancelled) return
      ogCache.set(url, null)
      setLoaded(true)
    })
    return () => { cancelled = true }
  }, [url])

  if (!loaded || !og) return null
  if (!og.title && !og.description && !og.video_embed) return (
    <div className="link-embed">
      <a href={url} target="_blank" rel="noreferrer noopener" className="link-embed-url">{url}</a>
    </div>
  )

  const ytMatch = url.match(YOUTUBE_RE)

  return (
    <div className="rich-embed">
      {og.site_name && <div className="rich-embed-site">{og.site_name}</div>}
      {og.title && (
        <a href={url} target="_blank" rel="noreferrer noopener" className="rich-embed-title">{og.title}</a>
      )}
      {og.description && <div className="rich-embed-desc">{og.description.length > 300 ? og.description.slice(0, 300) + '…' : og.description}</div>}
      {ytMatch && og.video_embed ? (
        <div className="rich-embed-video">
          <iframe
            src={og.video_embed}
            title={og.title || 'Video'}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      ) : og.image ? (
        <a href={url} target="_blank" rel="noreferrer noopener">
          <img src={og.image} alt="" className="rich-embed-thumb" onLoad={onImageLoad} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
        </a>
      ) : null}
    </div>
  )
}

export default function ChatView({ channel, onStartCall, onDMUser, showMembersToggle, showMembers, onToggleMembers, isAdmin, serverId: _serverId }: Props) {
  const { user } = useAuth()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map())
  const [dmPartnerId, setDmPartnerId] = useState<string | null>(null)
  const [dmPartnerName, setDmPartnerName] = useState<string>('')
  const [initialScrollDone, setInitialScrollDone] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<{file: File; id?: string; progress: number; error?: string}[]>([])
  const [uploading, setUploading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [replyingTo, setReplyingTo] = useState<Message | null>(null)
  const [editingMsg, setEditingMsg] = useState<Message | null>(null)
  const [inlineEditText, setInlineEditText] = useState('')
  const [dragging, setDragging] = useState(false)
  const dragCounter = useRef(0)
  const [historyMsg, setHistoryMsg] = useState<Message | null>(null)
  const [editHistory, setEditHistory] = useState<MessageEdit[]>([])
  const [mentionUsers, setMentionUsers] = useState<User[]>([])
  const [members, setMembers] = useState<User[]>([])
  const [popover, setPopover] = useState<{ userId: string; rect: DOMRect } | null>(null)
  const [encrypted, setEncrypted] = useState(false)
  const [encryptionReady, setEncryptionReady] = useState(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Message[] | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const initialLoadRef = useRef(true)
  const userNameCache = useRef<Map<string, string>>(new Map())
  const pendingCountRef = useRef(0)
  const seenMsgIds = useRef(new Set<string>())

  // Resolve DM partner for call buttons and header name
  useEffect(() => {
    if (!channel.server_id) {
      api.getDMParticipants(channel.id).then(async (parts) => {
        const other = parts.find((id: string) => id !== user?.id)
        setDmPartnerId(other ?? null)
        if (other) {
          try {
            const u = await api.getUser(other)
            setDmPartnerName(u.display_name || u.username)
          } catch { setDmPartnerName('') }
        }
      }).catch(() => { setDmPartnerId(null); setDmPartnerName('') })
    } else {
      setDmPartnerId(null)
      setDmPartnerName('')
    }
  }, [channel.id, channel.server_id, user?.id])

  // Check if channel has E2E encryption enabled
  useEffect(() => {
    setEncrypted(false)
    setEncryptionReady(false)
    e2e.isChannelEncrypted(channel.id).then(async (enc) => {
      setEncrypted(enc)
      if (enc) {
        // Check if we actually have (or can get) the channel key
        const key = await e2e.getChannelKey(channel.id)
        setEncryptionReady(key !== null)
        // Redistribute keys to any members missing them
        e2e.redistributeKeys(channel.id, channel.server_id || undefined)
      }
    }).catch(() => setEncrypted(false))
  }, [channel.id, channel.server_id])

  // Load channel members for @mention autocomplete
  useEffect(() => {
    if (channel.server_id) {
      api.getMembers(channel.server_id).then((serverMembers: ServerMember[]) => {
        Promise.all(
          serverMembers.map((sm) => api.getUser(sm.user_id).catch(() => null))
        ).then((users) => {
          setMembers(users.filter((u): u is User => u !== null && u.id !== user?.id))
        })
      }).catch(() => setMembers([]))
    } else {
      api.getDMParticipants(channel.id).then((ids: string[]) => {
        Promise.all(
          ids.filter((id) => id !== user?.id).map((id) => api.getUser(id).catch(() => null))
        ).then((users) => {
          setMembers(users.filter((u): u is User => u !== null))
        })
      }).catch(() => setMembers([]))
    }
  }, [channel.id, channel.server_id, user?.id])

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
    seenMsgIds.current.clear()
    setHasMore(true)
    setReplyingTo(null)
    setEditingMsg(null)
    setPendingFiles([])
    setUploading(false)
    pendingCountRef.current = 0
    setInitialScrollDone(false)
    initialLoadRef.current = true
    api.getMessages(channel.id).then(async (msgs) => {
      const ordered = msgs.reverse()
      // Decrypt any E2E-encrypted messages
      const decrypted = await Promise.all(
        ordered.map(async (m) => {
          seenMsgIds.current.add(m.id)
          if (e2e.isEncryptedContent(m.content)) {
            const plain = await e2e.decryptMessage(channel.id, m.content)
            return { ...m, content: plain }
          }
          return m
        })
      )
      setMessages(decrypted)
    }).catch(console.error)
  }, [channel.id])

  // Subscribe to WebSocket messages
  useEffect(() => {
    const unsub = subscribe((msg: WSMsg) => {
      if (msg.type === 'chat_message') {
        const m = msg.payload as Message
        if (m.channel_id === channel.id) {
          // Synchronous dedup guard — prevents async race
          if (seenMsgIds.current.has(m.id)) return
          seenMsgIds.current.add(m.id)
          // Decrypt if encrypted, then add to state
          const handleMsg = async () => {
            let decrypted = m
            if (e2e.isEncryptedContent(m.content)) {
              const plain = await e2e.decryptMessage(channel.id, m.content)
              decrypted = { ...m, content: plain }
            }
            setMessages((prev) => prev.some((x) => x.id === decrypted.id) ? prev : [...prev, decrypted])
          }
          handleMsg()
          // Remove sender from typing
          setTypingUsers((prev) => {
            const next = new Map(prev)
            next.delete(m.user_id)
            return next
          })
        }
      } else if (msg.type === 'message_edited') {
        const m = msg.payload as Message
        if (m.channel_id === channel.id) {
          setMessages((prev) => prev.map((x) => x.id === m.id ? { ...x, ...m } : x))
        }
      } else if (msg.type === 'message_deleted') {
        const m = msg.payload as Message
        if (m.channel_id === channel.id) {
          setMessages((prev) => prev.map((x) => x.id === m.id ? { ...x, ...m } : x))
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
      } else if (msg.type === 'member_joined' || msg.type === 'member_left' || msg.type === 'member_kicked') {
        // Rotate E2E keys when membership changes so new/departed members
        // cannot decrypt messages from before/after the change
        if (encrypted && channel.server_id) {
          const p = msg.payload as { server_id: string }
          if (p.server_id === channel.server_id) {
            e2e.rotateKeys(channel.id, channel.server_id).then((ok) => {
              if (ok) setEncryptionReady(true)
            })
          }
        }
      }
    })
    return unsub
  }, [channel.id, channel.server_id, user?.id, encrypted, resolveUserName])

  // Scroll to bottom on initial load; smooth-scroll for new messages
  useEffect(() => {
    if (initialLoadRef.current && messages.length > 0) {
      initialLoadRef.current = false
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView()
        setInitialScrollDone(true)
      })
    } else if (isAtBottomRef.current) {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      })
    }
  }, [messages])

  // Re-scroll to bottom when images/media load (they change scroll height)
  const handleMediaLoad = useCallback(() => {
    if (isAtBottomRef.current) {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      })
    }
  }, [])

  // Infinite scroll: load older messages when scrolling to top
  const handleScroll = useCallback(() => {
    const list = listRef.current
    if (!list) return
    // Track whether user is at the bottom
    isAtBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 200
    setShowScrollBtn(!isAtBottomRef.current)
    if (loadingOlder || !hasMore) return
    if (list.scrollTop < 100) {
      setLoadingOlder(true)
      const prevHeight = list.scrollHeight
      api.getMessages(channel.id, 50, messages.length)
        .then(async (older) => {
          if (older.length < 50) setHasMore(false)
          if (older.length > 0) {
            const ordered = older.reverse()
            const decrypted = await Promise.all(
              ordered.map(async (m) => {
                if (e2e.isEncryptedContent(m.content)) {
                  const plain = await e2e.decryptMessage(channel.id, m.content)
                  return { ...m, content: plain }
                }
                return m
              })
            )
            setMessages((prev) => [...decrypted, ...prev])
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

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null)
      return
    }
    setSearchLoading(true)
    try {
      const results = await api.searchMessages(channel.id, searchQuery.trim())
      setSearchResults(results.reverse())
    } catch {
      setSearchResults([])
    }
    setSearchLoading(false)
  }, [channel.id, searchQuery])

  const closeSearch = () => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchResults(null)
  }

  const handleInput = (value: string) => {
    setInput(value)
    // Detect @mention — look for @ followed by word chars at end of input
    const mentionMatch = value.match(/@(\w*)$/)
    if (mentionMatch) {
      const query = (mentionMatch[1] ?? '').toLowerCase()
      const filtered = members.filter((u) =>
        u.username.toLowerCase().includes(query) ||
        u.display_name.toLowerCase().includes(query)
      )
      setMentionUsers(filtered.slice(0, 8))
    } else {
      setMentionUsers([])
    }
    if (value) {
      sendTypingStart(channel.id)
      clearTimeout(typingTimerRef.current)
      typingTimerRef.current = setTimeout(() => sendTypingStop(channel.id), 3000)
    } else {
      sendTypingStop(channel.id)
      clearTimeout(typingTimerRef.current)
    }
  }

  const insertMention = (u: User) => {
    const newInput = input.replace(/@(\w*)$/, `@${u.username} `)
    setInput(newInput)
    setMentionUsers([])
    inputRef.current?.focus()
  }

  const handleSend = async (e: FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text && pendingFiles.length === 0) return

    // Wait for any still-uploading files
    const stillUploading = pendingFiles.some(f => !f.id && !f.error)
    if (stillUploading) return // user will retry once uploads finish

    const attachmentIds = pendingFiles.filter(f => f.id).map(f => f.id!)
    setPendingFiles([])
    setUploading(false)

    // Don't send if there's no text and no successful uploads
    if (!text && attachmentIds.length === 0) return

    // Encrypt if E2E is enabled for this channel
    let content = text || ' '
    if (encrypted) {
      if (!encryptionReady) {
        alert('Encryption key not available. You cannot send messages on this encrypted channel until a member with the key comes online.')
        return
      }
      const enc = await e2e.encryptMessage(channel.id, content)
      if (!enc) {
        alert('Failed to encrypt message. Send aborted to protect your privacy.')
        return
      }
      content = enc
    }

    sendChatMessage(channel.id, content, undefined, attachmentIds.length ? attachmentIds : undefined, replyingTo?.id)
    setReplyingTo(null)
    setInput('')
    sendTypingStop(channel.id)
    clearTimeout(typingTimerRef.current)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  // Pre-fill input when entering edit mode — no longer needed for in-place editing
  useEffect(() => {
    if (editingMsg) {
      // Focus is handled by the inline edit input ref callback
    }
  }, [editingMsg])

  // Auto-resize textarea to fit content
  useEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 300) + 'px'
  }, [input])

  const handleReply = (m: Message) => {
    setEditingMsg(null)
    setReplyingTo(m)
    inputRef.current?.focus()
  }

  const handleEdit = (m: Message) => {
    setReplyingTo(null)
    setEditingMsg(m)
    setInlineEditText(m.content)
  }

  const handleDelete = (m: Message) => {
    sendDeleteMessage(m.id)
  }

  const handleInlineEditSave = () => {
    if (editingMsg && inlineEditText.trim()) {
      sendEditMessage(editingMsg.id, inlineEditText.trim())
    }
    setEditingMsg(null)
    setInlineEditText('')
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const handleInlineEditCancel = () => {
    setEditingMsg(null)
    setInlineEditText('')
  }

  const handleHistoryClick = async (m: Message) => {
    setHistoryMsg(m)
    try {
      const hist = await api.getEditHistory(m.id)
      setEditHistory(hist)
    } catch {
      setEditHistory([])
    }
  }

  const startUpload = useCallback((files: File[]) => {
    const newEntries = files.map(file => ({ file, progress: 0 }))
    const baseIdx = pendingCountRef.current
    pendingCountRef.current += newEntries.length

    setPendingFiles(prev => [...prev, ...newEntries])

    // Fire uploads outside the state updater to avoid duplicate calls in StrictMode
    newEntries.forEach((entry, offset) => {
      const idx = baseIdx + offset
      api.uploadFile(entry.file, (pct) => {
        setPendingFiles(cur => cur.map((f, i) => i === idx ? { ...f, progress: pct } : f))
      }).then(res => {
        setPendingFiles(cur => cur.map((f, i) => i === idx ? { ...f, id: res.id, progress: 100 } : f))
      }).catch((err) => {
        const msg = err?.message || 'Upload failed'
        console.error('Upload error:', msg)
        setPendingFiles(cur => cur.map((f, i) => i === idx ? { ...f, error: msg, progress: 0 } : f))
      })
    })
  }, [])

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      startUpload(Array.from(e.target.files))
    }
    e.target.value = ''
  }

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      startUpload(files)
    }
  }, [startUpload])

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    if (e.dataTransfer.types.includes('Files')) setDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) setDragging(false)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(false)
    dragCounter.current = 0
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      startUpload(Array.from(e.dataTransfer.files))
    }
  }

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const formatTime = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  const formatDateTime = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
  }

  // Map of message IDs to refs for scrolling
  const messageRefs = useRef<{ [id: string]: HTMLDivElement | null }>({})

  // Scroll to a message by ID
  const scrollToMessage = (id: string) => {
    const el = messageRefs.current[id]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('reply-jump-highlight')
      setTimeout(() => el.classList.remove('reply-jump-highlight'), 1200)
    }
  }

  return (
    <div className={`chat-view${dragging ? ' drag-over' : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="chat-header">
        <div className="chat-header-left">
          <span className="chat-header-name">
            {channel.server_id ? '#' : '💬'} {channel.server_id ? channel.name : (dmPartnerName || channel.name)}
            {encrypted && <span className="chat-header-lock" title={encryptionReady ? 'End-to-end encrypted' : 'Encrypted — waiting for key'}>{encryptionReady ? '🔒' : '🔓'}</span>}
          </span>
          {channel.description && <span className="chat-header-desc">{channel.description}</span>}
        </div>
        <div className="chat-header-actions">
          <button className="chat-call-btn" onClick={() => setSearchOpen((p) => { if (p) closeSearch(); return !p })} title="Search Messages">
            🔍
          </button>
          {dmPartnerId && onStartCall && (
            <>
              <button className="chat-call-btn" onClick={() => onStartCall(dmPartnerId, false)} title="Voice Call">
                📞
              </button>
              <button className="chat-call-btn" onClick={() => onStartCall(dmPartnerId, true)} title="Video Call">
                📹
              </button>
            </>
          )}
          {showMembersToggle && (
            <button
              className={`chat-header-toggle ${showMembers ? 'active' : ''}`}
              onClick={onToggleMembers}
              title={showMembers ? 'Hide Members' : 'Show Members'}
            >
              👥
            </button>
          )}
        </div>
      </div>

      {searchOpen && (
        <div className="chat-search-bar">
          <input
            type="text"
            className="chat-search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch()
              if (e.key === 'Escape') closeSearch()
            }}
            placeholder="Search messages..."
            autoFocus
          />
          <button className="chat-search-go" onClick={handleSearch} disabled={searchLoading}>
            {searchLoading ? '...' : 'Search'}
          </button>
          <button className="chat-search-close" onClick={closeSearch}>✕</button>
        </div>
      )}

      {searchResults !== null ? (
        <div className="message-list search-results">
          {searchResults.length === 0 ? (
            <div className="no-channel"><p>No results found</p></div>
          ) : searchResults.map((m) => (
            <div key={m.id} className={`message ${m.deleted ? 'deleted' : ''}`}>
              <div className="message-header">
                <span className="message-author" style={m.author?.name_color ? { color: m.author.name_color } : undefined}>
                  {m.author?.display_name || 'Unknown'}
                </span>
                <span className="message-time">{new Date(m.created_at).toLocaleString()}</span>
              </div>
              <div className="message-body">{renderMessageContent(m.content)}</div>
            </div>
          ))}
        </div>
      ) : (
      <div className="message-list" ref={listRef} onScroll={handleScroll} style={!initialScrollDone && messages.length > 0 ? { visibility: 'hidden' } : undefined}>
        {loadingOlder && <div className="loading-older">Loading older messages...</div>}
        {messages.map((m, i) => {
          const urls = extractUrls(m.content)
          const embedImages = urls.filter(isImageUrl)
          const embedLinks = urls.filter((u) => !isImageUrl(u))
          const prev = messages[i - 1]
          const isGrouped = prev && prev.user_id === m.user_id &&
            new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60 * 1000

          return (
            <div
              key={m.id}
              className={`message ${m.user_id === user?.id ? 'own' : ''} ${isGrouped ? 'grouped' : ''}`}
              ref={el => { messageRefs.current[m.id] = el }}
              data-msgid={m.id}
            >
              <div className="message-actions">
                <button className="msg-action-btn" onClick={() => handleReply(m)} title="Reply">↩</button>
                {(m.edited || m.deleted) && (
                  <button className="msg-action-btn" onClick={() => handleHistoryClick(m)} title="View history">🕐</button>
                )}
                {m.user_id === user?.id && !m.deleted && (
                  <button className="msg-action-btn" onClick={() => handleEdit(m)} title="Edit">✏</button>
                )}
                {(m.user_id === user?.id || isAdmin) && !m.deleted && (
                  <button className="msg-action-btn msg-action-delete" onClick={() => handleDelete(m)} title="Delete">🗑</button>
                )}
              </div>
              <div className="message-gutter">
                {isGrouped && <span className="message-gutter-time">{formatTime(m.created_at)}</span>}
              </div>
              <div className="message-content">
                {/* Reply indicator */}
                {(m.reply_to || m.reply_to_id) && (() => {
                  // Resolve the replied-to message from local state for best author data
                  const replyMsg = m.reply_to || messages.find(x => x.id === m.reply_to_id)
                  if (!replyMsg) return null
                  const authorName = replyMsg.author?.display_name || replyMsg.author?.username || replyMsg.user_id
                  return (
                    <div
                      className="replying-to-line"
                      title="Jump to original message"
                      onClick={() => scrollToMessage(replyMsg.id)}
                      tabIndex={0}
                      role="button"
                    >
                      <span className="reply-indicator-arrow">↩</span>
                      <span className="replying-to-author">{authorName}</span>
                      <span className="replying-to-snippet">{replyMsg.content.slice(0, 80)}{replyMsg.content.length > 80 ? '…' : ''}</span>
                    </div>
                  )
                })()}
                {!isGrouped && (
                  <div className="message-header">
                    <span
                      className="message-author clickable"
                      style={(m.user_id === user?.id && user?.name_color) ? { color: user.name_color } : m.author?.name_color ? { color: m.author.name_color } : undefined}
                      onClick={(e) => {
                      if (popover?.userId === m.user_id) {
                        setPopover(null)
                        return
                      }
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setPopover({ userId: m.user_id, rect })
                    }}>{m.user_id === user?.id ? (user?.display_name ?? m.author?.display_name ?? m.user_id) : (m.author?.display_name ?? m.user_id)}</span>
                    <span className="message-time">{formatTime(m.created_at)}</span>
                  </div>
                )}
                {m.deleted ? (
                  <div className="message-body message-deleted">This message was deleted.</div>
                ) : editingMsg?.id === m.id ? (
                  <div className="inline-edit-wrapper">
                    <textarea
                      className="inline-edit-textarea"
                      value={inlineEditText}
                      onChange={(e) => setInlineEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { e.preventDefault(); handleInlineEditCancel() }
                        if (e.key === 'Enter' && !e.shiftKey) {
                          const backtickCount = (inlineEditText.match(/```/g) || []).length
                          if (backtickCount % 2 !== 0) return
                          e.preventDefault(); handleInlineEditSave()
                        }
                      }}
                      autoFocus
                      ref={(el) => {
                        if (el) {
                          el.style.height = 'auto'
                          el.style.height = Math.min(el.scrollHeight, 300) + 'px'
                          // Place cursor at end of text
                          const len = el.value.length
                          el.setSelectionRange(len, len)
                        }
                      }}
                    />
                    <div className="inline-edit-actions">
                      <span className="inline-edit-hint">Escape to cancel · Enter to save</span>
                      <button className="inline-edit-cancel" onClick={handleInlineEditCancel}>Cancel</button>
                      <button className="inline-edit-save" onClick={handleInlineEditSave}>Save</button>
                    </div>
                  </div>
                ) : (
                  <div className="message-body">
                    {renderMessageContent(m.content)}
                    {m.edited && (
                      <span
                        className="edited-badge"
                        onClick={() => handleHistoryClick(m)}
                        title={`Last edited: ${formatDateTime(m.updated_at)}`}
                      >
                        (edited)
                      </span>
                    )}
                  </div>
                )}
                {!m.deleted && m.attachments && m.attachments.length > 0 && (
                  <div className="message-attachments">
                    {m.attachments.map((a) => {
                      const isImage = /^image\//i.test(a.mime_type)
                      const isVideo = /^video\//i.test(a.mime_type)
                      const isAudio = /^audio\//i.test(a.mime_type)
                      if (isImage) return (
                        <a key={a.id} href={api.fileURL(a.id)} target="_blank" rel="noreferrer">
                          <img src={api.fileURL(a.id)} alt={a.filename} className="attachment-image" onLoad={handleMediaLoad} />
                        </a>
                      )
                      if (isVideo) return (
                        <video key={a.id} src={api.fileURL(a.id)} controls className="attachment-video" />
                      )
                      if (isAudio) return (
                        <audio key={a.id} src={api.fileURL(a.id)} controls className="attachment-audio" />
                      )
                      return (
                        <a key={a.id} href={api.fileURL(a.id)} target="_blank" rel="noreferrer" className="attachment-link">
                          📎 {a.filename} ({(a.file_size / 1024).toFixed(1)} KB)
                        </a>
                      )
                    })}
                  </div>
                )}
                {!m.deleted && embedImages.length > 0 && (
                  <div className="message-embeds">
                    {embedImages.map((url, i) => (
                      <a key={i} href={url} target="_blank" rel="noreferrer">
                        <img src={url} alt="" className="embed-image" onLoad={handleMediaLoad} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      </a>
                    ))}
                  </div>
                )}
                {!m.deleted && embedLinks.length > 0 && (
                  <div className="message-embeds">
                    {embedLinks.map((url, i) => (
                      <LinkEmbed key={i} url={url} onImageLoad={handleMediaLoad} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
      )}

      {showScrollBtn && (
        <button className="scroll-to-bottom-btn" onClick={() => {
          bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
        }} title="Jump to latest">
          ↓
        </button>
      )}

      {typingUsers.size > 0 && (
        <div className="typing-indicator">
          {Array.from(typingUsers.values()).join(', ')} typing...
        </div>
      )}

      {replyingTo && (
        <div className="reply-bar">
          <span className="reply-bar-text">↩ Replying to <strong>{replyingTo.author?.display_name ?? replyingTo.user_id}</strong>: {replyingTo.content.slice(0, 60)}{replyingTo.content.length > 60 ? '…' : ''}</span>
          <button className="reply-bar-cancel" onClick={() => setReplyingTo(null)}>×</button>
        </div>
      )}

      {pendingFiles.length > 0 && (
        <div className="pending-files">
          {pendingFiles.map((f, i) => (
            <div key={i} className={`pending-file${f.error ? ' pending-file-error' : ''}`}>
              <span className="pending-file-name">📎 {f.file.name}</span>
              {!f.id && !f.error && (
                <span className="pending-file-progress">{f.progress > 0 ? `${f.progress}%` : 'uploading…'}</span>
              )}
              {f.id && <span className="pending-file-done">✓</span>}
              {f.error && <span className="pending-file-error-text">{f.error}</span>}
              <button className="pending-file-remove" onClick={() => removePendingFile(i)}>×</button>
            </div>
          ))}
        </div>
      )}

      <div className="input-wrapper">
        {mentionUsers.length > 0 && (
          <div className="mention-dropdown">
            {mentionUsers.map((u) => (
              <div key={u.id} className="mention-item" onMouseDown={(e) => { e.preventDefault(); insertMention(u) }}>
                <span className="mention-item-name">{u.display_name}</span>
                <span className="mention-item-handle">@{u.username}</span>
              </div>
            ))}
          </div>
        )}
        <form className="message-input" onSubmit={handleSend}>
          <input type="file" ref={fileInputRef} onChange={handleFileSelect} multiple style={{ display: 'none' }} />
          <button type="button" className="upload-btn" onClick={() => fileInputRef.current?.click()} title="Upload file">
            📎
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => handleInput(e.target.value)}
            onPaste={handlePaste}
            placeholder={encrypted && !encryptionReady ? '🔓 Waiting for encryption key...' : `Message ${channel.server_id ? '#' + channel.name : (dmPartnerName || channel.name || 'this channel')}`}
            disabled={encrypted && !encryptionReady}
            autoFocus
            rows={1}
            className="message-textarea"
            onKeyDown={e => {
              if (e.key === 'Escape') {
                if (replyingTo) {
                  e.preventDefault()
                  setReplyingTo(null)
                }
              }
              if (e.key === 'ArrowUp' && !input && !editingMsg) {
                const myLastMsg = [...messages].reverse().find(m => m.user_id === user?.id && !m.deleted)
                if (myLastMsg) {
                  e.preventDefault()
                  handleEdit(myLastMsg)
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                // If there's an unclosed code block (odd number of ```), Enter = newline
                const backtickCount = (input.match(/```/g) || []).length
                if (backtickCount % 2 !== 0) return
                e.preventDefault();
                handleSend(e as unknown as FormEvent);
              }
            }}
          />
          <button type="submit" disabled={uploading || pendingFiles.some(f => !f.id && !f.error)}>{pendingFiles.some(f => !f.id && !f.error) ? 'Uploading…' : 'Send'}</button>
        </form>
      </div>

      {historyMsg && (
        <div className="history-modal-backdrop" onClick={() => setHistoryMsg(null)}>
          <div className="history-modal" onClick={(e) => e.stopPropagation()}>
            <div className="history-modal-header">
              <span>Edit history</span>
              <button className="history-modal-close" onClick={() => setHistoryMsg(null)}>×</button>
            </div>
            <div className="history-modal-body">
              {/* Original message */}
              <div className="history-entry history-entry-original">
                <div className="history-entry-time">Original — {historyMsg ? formatDateTime(historyMsg.created_at) : ''}</div>
                <div className="history-entry-content">{editHistory.length > 0 ? (editHistory[0]?.content ?? '') : historyMsg?.content ?? ''}</div>
              </div>
              {editHistory.length === 0 ? (
                <div className="history-empty">No edit history available.</div>
              ) : (
                editHistory.map((h, idx) => {
                  // Hide first edit if it is identical to the original
                  if (idx === 0 && h.content === (editHistory[0]?.content ?? historyMsg?.content)) return null;
                  const prevEdit = idx > 0 ? editHistory[idx - 1] : null
                  return (
                    <div key={h.id} className="history-entry"
                      onMouseEnter={e => e.currentTarget.classList.add('history-entry-hover')}
                      onMouseLeave={e => e.currentTarget.classList.remove('history-entry-hover')}
                    >
                      <div className="history-entry-time">
                        {idx === 0
                          ? `Edited — ${historyMsg ? formatDateTime(historyMsg.created_at) : ''}`
                          : `Edited — ${prevEdit ? formatDateTime(prevEdit.edited_at) : ''}`}
                      </div>
                      <div className="history-entry-content">{h.content}</div>
                    </div>
                  );
                })
              )}
              <div className="history-entry history-entry-current">
                <div className="history-entry-time">
                  Current{historyMsg?.deleted ? ' — deleted' : ''} — {editHistory.length > 0 ? formatDateTime(editHistory[editHistory.length - 1]?.edited_at ?? '') : historyMsg ? formatDateTime(historyMsg.created_at) : ''}
                </div>
                <div className={`history-entry-content${historyMsg?.deleted ? ' message-deleted' : ''}`}>{historyMsg?.deleted ? 'This message was deleted.' : historyMsg?.content}</div>
              </div>
              {historyMsg?.attachments && historyMsg.attachments.length > 0 && (
                <div className="history-entry">
                  <div className="history-entry-time">Attachments</div>
                  <div className="history-entry-attachments">
                    {historyMsg.attachments.map((a) => {
                      const isImage = /^image\//i.test(a.mime_type)
                      return isImage ? (
                        <a key={a.id} href={api.fileURL(a.id)} target="_blank" rel="noreferrer">
                          <img src={api.fileURL(a.id)} alt={a.filename} className="history-attachment-image" />
                        </a>
                      ) : (
                        <a key={a.id} href={api.fileURL(a.id)} target="_blank" rel="noreferrer" className="attachment-link">
                          📎 {a.filename}
                        </a>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {popover && (
        <UserPopover
          userId={popover.userId}
          anchorRect={popover.rect}
          onClose={() => setPopover(null)}
          onMessage={onDMUser}
        />
      )}
    </div>
  )
}
