import { useEffect, useRef, useState, useCallback, type FormEvent, type ChangeEvent } from 'react'
import type { Channel, Message, MessageEdit, User, ServerMember, WSMessage as WSMsg } from '../types'
import * as api from '../services/api'
import hljs from 'highlight.js'
import { sendChatMessage, sendTypingStart, sendTypingStop, sendEditMessage, sendDeleteMessage, subscribe, send } from '../services/ws'
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

const EMOJI_MAP: Record<string, string> = {
  smile: '😄', smiley: '😃', grin: '😁', grinning: '😀', laugh: '😆', sweat_smile: '😅',
  joy: '😂', rofl: '🤣', wink: '😉', blush: '😊', innocent: '😇', heart_eyes: '😍',
  kissing_heart: '😘', kiss: '😗', yum: '😋', stuck_out_tongue: '😛', stuck_out_tongue_winking_eye: '😜',
  zany: '🤪', thinking: '🤔', shushing: '🤫', hand_over_mouth: '🤭', zipper_mouth: '🤐',
  raised_eyebrow: '🤨', neutral: '😐', expressionless: '😑', no_mouth: '😶', smirk: '😏',
  unamused: '😒', rolling_eyes: '🙄', grimace: '😬', lying: '🤥', relieved: '😌',
  pensive: '😔', sleepy: '😪', drool: '🤤', sleeping: '😴', mask: '😷', thermometer: '🤒',
  head_bandage: '🤕', nauseated: '🤢', vomiting: '🤮', sneezing: '🤧', hot: '🥵', cold: '🥶',
  dizzy: '😵', exploding_head: '🤯', cowboy: '🤠', partying: '🥳', sunglasses: '😎',
  nerd: '🤓', monocle: '🧐', confused: '😕', worried: '😟', frown: '☹️', open_mouth: '😮',
  hushed: '😯', astonished: '😲', flushed: '😳', pleading: '🥺', crying: '😢', sob: '😭',
  scream: '😱', angry: '😠', rage: '🤬', skull: '💀', poop: '💩', clown: '🤡', ghost: '👻',
  alien: '👽', robot: '🤖', heart: '❤️', orange_heart: '🧡', yellow_heart: '💛',
  green_heart: '💚', blue_heart: '💙', purple_heart: '💜', black_heart: '🖤', white_heart: '🤍',
  broken_heart: '💔', fire: '🔥', star: '⭐', sparkles: '✨', zap: '⚡', boom: '💥',
  wave: '👋', ok_hand: '👌', pinching: '🤏', v: '✌️', crossed_fingers: '🤞', love_you: '🤟',
  metal: '🤘', call_me: '🤙', point_up: '☝️', point_down: '👇', point_left: '👈', point_right: '👉',
  thumbsup: '👍', thumbsdown: '👎', fist: '✊', punch: '👊', clap: '👏', raised_hands: '🙌',
  pray: '🙏', handshake: '🤝', muscle: '💪', brain: '🧠', eyes: '👀', tongue: '👅',
  lips: '👄', baby: '👶', man: '👨', woman: '👩', rocket: '🚀', rainbow: '🌈', sun: '☀️',
  moon: '🌙', cloud: '☁️', umbrella: '☂️', snowflake: '❄️', christmas_tree: '🎄',
  gift: '🎁', tada: '🎉', trophy: '🏆', medal: '🏅', soccer: '⚽', basketball: '🏀',
  football: '🏈', baseball: '⚾', guitar: '🎸', microphone: '🎤', headphones: '🎧',
  art: '🎨', movie: '🎬', pizza: '🍕', hamburger: '🍔', fries: '🍟', hotdog: '🌭',
  taco: '🌮', burrito: '🌯', cookie: '🍪', cake: '🎂', icecream: '🍦', coffee: '☕',
  beer: '🍺', wine: '🍷', cocktail: '🍸', champagne: '🍾', dog: '🐶', cat: '🐱',
  mouse_face: '🐭', hamster: '🐹', rabbit: '🐰', fox: '🦊', bear: '🐻', panda: '🐼',
  penguin: '🐧', chicken: '🐔', frog: '🐸', snake: '🐍', whale: '🐳', dolphin: '🐬',
  butterfly: '🦋', bee: '🐝', bug: '🐛', crab: '🦀', shrimp: '🦐', squid: '🦑',
  rose: '🌹', sunflower: '🌻', herb: '🌿', maple_leaf: '🍁', mushroom: '🍄',
  earth: '🌍', volcano: '🌋', tent: '⛺', house: '🏠', office: '🏢',
  check: '✅', x: '❌', warning: '⚠️', no_entry: '⛔', question: '❓',
  exclamation: '❗', '100': '💯', zzz: '💤', speech: '💬', thought: '💭',
  wave_dash: '〰️', infinity: '♾️', peace: '☮️', yin_yang: '☯️',
  plus: '➕', minus: '➖', lock: '🔒', unlock: '🔓', key: '🔑', bell: '🔔',
  link: '🔗', gem: '💎', bulb: '💡', bomb: '💣', knife: '🔪', pill: '💊',
  mag: '🔍', pin: '📌', paperclip: '📎', scissors: '✂️', pencil: '✏️',
  book: '📖', calendar: '📅', clock: '🕐', hourglass: '⏳', phone: '📱',
  computer: '💻', keyboard: '⌨️', printer: '🖨️', mouse: '🖱️',
  cd: '💿', floppy: '💾', camera: '📷', tv: '📺', radio: '📻',
  pager: '📟', mailbox: '📫', package: '📦', trash: '🗑️', scroll: '📜',
  crown: '👑', ring: '💍', money: '💰', dollar: '💵', credit_card: '💳',
  chart: '📈', flag: '🏁', checkered_flag: '🏁', triangular_flag: '🚩',
  crossed_swords: '⚔️', shield: '🛡️', bow: '🏹', wrench: '🔧', hammer: '🔨',
  gear: '⚙️', chains: '⛓️', magnet: '🧲', test_tube: '🧪', dna: '🧬',
  satellite: '🛰️', spaceship: '🛸', up: '⬆️', down: '⬇️', left: '⬅️', right: '➡️',
}

