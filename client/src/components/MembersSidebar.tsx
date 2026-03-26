import { useEffect, useState } from 'react'
import type { ServerMember, User } from '../types'
import * as api from '../services/api'
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
  const [popover, setPopover] = useState<{ userId: string; rect: DOMRect } | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const serverMembers = await api.getMembers(serverId)
        const infos: MemberInfo[] = []
        for (const m of serverMembers) {
          try {
            const u = await api.getUser(m.user_id)
            infos.push({ member: m, user: u })
          } catch { /* skip failed user fetch */ }
        }
        if (!cancelled) setMembers(infos)
      } catch { /* ignore */ }
    }
    load()
    return () => { cancelled = true }
  }, [serverId])

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

  const admins = members.filter((m) => m.member.role === 'admin')
  const regular = members.filter((m) => m.member.role !== 'admin')

  const renderMember = (m: MemberInfo) => (
    <div key={m.user.id} className="member-item" onClick={(e) => handleMemberClick(m.user.id, e)}>
      <span className="member-name">{m.user.display_name}</span>
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
