import { useEffect, useRef, useState } from 'react'
import type { User, Friendship } from '../types'
import * as api from '../services/api'
import { useAuth } from '../context/AuthContext'

interface Props {
  userId: string
  anchorRect: DOMRect
  onClose: () => void
  onMessage?: (userId: string) => void
}

export default function UserPopover({ userId, anchorRect, onClose, onMessage }: Props) {
  const { user: me } = useAuth()
  const [userInfo, setUserInfo] = useState<User | null>(null)
  const [friendship, setFriendship] = useState<Friendship | null>(null)
  const [loading, setLoading] = useState(true)
  const popoverRef = useRef<HTMLDivElement>(null)

  const isSelf = userId === me?.id

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [u, friends] = await Promise.all([
          api.getUser(userId),
          api.getFriends(),
        ])
        if (cancelled) return
        setUserInfo(u)
        const f = friends.find(
          (f) => (f.user_id === userId || f.friend_id === userId)
        )
        setFriendship(f ?? null)
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [userId])

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Position the popover
  const style: React.CSSProperties = {}
  const popW = 280
  const popH = 200
  // Prefer right side of anchor, fall back to left
  if (anchorRect.right + popW + 8 < window.innerWidth) {
    style.left = anchorRect.right + 8
  } else {
    style.left = Math.max(8, anchorRect.left - popW - 8)
  }
  // Vertically center on anchor, clamped
  style.top = Math.max(8, Math.min(anchorRect.top - popH / 4, window.innerHeight - popH - 8))

  const handleAddFriend = async () => {
    try {
      const f = await api.sendFriendRequest(userId)
      setFriendship(f)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      alert('Failed: ' + msg)
    }
  }

  const handleAcceptFriend = async () => {
    if (!friendship) return
    try {
      await api.acceptFriendRequest(friendship.id)
      setFriendship({ ...friendship, status: 'accepted' })
    } catch { /* ignore */ }
  }

  const handleMessage = async () => {
    if (onMessage) {
      onMessage(userId)
      onClose()
    }
  }

  let friendStatus: 'none' | 'pending-sent' | 'pending-received' | 'accepted' = 'none'
  if (friendship) {
    if (friendship.status === 'accepted') {
      friendStatus = 'accepted'
    } else if (friendship.user_id === me?.id) {
      friendStatus = 'pending-sent'
    } else {
      friendStatus = 'pending-received'
    }
  }

  return (
    <div className="user-popover" ref={popoverRef} style={style}>
      {loading ? (
        <div className="user-popover-loading">Loading...</div>
      ) : userInfo ? (
        <>
          <div className="user-popover-header">
            <span className="user-popover-avatar">
              {userInfo.avatar_url ? (
                <img src={userInfo.avatar_url} alt="" className="user-popover-avatar-img" />
              ) : (
                <span className="user-popover-avatar-fallback">{userInfo.display_name[0]?.toUpperCase()}</span>
              )}
            </span>
            <div className="user-popover-names">
              <span className="user-popover-display">{userInfo.display_name}</span>
              <span className="user-popover-username">@{userInfo.username}</span>
            </div>
          </div>
          <div className="user-popover-meta">
            Joined {new Date(userInfo.created_at).toLocaleDateString()}
          </div>
          {!isSelf && (
            <div className="user-popover-actions">
              <button className="user-popover-btn message" onClick={handleMessage}>
                💬 Message
              </button>
              {friendStatus === 'none' && (
                <button className="user-popover-btn add" onClick={handleAddFriend}>
                  ➕ Add Friend
                </button>
              )}
              {friendStatus === 'pending-sent' && (
                <button className="user-popover-btn pending" disabled>
                  ⏳ Request Sent
                </button>
              )}
              {friendStatus === 'pending-received' && (
                <button className="user-popover-btn accept" onClick={handleAcceptFriend}>
                  ✅ Accept Request
                </button>
              )}
              {friendStatus === 'accepted' && (
                <button className="user-popover-btn friends" disabled>
                  ✓ Friends
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="user-popover-loading">User not found</div>
      )}
    </div>
  )
}
