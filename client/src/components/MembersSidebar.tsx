import { useEffect, useState } from 'react'
import type { ServerMember, User, WSMessage as WSMsg } from '../types'
import * as api from '../services/api'
import { subscribe } from '../services/ws'
import UserPopover from './UserPopover'

interface MembersSidebarProps {
  serverId: string
  onMessage?: (userId: string) => void
  isAdmin?: boolean
}

interface MemberInfo {
  member: ServerMember
  user: User
}

export default function MembersSidebar({ serverId, onMessage, isAdmin }: MembersSidebarProps) {
  const [members, setMembers] = useState<MemberInfo[]>([])
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set())
  const [popover, setPopover] = useState<{ userId: string; rect: DOMRect } | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [serverMembers, onlineIds] = await Promise.all([
          api.getMembers(serverId),
          api.getOnlineUsers(serverId),
        ])
        const infos: MemberInfo[] = []
        for (const m of serverMembers) {
          try {
            const u = await api.getUser(m.user_id)
            infos.push({ member: m, user: u })
          } catch { /* skip failed user fetch */ }
        }
        if (!cancelled) {
          setMembers(infos)
          setOnlineUserIds(new Set(onlineIds || []))
        }
      } catch { /* ignore */ }
    }
    load()
    return () => { cancelled = true }
  }, [serverId])

  // Listen for presence changes
  useEffect(() => {
    const unsub = subscribe((msg: WSMsg) => {
      if (msg.type === 'presence') {
        const payload = msg.payload as { user_id: string; status: string }
        setOnlineUserIds((prev) => {
          const next = new Set(prev)
          if (payload.status === 'online') {
            next.add(payload.user_id)
          } else {
            next.delete(payload.user_id)
          }
          return next
        })
      }
    })
    return unsub
  }, [])

  const handleMemberClick = (userId: string, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPopover({ userId, rect })
  }

  const handleToggleAdmin = async (userId: string, currentRole: string) => {
    const newRole = currentRole === 'admin' ? 'member' : 'admin'
    try {
      await api.updateMemberRole(serverId, userId, newRole)
      setMembers((prev) => prev.map((m) =>
        m.user.id === userId ? { ...m, member: { ...m.member, role: newRole } } : m
      ))
    } catch { /* ignore */ }
  }

  // Sort: online first, then alphabetical
  const sortedMembers = [...members].sort((a, b) => {
    const aOnline = onlineUserIds.has(a.user.id) ? 0 : 1
    const bOnline = onlineUserIds.has(b.user.id) ? 0 : 1
    if (aOnline !== bOnline) return aOnline - bOnline
    return a.user.display_name.localeCompare(b.user.display_name)
  })

  const admins = sortedMembers.filter((m) => m.member.role === 'admin')
  const regular = sortedMembers.filter((m) => m.member.role !== 'admin')

  const renderMember = (m: MemberInfo) => {
    const isOnline = onlineUserIds.has(m.user.id)
    return (
      <div
        key={m.user.id}
        className={`member-item ${isOnline ? '' : 'offline'}`}
        onClick={(e) => handleMemberClick(m.user.id, e)}
      >
        <span className={`member-status-dot ${isOnline ? 'online' : 'offline'}`} />
        <span
          className="member-name"
          style={m.user.name_color ? { color: m.user.name_color } : undefined}
        >
          {m.user.display_name}
        </span>
        {isAdmin && (
          <button
            className={`member-role-btn ${m.member.role === 'admin' ? 'is-admin' : ''}`}
            title={m.member.role === 'admin' ? 'Remove admin' : 'Make admin'}
            onClick={(e) => { e.stopPropagation(); handleToggleAdmin(m.user.id, m.member.role) }}
          >
            {m.member.role === 'admin' ? '★' : '☆'}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="members-sidebar">
      <div className="members-sidebar-header">Members — {members.length}</div>
      {admins.length > 0 && (
        <>
          <div className="members-role-header">Admin — {admins.length}</div>
          {admins.map(renderMember)}
        </>
      )}
      {regular.length > 0 && (
        <>
          <div className="members-role-header">Members — {regular.length}</div>
          {regular.map(renderMember)}
        </>
      )}
      {popover && (
        <UserPopover
          userId={popover.userId}
          anchorRect={popover.rect}
          onClose={() => setPopover(null)}
          onMessage={onMessage}
        />
      )}
    </div>
  )
}
