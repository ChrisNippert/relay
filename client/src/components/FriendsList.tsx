import { useEffect, useRef, useState } from 'react'
import type { Channel, Friendship, User, WSMessage } from '../types'
import * as api from '../services/api'
import { useAuth } from '../context/AuthContext'
import { subscribe } from '../services/ws'

interface Props {
  dmChannels: Channel[]
  onSelectChannel: (channel: Channel) => void
  onStartCall?: (userId: string, video: boolean) => void
  onUnfriend?: (userId: string) => void
  onArchiveDM?: (channelId: string) => void
}

const ARCHIVED_DMS_KEY = 'relay_archived_dms'
function getArchivedDMs(): Set<string> {
  try {
    const raw = localStorage.getItem(ARCHIVED_DMS_KEY)
    if (raw) return new Set(JSON.parse(raw))
  } catch { /* ignore */ }
  return new Set()
}
function saveArchivedDMs(ids: Set<string>) {
  localStorage.setItem(ARCHIVED_DMS_KEY, JSON.stringify([...ids]))
}

export default function FriendsList({ dmChannels, onSelectChannel, onStartCall, onUnfriend, onArchiveDM }: Props) {
  const { user } = useAuth()
  const [friends, setFriends] = useState<Friendship[]>([])
  const [friendUsers, setFriendUsers] = useState<Map<string, User>>(new Map())
  const [dmByUser, setDmByUser] = useState<Map<string, Channel>>(new Map())
  const [dmUserNames, setDmUserNames] = useState<Map<string, string>>(new Map())
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [confirmUnfriend, setConfirmUnfriend] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<User[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set())
  const [archivedDMs, setArchivedDMs] = useState<Set<string>>(() => getArchivedDMs())
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; friendshipId: string; userId: string; displayName: string } | null>(null)

  const dmByUserRef = useRef(dmByUser)
  dmByUserRef.current = dmByUser
  const archivedDMsRef = useRef(archivedDMs)
  archivedDMsRef.current = archivedDMs
  const userRef = useRef(user)
  userRef.current = user
  const onArchiveDMRef = useRef(onArchiveDM)
  onArchiveDMRef.current = onArchiveDM

  const loadFriends = () => {
    api.getFriends().then(async (fs) => {
      setFriends(fs)
      const users = new Map<string, User>()
      for (const f of fs) {
        const otherId = f.user_id === user?.id ? f.friend_id : f.user_id
        try {
          const u = await api.getUser(otherId)
          users.set(otherId, u)
        } catch { /* ignore */ }
      }
      setFriendUsers(users)
    }).catch(console.error)
  }

  useEffect(() => {
    const resolveDMs = async () => {
      const map = new Map<string, Channel>()
      const names = new Map<string, string>()
      for (const ch of dmChannels) {
        try {
          const parts = await api.getDMParticipants(ch.id)
          const otherId = parts.find((id: string) => id !== user?.id)
          if (otherId) {
            map.set(otherId, ch)
            try {
              const u = await api.getUser(otherId)
              names.set(otherId, u.display_name)
            } catch { /* skip */ }
          }
        } catch {
          // Fallback: if no endpoint, skip
        }
      }
      setDmByUser(map)
      setDmUserNames(names)
    }
    resolveDMs()
  }, [dmChannels, user?.id])

  useEffect(() => {
    loadFriends()
  }, [user?.id])

  // Auto-unarchive DMs for accepted friends (handles both local accept + WS-driven reloads)
  useEffect(() => {
    const acceptedIds = new Set<string>()
    for (const f of friends) {
      if (f.status === 'accepted') {
        const otherId = f.user_id === user?.id ? f.friend_id : f.user_id
        acceptedIds.add(otherId)
      }
    }
    const cur = archivedDMsRef.current
    let changed = false
    const next = new Set(cur)
    for (const [uid, ch] of dmByUser) {
      if (acceptedIds.has(uid) && next.has(ch.id)) {
        next.delete(ch.id)
        changed = true
      }
    }
    if (changed) {
      saveArchivedDMs(next)
      setArchivedDMs(next)
    }
  }, [friends, dmByUser, user?.id])

  // Track online status from user data and WS presence
  useEffect(() => {
    // Initialize from fetched user data
    const initial = new Set<string>()
    for (const [id, u] of friendUsers.entries()) {
      if (u.status === 'online') initial.add(id)
    }
    setOnlineUsers(initial)
  }, [friendUsers])

  useEffect(() => {
    const unsub = subscribe((msg: WSMessage) => {
      if (msg.type === 'presence') {
        const p = msg.payload as { user_id: string; status: string }
        setOnlineUsers((prev) => {
          const next = new Set(prev)
          if (p.status === 'online') next.add(p.user_id)
          else next.delete(p.user_id)
          return next
        })
      } else if (msg.type === 'friend_request' || msg.type === 'friend_accepted') {
        loadFriends()
      } else if (msg.type === 'friend_removed') {
        const p = msg.payload as { friendship_id: string; user_id: string }
        setFriends((prev) => prev.filter((f) => f.id !== p.friendship_id))
        // Archive the DM with the user who removed us
        if (p.user_id) {
          const dmCh = dmByUserRef.current.get(p.user_id)
          if (dmCh) {
            setArchivedDMs((prev) => {
              const next = new Set(prev)
              next.add(dmCh.id)
              saveArchivedDMs(next)
              return next
            })
            onArchiveDMRef.current?.(dmCh.id)
          }
        }
      }
    })
    return unsub
  }, [])

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setSearching(true)
    setSearchError('')
    try {
      const results = await api.searchUsers(searchQuery.trim())
      setSearchResults(results.filter((u) => u.id !== user?.id))
      if (results.filter((u) => u.id !== user?.id).length === 0) {
        setSearchError('No users found')
      }
    } catch {
      setSearchError('Search failed')
    } finally {
      setSearching(false)
    }
  }

  const handleSendRequest = async (targetUser: User) => {
    try {
      await api.sendFriendRequest(targetUser.id)
      setSearchResults((prev) => prev.filter((u) => u.id !== targetUser.id))
      setSearchError(`Request sent to ${targetUser.display_name}`)
      loadFriends()
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Failed to send request')
    }
  }

  const handleOpenDM = async (friendUserId: string) => {
    try {
      const channel = await api.createDM(friendUserId)
      onSelectChannel(channel)
    } catch (err) {
      console.error(err)
    }
  }

  const handleUnfriend = async (friendshipId: string, friendUserId: string) => {
    try {
      await api.removeFriend(friendshipId)
      setFriends((prev) => prev.filter((f) => f.id !== friendshipId))
      // Archive the DM channel when unfriending
      const dmCh = dmByUser.get(friendUserId)
      if (dmCh) {
        setArchivedDMs((prev) => {
          const next = new Set(prev)
          next.add(dmCh.id)
          saveArchivedDMs(next)
          return next
        })
        onArchiveDM?.(dmCh.id)
      }
      onUnfriend?.(friendUserId)
    } catch (err) {
      console.error('Failed to remove friend:', err)
    }
  }

  const handleArchiveDM = (userId: string) => {
    const dmCh = dmByUser.get(userId)
    if (dmCh) {
      setArchivedDMs((prev) => {
        const next = new Set(prev)
        next.add(dmCh.id)
        saveArchivedDMs(next)
        return next
      })
      onArchiveDM?.(dmCh.id)
    }
  }

  const [showArchived, setShowArchived] = useState(false)

  // Deduplicate friends by the other user's ID, only show if user data is loaded
  const seen = new Set<string>()
  const accepted = friends.filter((f) => {
    if (f.status !== 'accepted') return false
    const otherId = f.user_id === user?.id ? f.friend_id : f.user_id
    if (seen.has(otherId)) return false
    if (!friendUsers.has(otherId)) return false
    seen.add(otherId)
    return true
  })
  const pending = friends.filter((f) => f.status === 'pending')

  // Split accepted into active and archived
  const activeFriends = accepted.filter((f) => {
    const otherId = f.user_id === user?.id ? f.friend_id : f.user_id
    const dmCh = dmByUser.get(otherId)
    return !dmCh || !archivedDMs.has(dmCh.id)
  })

  // Archived DMs: any DM channel in archivedDMs set, regardless of friend status
  const archivedDMList: { channelId: string; userId: string; displayName: string }[] = []
  for (const [uid, ch] of dmByUser) {
    if (archivedDMs.has(ch.id)) {
      archivedDMList.push({
        channelId: ch.id,
        userId: uid,
        displayName: friendUsers.get(uid)?.display_name ?? dmUserNames.get(uid) ?? uid,
      })
    }
  }

  return (
    <div className="friends-list">
      <button className="add-friend-btn" onClick={() => setShowSearch(!showSearch)}>
        {showSearch ? '- Cancel' : '+ Add Friend'}
      </button>

      {showSearch && (
        <div className="friend-search">
          <form onSubmit={(e) => { e.preventDefault(); handleSearch() }} className="friend-search-form">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by username..."
              autoFocus
            />
            <button type="submit" disabled={searching}>
              {searching ? '...' : 'Go'}
            </button>
          </form>
          {searchError && <p className="friend-search-msg">{searchError}</p>}
          {searchResults.map((u) => (
            <div key={u.id} className="friend-search-result">
              <span>{u.display_name} <small>@{u.username}</small></span>
              <button className="accept-btn" onClick={() => handleSendRequest(u)}>
                Add
              </button>
            </div>
          ))}
        </div>
      )}

      {activeFriends.length > 0 && (
        <>
          <h3 className="channel-category">Friends</h3>
          {activeFriends.map((f) => {
            const otherId = f.user_id === user?.id ? f.friend_id : f.user_id
            const u = friendUsers.get(otherId)
            const hasDM = dmByUser.has(otherId)
            return (
              <div key={f.id} className="friend-item" onContextMenu={(e) => {
                e.preventDefault()
                setCtxMenu({ x: e.clientX, y: e.clientY, friendshipId: f.id, userId: otherId, displayName: u?.display_name ?? otherId })
              }}>
                <button
                  className={`channel-item ${hasDM ? 'has-dm' : ''}`}
                  onClick={() => handleOpenDM(otherId)}
                >
                  <span className={`friend-status ${onlineUsers.has(otherId) ? 'online' : 'offline'}`}>●</span>
                  {u?.display_name ?? otherId}
                </button>
                <div className="friend-actions">
                  {onStartCall && (
                    <>
                      <button
                        className="friend-action-btn"
                        onClick={() => onStartCall(otherId, false)}
                        title="Voice Call"
                      >
                        📞
                      </button>
                      <button
                        className="friend-action-btn"
                        onClick={() => onStartCall(otherId, true)}
                        title="Video Call"
                      >
                        📹
                      </button>
                    </>
                  )}
                  {confirmUnfriend === f.id ? (
                    <>
                      <span className="unfriend-confirm-label">Remove?</span>
                      <button
                        className="friend-action-btn unfriend-confirm-yes"
                        onClick={() => { handleUnfriend(f.id, otherId); setConfirmUnfriend(null) }}
                        title="Confirm unfriend"
                      >
                        ✓
                      </button>
                      <button
                        className="friend-action-btn unfriend-confirm-no"
                        onClick={() => setConfirmUnfriend(null)}
                        title="Cancel"
                      >
                        ✕
                      </button>
                    </>
                  ) : (
                    <button
                      className="friend-action-btn unfriend"
                      onClick={() => setConfirmUnfriend(f.id)}
                      title="Unfriend"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </>
      )}

      {pending.length > 0 && (
        <>
          <h3 className="channel-category">Pending</h3>
          {pending.map((f) => {
            const otherId = f.user_id === user?.id ? f.friend_id : f.user_id
            const u = friendUsers.get(otherId)
            const isIncoming = f.friend_id === user?.id
            return (
              <div key={f.id} className="channel-item pending">
                <span>{u?.display_name ?? otherId}</span>
                {isIncoming ? (
                  <button
                    className="accept-btn"
                    onClick={async () => {
                      await api.acceptFriendRequest(f.id)
                      setFriends((prev) =>
                        prev.map((fr) => fr.id === f.id ? { ...fr, status: 'accepted' } : fr)
                      )
                    }}
                  >
                    Accept
                  </button>
                ) : (
                  <span className="pending-label">Sent</span>
                )}
              </div>
            )
          })}
        </>
      )}

      {archivedDMList.length > 0 && (
        <>
          <h3 className="channel-category archived-header" onClick={() => setShowArchived(!showArchived)} style={{ cursor: 'pointer', userSelect: 'none' }}>
            {showArchived ? '▾' : '▸'} Archived ({archivedDMList.length})
          </h3>
          {showArchived && archivedDMList.map((item) => (
            <div key={item.channelId} className="friend-item archived">
              <button
                className="channel-item has-dm"
                onClick={() => handleOpenDM(item.userId)}
              >
                <span className={`friend-status ${onlineUsers.has(item.userId) ? 'online' : 'offline'}`}>●</span>
                {item.displayName}
              </button>
            </div>
          ))}
        </>
      )}

      {/* Right-click context menu */}
      {ctxMenu && (
        <div className="voice-context-menu-overlay" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }}>
          <div className="voice-context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()}>
            <div className="voice-context-menu-header">{ctxMenu.displayName}</div>
            <button className="voice-context-menu-item" onClick={() => { handleOpenDM(ctxMenu.userId); setCtxMenu(null) }}>
              💬 Message
            </button>
            {onStartCall && (
              <>
                <button className="voice-context-menu-item" onClick={() => { onStartCall(ctxMenu.userId, false); setCtxMenu(null) }}>
                  📞 Voice Call
                </button>
                <button className="voice-context-menu-item" onClick={() => { onStartCall(ctxMenu.userId, true); setCtxMenu(null) }}>
                  📹 Video Call
                </button>
              </>
            )}
            {dmByUser.has(ctxMenu.userId) && (
              <button className="voice-context-menu-item" onClick={() => { handleArchiveDM(ctxMenu.userId); setCtxMenu(null) }}>
                📦 Archive Chat
              </button>
            )}
            <button className="voice-context-menu-item kick" onClick={() => {
              if (confirm(`Remove ${ctxMenu.displayName} as a friend?`)) {
                handleUnfriend(ctxMenu.friendshipId, ctxMenu.userId)
              }
              setCtxMenu(null)
            }}>
              ✕ Unfriend
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