function extractUrls(text: string): string[] {
  return text.match(URL_REGEX) || []
}

function isImageUrl(url: string): boolean {
  return IMAGE_EXT.test(url)
}

// Formatting: ||spoilers||, ***bold italic***, **bold**, *italics*, ~~strikethrough~~, `code`, @mentions, :emote:
function renderFormattedText(text: string, keyPrefix: string, selfUsername?: string): (string | React.ReactElement)[] {
  const FORMAT_REGEX = /(\|\|.+?\|\||\*\*\*.+?\*\*\*|\*\*.+?\*\*|\*.+?\*|~~.+?~~|`.+?`|@\w+|:\w+:)/g
  const parts = text.split(FORMAT_REGEX)
  return parts.map((part, i) => {
    if (part.startsWith('||') && part.endsWith('||')) {
      const inner = part.slice(2, -2)
      return <span key={`${keyPrefix}-${i}`} className="spoiler" onClick={(e) => (e.currentTarget.classList.toggle('revealed'))}>{inner}</span>
    }
    if (part.startsWith('***') && part.endsWith('***') && part.length > 6) {
      return <strong key={`${keyPrefix}-${i}`}><em>{part.slice(3, -3)}</em></strong>
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
    if (part.startsWith('@') && part.length > 1) {
      const isSelf = selfUsername && part.slice(1).toLowerCase() === selfUsername.toLowerCase()
      return <span key={`${keyPrefix}-${i}`} className={`mention-highlight${isSelf ? ' mention-self' : ''}`}>@{part.slice(1)}</span>
    }
    if (part.startsWith(':') && part.endsWith(':') && part.length > 2) {
      const name = part.slice(1, -1).toLowerCase()
      const emoji = EMOJI_MAP[name]
      if (emoji) return <span key={`${keyPrefix}-${i}`} title={`:${name}:`}>{emoji}</span>
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

function renderMessageContent(content: string, selfUsername?: string) {
  const result: (string | React.ReactElement)[] = []
  // Split on triple-backtick code blocks first
  const CODE_BLOCK_REGEX = /```([\w]*)?\n?([\s\S]*?)```/g
  let lastIndex = 0
  let blockIndex = 0
  let match: RegExpExecArray | null

  while ((match = CODE_BLOCK_REGEX.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index)
    if (before) renderInlineContent(before, `pre${blockIndex}`, result, selfUsername)
    const lang = (match[1] ?? '').trim()
    const code = match[2] ?? ''
    result.push(renderCodeBlock(lang, code, `cb${blockIndex}`))
    lastIndex = match.index + match[0].length
    blockIndex++
  }
  const remaining = content.slice(lastIndex)
  if (remaining) renderInlineContent(remaining, `pre${blockIndex}`, result, selfUsername)
  return result
}

function renderInlineContent(text: string, keyPrefix: string, result: (string | React.ReactElement)[], selfUsername?: string) {
  // Split by URLs, then by newlines
  const parts = text.split(URL_REGEX)
  const urls = text.match(URL_REGEX) || []

  parts.forEach((part, i) => {
    if (part) {
      const lines = part.split(/\n/)
      lines.forEach((line, j) => {
        if (line) result.push(...renderFormattedText(line, `${keyPrefix}-f${i}-${j}`, selfUsername))
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

function EncryptedAttachment({ attachmentId, channelId, filename, onLoad }: { attachmentId: string; channelId: string; filename: string; onLoad?: () => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const origName = filename.replace(/\.enc$/, '')
  const ext = origName.split('.').pop()?.toLowerCase() || ''
  const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']
  const vidExts = ['mp4', 'webm', 'ogg', 'mov']
  const audExts = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a']
  const isImage = imgExts.includes(ext)
  const isVideo = vidExts.includes(ext)
  const isAudio = audExts.includes(ext)

  useEffect(() => {
    let revoked = false
    ;(async () => {
      try {
        const res = await fetch(api.fileURL(attachmentId))
        if (!res.ok) { setError(true); return }
        const encBytes = await res.arrayBuffer()
        const dec = await e2e.decryptFile(channelId, encBytes)
        if (!dec || revoked) { if (!dec) setError(true); return }
        const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', ogg: 'application/ogg', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4' }
        const mime = mimeMap[ext] || 'application/octet-stream'
        const url = URL.createObjectURL(new Blob([dec], { type: mime }))
        if (!revoked) setBlobUrl(url)
        else URL.revokeObjectURL(url)
      } catch { setError(true) }
    })()
    return () => { revoked = true }
  }, [attachmentId, channelId, ext])

  useEffect(() => { return () => { if (blobUrl) URL.revokeObjectURL(blobUrl) } }, [blobUrl])

  if (error) return <span className="attachment-link">🔒 {origName} (decryption failed)</span>
  if (!blobUrl) return <span className="attachment-link">🔒 Decrypting {origName}…</span>
  if (isImage) return (
    <a href={blobUrl} target="_blank" rel="noreferrer">
      <img src={blobUrl} alt={origName} className="attachment-image" onLoad={onLoad} />
    </a>
  )
  if (isVideo) return <video src={blobUrl} controls className="attachment-video" />
  if (isAudio) return <audio src={blobUrl} controls className="attachment-audio" />
  return (
    <a href={blobUrl} download={origName} className="attachment-link">
      🔒 📎 {origName}
    </a>
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
  const [emoteResults, setEmoteResults] = useState<[string, string][]>([])
  const [acIndex, setAcIndex] = useState(0)
  const [popover, setPopover] = useState<{ userId: string; rect: DOMRect } | null>(null)
  const [encrypted, setEncrypted] = useState(false)
  const [encryptionReady, setEncryptionReady] = useState(false)
  const [reDecryptTrigger, setReDecryptTrigger] = useState(0)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Message[] | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
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
  const encryptedRef = useRef(false)
  const channelIdRef = useRef(channel.id)
  encryptedRef.current = encrypted
  channelIdRef.current = channel.id

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

  // Track whether we've already sent a key_request for this channel
  const keyRequestSentRef = useRef(false)

  // Check if channel has E2E encryption enabled
  const checkEncryption = useCallback(async (forceRefresh = false) => {
    try {
      const enc = await e2e.isChannelEncrypted(channel.id)
      setEncrypted(enc)
      if (enc) {
        const key = await e2e.getChannelKey(channel.id, forceRefresh)
        setEncryptionReady(key !== null)
        console.log('%c[E2E]', 'color: #00e0ff; font-weight: bold', `Channel ${channel.id.slice(0,8)}… encrypted=${enc} keyReady=${key !== null}`)
        if (key) {
          // We have the key — but if this is a new device that only has master keys
          // (no per-device entry), rotate to establish a new epoch for forward secrecy.
          if (!keyRequestSentRef.current) {
            const hasEntry = await e2e.hasDeviceKeyEntry(channel.id)
            if (!hasEntry) {
              keyRequestSentRef.current = true
              console.log('%c[E2E]', 'color: #00e0ff; font-weight: bold', `New device — rotating for channel ${channel.id.slice(0,8)}…`)
              await e2e.rotateKeys(channel.id)
              setEncryptionReady(true)
              return true
            }
          }
          // Existing device — redistribute to our other devices only
          e2e.redistributeKeys(channel.id)
        } else if (!keyRequestSentRef.current) {
          // No key for this device — self-rotate per protocol §8.5.3:
          // generate new epoch key ourselves and distribute to all devices.
          // This avoids depending on another user being online.
          keyRequestSentRef.current = true
          console.log('%c[E2E]', 'color: #00e0ff; font-weight: bold', `Self-rotating for channel ${channel.id.slice(0,8)}…`)
          const rotated = await e2e.rotateKeys(channel.id)
          if (rotated) {
            setEncryptionReady(true)
            // Ask other members to redistribute their older epoch keys to us
            // so we can decrypt historical messages from before we joined.
            send('key_request', { channel_id: channel.id })
            return true
          }
          // Fallback: ask others to rotate if self-rotation failed
          send('key_request', { channel_id: channel.id })
        }
        return key !== null
      } else {
        setEncryptionReady(false)
        return true // not encrypted, no key needed
      }
    } catch {
      setEncrypted(false)
      return true
    }
  }, [channel.id])

  useEffect(() => {
    let cancelled = false
    setEncrypted(false)
    setEncryptionReady(false)
    keyRequestSentRef.current = false // reset on channel change

    // Retry key check — another client may not have distributed the key yet
    const tryCheck = async (attempt: number) => {
      if (cancelled) return
      const ready = await checkEncryption(attempt > 1) // force refresh on retries
      if (!ready && !cancelled && attempt < 5) {
        setTimeout(() => tryCheck(attempt + 1), 2000 * attempt)
      }
    }
    tryCheck(1)
    return () => { cancelled = true }
  }, [channel.id, channel.server_id, checkEncryption])

  // When the encryption key becomes available, re-decrypt any messages
  // that were loaded before the key was distributed to this device.
  useEffect(() => {
    if (!encryptionReady) return
    let cancelled = false
    // Fetch raw encrypted content from server, re-decrypt locally
    api.getMessages(channel.id, 50, 0).then(async (rawMsgs) => {
      if (cancelled) return
      const rawMap = new Map(rawMsgs.map((m) => [m.id, m]))
      setMessages((prev) => {
        if (!prev.some((m) => m.content.includes('[encrypted'))) return prev
        // Start async re-decryption then replace in-place
        const redecrypt = async () => {
          const updated = await Promise.all(
            prev.map(async (m) => {
              if (!m.content.includes('[encrypted')) return m
              const raw = rawMap.get(m.id)
              if (!raw || !e2e.isEncryptedContent(raw.content)) return m
              const result = await e2e.decryptMessage(channel.id, raw.content, raw.key_epoch, undefined, true)
              return { ...m, content: result.text, verified: result.verified }
            })
          )
          if (!cancelled) {
            // Replace messages in-place without duplicating
            setMessages((current) => {
              const updatedMap = new Map(updated.map(m => [m.id, m]))
              return current.map(m => updatedMap.get(m.id) ?? m)
            })
          }
        }
        redecrypt()
        return prev
      })
    }).catch(console.error)
    return () => { cancelled = true }
  }, [encryptionReady, channel.id, reDecryptTrigger])

  // Re-check encryption when it's enabled from ChannelSettings
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.channelId === channel.id) checkEncryption()
    }
    window.addEventListener('channel-encryption-enabled', handler)
    return () => window.removeEventListener('channel-encryption-enabled', handler)
  }, [channel.id, checkEncryption])

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
    let stale = false
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
    // Auto-focus the message input when switching channels
    setTimeout(() => inputRef.current?.focus(), 0)
    api.getMessages(channel.id).then(async (msgs) => {
      if (stale) return
      const ordered = msgs.reverse()
      // Pre-warm all epoch keys before bulk decryption to avoid redundant API calls
      if (ordered.some(m => e2e.isEncryptedContent(m.content))) {
        await e2e.preWarmKeys(channel.id)
      }
      // Decrypt any E2E-encrypted messages
      const decrypted = await Promise.all(
        ordered.map(async (m) => {
          seenMsgIds.current.add(m.id)
          if (e2e.isEncryptedContent(m.content)) {
            const result = await e2e.decryptMessage(channel.id, m.content, m.key_epoch, undefined, true)
            return { ...m, content: result.text, verified: result.verified }
          }
          return m
        })
      )
      if (!stale) setMessages(decrypted)
    }).catch(console.error)
    return () => { stale = true }
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
              const result = await e2e.decryptMessage(channel.id, m.content, m.key_epoch)
              decrypted = { ...m, content: result.text, verified: result.verified }
              // If decryption failed (missing key), the re-decrypt effect will
              // pick it up once the key arrives via channel_keys_updated.
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
          const handleEdit = async () => {
            let updated = m
            if (e2e.isEncryptedContent(m.content)) {
              const result = await e2e.decryptMessage(channel.id, m.content, m.key_epoch)
              updated = { ...m, content: result.text, verified: result.verified }
            }
            setMessages((prev) => prev.map((x) => x.id === updated.id ? { ...x, ...updated } : x))
          }
          handleEdit()
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
        // Membership changed — rotation is handled globally in Home.tsx (which sends channel_keys_updated).
        // Just re-check encryption state after a delay to pick up the new epoch.
        // Do NOT clear keys here — the channel_keys_updated handler will load new epoch additively.
        if (encrypted && channel.server_id) {
          const p = msg.payload as { server_id: string }
          if (p.server_id === channel.server_id) {
            setTimeout(() => {
              e2e.getChannelKey(channel.id, true).then((key) => {
                if (key) setEncryptionReady(true)
              })
            }, 3000)
          }
        }
      } else if (msg.type === 'channel_keys_updated') {
        // A key was distributed for this channel — try loading the notified epoch directly.
        // Do NOT clear the channel key cache — just load the new epoch additively.
        // This avoids nuking existing keys when multiple notifications arrive during distribution.
        const p = msg.payload as { channel_id: string; epoch: number }
        if (p.channel_id === channel.id) {
          console.log('%c[E2E]', 'color: #00e0ff; font-weight: bold', `Key update notification: channel=${channel.id.slice(0,8)}… epoch=${p.epoch}`)
          // Retry with increasing delays — distribution to many devices can take 10+ seconds.
          const tryLoadEpoch = (attempt: number) => {
            e2e.invalidateCachedEpoch(channel.id, p.epoch)
            e2e.getChannelKeyForEpoch(channel.id, p.epoch).then((key) => {
              if (key) {
                setEncryptionReady(true)
                setEncrypted(true)
                // Trigger re-decryption of any [encrypted — missing key] messages
                setReDecryptTrigger(n => n + 1)
              } else if (attempt < 10) {
                setTimeout(() => tryLoadEpoch(attempt + 1), 2000)
              } else {
                // Exhausted retries — ask peers to redistribute the key
                console.log('%c[E2E]', 'color: #ffaa00; font-weight: bold', `Key load failed after ${attempt} attempts — sending key_request`)
                send('key_request', { channel_id: channel.id })
              }
            }).catch(() => {})
          }
          tryLoadEpoch(1)
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
                seenMsgIds.current.add(m.id)
                if (e2e.isEncryptedContent(m.content)) {
                  const result = await e2e.decryptMessage(channel.id, m.content, m.key_epoch, undefined, true)
                  return { ...m, content: result.text, verified: result.verified }
                }
                return m
              })
            )
            setMessages((prev) => {
              const existingIds = new Set(prev.map(p => p.id))
              const newMsgs = decrypted.filter(m => !existingIds.has(m.id))
              return [...newMsgs, ...prev]
            })
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
      // Decrypt any encrypted results
      const decrypted = await Promise.all(
        results.map(async (m) => {
          if (e2e.isEncryptedContent(m.content)) {
            const result = await e2e.decryptMessage(channel.id, m.content, m.key_epoch, undefined, true)
            return { ...m, content: result.text, verified: result.verified }
          }
          return m
        })
      )
      setSearchResults(decrypted.reverse())
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
      setEmoteResults([])
      setAcIndex(0)
    } else {
      setMentionUsers([])
      // Detect :emote pattern at end of input (at least 2 chars after colon)
      const emoteMatch = value.match(/:(\w{2,})$/)
      if (emoteMatch) {
        const q = (emoteMatch[1] ?? '').toLowerCase()
        const matches = Object.entries(EMOJI_MAP).filter(([k]) => k.includes(q)).slice(0, 8)
        setEmoteResults(matches)
        setAcIndex(0)
      } else {
        setEmoteResults([])
      }
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
    setAcIndex(0)
    inputRef.current?.focus()
  }

  const insertEmote = (emoji: string) => {
    const newInput = input.replace(/:(\w*)$/, emoji)
    setInput(newInput)
    setEmoteResults([])
    setAcIndex(0)
    inputRef.current?.focus()
  }

  const handleSend = async (e: FormEvent) => {
    e.preventDefault()
    let text = input.trim()
    if (!text && pendingFiles.length === 0) return

    // Wait for any still-uploading files
    const stillUploading = pendingFiles.some(f => !f.id && !f.error)
    if (stillUploading) return // user will retry once uploads finish

    const attachmentIds = pendingFiles.filter(f => f.id).map(f => f.id!)
    setPendingFiles([])
    setUploading(false)
    pendingCountRef.current = 0

    // Don't send if there's no text and no successful uploads
    if (!text && attachmentIds.length === 0) return

    // If text exceeds limit, convert to a message.txt file attachment
    const TEXT_LIMIT = 5000
    if (text.length > TEXT_LIMIT) {
      try {
        const blob = new Blob([text], { type: 'text/plain' })
        const file = new File([blob], 'message.txt', { type: 'text/plain' })
        const res = await api.uploadFile(file, () => {})
        attachmentIds.push(res.id)
        text = text.slice(0, 200) + '… *(full message attached as message.txt)*'
      } catch {
        alert('Failed to upload long message as file.')
        return
      }
    }

    // Encrypt if E2E is enabled for this channel
    let content = text || ' '
    let keyEpoch = 0
    if (encrypted) {
      if (!encryptionReady) {
        // No key yet — try to fetch it first (another client may have distributed it)
        const freshKey = await e2e.getChannelKey(channel.id, true)
        if (freshKey) {
          setEncryptionReady(true)
        } else {
          // Still no key — rotate to a new epoch so this device can participate
          const rotated = await e2e.rotateKeys(channel.id)
          if (!rotated) {
            alert('Failed to create encryption key. Please try again.')
            return
          }
          setEncryptionReady(true)
        }
      }
      let enc = await e2e.encryptMessage(channel.id, content)
      if (!enc) {
        // Retry once: invalidate cache and reload key from server
        e2e.invalidateCachedEpoch(channel.id, await e2e.getCurrentEpoch(channel.id))
        const retryKey = await e2e.getChannelKey(channel.id, true)
        if (retryKey) enc = await e2e.encryptMessage(channel.id, content)
      }
      if (!enc) {
        alert('Failed to encrypt message. Send aborted to protect your privacy.')
        return
      }
      console.log('%c[E2E]', 'color: #00e0ff; font-weight: bold', `Sending encrypted: epoch=${enc.epoch} len=${enc.encrypted.length}`)
      content = enc.encrypted
      keyEpoch = enc.epoch
    }

    sendChatMessage(channel.id, content, undefined, attachmentIds.length ? attachmentIds : undefined, replyingTo?.id, keyEpoch)
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

  const handleInlineEditSave = async () => {
    if (editingMsg && inlineEditText.trim()) {
      let content = inlineEditText.trim()
      if (encrypted) {
        const enc = await e2e.encryptMessage(channel.id, content)
        if (enc) {
          content = enc.encrypted
        }
      }
      sendEditMessage(editingMsg.id, content)
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
      const doUpload = async () => {
        let fileToUpload = entry.file
        // Encrypt file if channel has E2EE enabled
        if (encryptedRef.current) {
          try {
            const buf = await entry.file.arrayBuffer()
            const enc = await e2e.encryptFile(channelIdRef.current, buf)
            if (enc) {
              fileToUpload = new File([enc], entry.file.name + '.enc', { type: 'application/octet-stream' })
            }
          } catch (err) {
            console.error('File encryption failed:', err)
          }
        }
        return api.uploadFile(fileToUpload, (pct) => {
          setPendingFiles(cur => cur.map((f, i) => i === idx ? { ...f, progress: pct } : f))
        })
      }
      doUpload().then(res => {
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
    if (dragCounter.current <= 0) {
      dragCounter.current = 0
      setDragging(false)
    }
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

  // Reset drag overlay when window loses focus or drag leaves the document
  useEffect(() => {
    const resetDrag = () => {
      dragCounter.current = 0
      setDragging(false)
    }
    const handleDocDragLeave = (e: DragEvent) => {
      // Only reset if dragging out of the window (relatedTarget is null)
      if (e.relatedTarget === null && (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight)) {
        resetDrag()
      }
    }
    window.addEventListener('blur', resetDrag)
    document.addEventListener('dragleave', handleDocDragLeave)
    document.addEventListener('dragend', resetDrag)
    return () => {
      window.removeEventListener('blur', resetDrag)
      document.removeEventListener('dragleave', handleDocDragLeave)
      document.removeEventListener('dragend', resetDrag)
    }
  }, [])

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

          const isMentioned = user?.username && new RegExp(`@${user.username}\\b`, 'i').test(m.content)
          const isReplyToSelf = !!user && (m.reply_to?.user_id === user.id || (!m.reply_to && m.reply_to_id && messages.find(x => x.id === m.reply_to_id)?.user_id === user.id))

          return (
            <div
              key={m.id}
              className={`message ${m.user_id === user?.id ? 'own' : ''} ${isGrouped ? 'grouped' : ''}${isMentioned ? ' mentioned' : ''}${isReplyToSelf && m.user_id !== user?.id ? ' replied-to-self' : ''}`}
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
                {isGrouped && (
                  <span className="message-gutter-time">{formatTime(m.created_at)}</span>
                )}
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
                    {renderMessageContent(m.content, user?.username)}
                    {m.verified === false && (
                      <span className="sig-badge sig-bad" title="Signature verification failed">⚠</span>
                    )}
                    {m.verified === true && (
                      <span className="sig-badge sig-ok" title="Signature verified">🔒</span>
                    )}
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
                      if (a.filename.endsWith('.enc')) {
                        return <EncryptedAttachment key={a.id} attachmentId={a.id} channelId={channel.id} filename={a.filename} onLoad={handleMediaLoad} />
                      }
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
        {showEmojiPicker && (
          <div className="emoji-picker">
            {[
              { cat: 'Smileys', emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊','😇','🥰','😍','🤩','😘','😋','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','😐','😑','😶','😏','😒','🙄','😬','😮‍💨','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤮','🥴','😵','🤯','🥳','🥸','😎','🤓','🧐'] },
              { cat: 'Gestures', emojis: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏'] },
              { cat: 'Hearts', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟'] },
              { cat: 'Objects', emojis: ['🔥','⭐','🌟','✨','💫','🎉','🎊','🎈','💯','💢','💥','💣','🕳️','💬','👁️‍🗨️','💀','👻','👽','🤖','💩','🎵','🎶','🔔','📢','💻','🖥️','📱','⌨️','🎮','🕹️'] },
              { cat: 'Reactions', emojis: ['👀','💪','🫡','🫠','😤','😡','🥺','😭','💅','✅','❌','⚠️','🚀','🏆','🎯','🤷','🤦','💭','🗿','☕'] },
            ].map((group) => (
              <div key={group.cat} className="emoji-category">
                <div className="emoji-category-label">{group.cat}</div>
                <div className="emoji-grid">
                  {group.emojis.map((em) => (
                    <button
                      key={em}
                      type="button"
                      className="emoji-item"
                      onClick={() => {
                        setInput((prev) => prev + em)
                        setShowEmojiPicker(false)
                        inputRef.current?.focus()
                      }}
                    >
                      {em}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {mentionUsers.length > 0 && (
          <div className="mention-dropdown">
            {mentionUsers.map((u, i) => (
              <div key={u.id} className={`mention-item${i === acIndex ? ' mention-item-active' : ''}`} onMouseDown={(e) => { e.preventDefault(); insertMention(u) }} onMouseEnter={() => setAcIndex(i)}>
                <span className="mention-item-name">{u.display_name}</span>
                <span className="mention-item-handle">@{u.username}</span>
              </div>
            ))}
          </div>
        )}
        {emoteResults.length > 0 && (
          <div className="mention-dropdown">
            {emoteResults.map(([name, emoji], i) => (
              <div key={name} className={`mention-item${i === acIndex ? ' mention-item-active' : ''}`} onMouseDown={(e) => { e.preventDefault(); insertEmote(emoji) }} onMouseEnter={() => setAcIndex(i)}>
                <span className="mention-item-name">{emoji}</span>
                <span className="mention-item-handle">:{name}:</span>
              </div>
            ))}
          </div>
        )}
        <form className="message-input" onSubmit={handleSend}>
          <input type="file" ref={fileInputRef} onChange={handleFileSelect} multiple style={{ display: 'none' }} />
          <button type="button" className="upload-btn" onClick={() => fileInputRef.current?.click()} title="Upload file">
            📎
          </button>
          <button type="button" className="emoji-btn" onClick={() => setShowEmojiPicker((p) => !p)} title="Emoji">
            😀
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => handleInput(e.target.value)}
            onPaste={handlePaste}
            placeholder={encrypted && !encryptionReady ? '🔓 New here — your first message will rotate the encryption key' : `Message ${channel.server_id ? '#' + channel.name : (dmPartnerName || channel.name || 'this channel')}`}
            autoFocus
            rows={1}
            className="message-textarea"
            onKeyDown={e => {
              // Autocomplete navigation (mentions & emotes)
              const acOpen = mentionUsers.length > 0 || emoteResults.length > 0
              const acLen = mentionUsers.length || emoteResults.length
              if (acOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setAcIndex((i) => (i + 1) % acLen)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setAcIndex((i) => (i - 1 + acLen) % acLen)
                  return
                }
                if (e.key === 'Tab' || e.key === 'Enter') {
                  e.preventDefault()
                  if (mentionUsers.length > 0) {
                    insertMention(mentionUsers[acIndex]!)
                  } else if (emoteResults.length > 0) {
                    insertEmote(emoteResults[acIndex]![1])
                  }
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setMentionUsers([])
                  setEmoteResults([])
                  return
                }
              }
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
                      if (a.filename.endsWith('.enc')) {
                        return <EncryptedAttachment key={a.id} attachmentId={a.id} channelId={channel.id} filename={a.filename} />
                      }
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
