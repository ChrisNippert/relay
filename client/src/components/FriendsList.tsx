import { useEffect, useState } from 'react'
import type { Channel, Friendship, User } from '../types'
import * as api from '../services/api'
import { useAuth } from '../context/AuthContext'

interface Props {
  dmChannels: Channel[]
  onSelectChannel: (channel: Channel) => void
  onStartCall?: (userId: string, video: boolean) => void
}

export default function FriendsList({ dmChannels, onSelectChannel, onStartCall }: Props) {
  const { user } = useAuth()
  const [friends, setFriends] = useState<Friendship[]>([])
  const [friendUsers, setFriendUsers] = useState<Map<string, User>>(new Map())
  const [dmByUser, setDmByUser] = useState<Map<string, Channel>>(new Map())
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<User[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')

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

  // Resolve DM channels to their other participant
  useEffect(() => {
    const resolveDMs = async () => {
      const map = new Map<string, Channel>()
      for (const ch of dmChannels) {
        try {
          // DM participants: get the channel's participants to find the other user
          // We use the channel ID to look up who's in it via the dm_participants
          // The name field on the channel is empty, so we need to map channel→user
          const parts = await api.getDMParticipants(ch.id)
          const otherId = parts.find((id: string) => id !== user?.id)
          if (otherId) {
            map.set(otherId, ch)
          }
        } catch {
          // Fallback: if no endpoint, skip
        }
      }
      setDmByUser(map)
    }
    resolveDMs()
  }, [dmChannels, user?.id])

  useEffect(() => {
    loadFriends()
  }, [user?.id])

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

  const handleUnfriend = async (friendshipId: string) => {
    try {
      await api.removeFriend(friendshipId)
      setFriends((prev) => prev.filter((f) => f.id !== friendshipId))
    } catch (err) {
      console.error('Failed to remove friend:', err)
    }
  }

  // Deduplicate friends by the other user's ID
  const seen = new Set<string>()
  const accepted = friends.filter((f) => {
    if (f.status !== 'accepted') return false
    const otherId = f.user_id === user?.id ? f.friend_id : f.user_id
    if (seen.has(otherId)) return false
    seen.add(otherId)
    return true
  })
  const pending = friends.filter((f) => f.status === 'pending')

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

      {accepted.length > 0 && (
        <>
          <h3 className="channel-category">Friends</h3>
          {accepted.map((f) => {
            const otherId = f.user_id === user?.id ? f.friend_id : f.user_id
            const u = friendUsers.get(otherId)
            const hasDM = dmByUser.has(otherId)
            return (
              <div key={f.id} className="friend-item">
                <button
                  className={`channel-item ${hasDM ? 'has-dm' : ''}`}
                  onClick={() => handleOpenDM(otherId)}
                >
                  <span className="friend-status">●</span>
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
                  <button
                    className="friend-action-btn unfriend"
                    onClick={() => handleUnfriend(f.id)}
                    title="Unfriend"
                  >
                    ✕
                  </button>
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
                {isIncoming && (
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
                )}
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
