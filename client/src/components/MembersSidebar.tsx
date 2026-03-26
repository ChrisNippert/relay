import { useEffect, useState } from 'react'
import type { ServerMember, User } from '../types'
import * as api from '../services/api'

interface MembersSidebarProps {
  serverId: string
}

interface MemberInfo {
  member: ServerMember
  user: User
}

export default function MembersSidebar({ serverId }: MembersSidebarProps) {
  const [members, setMembers] = useState<MemberInfo[]>([])

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

  const admins = members.filter((m) => m.member.role === 'admin')
  const regular = members.filter((m) => m.member.role !== 'admin')

  return (
    <div className="members-sidebar">
      <div className="members-sidebar-header">Members — {members.length}</div>
      {admins.length > 0 && (
        <>
          <div className="members-role-header">Admin — {admins.length}</div>
          {admins.map((m) => (
            <div key={m.user.id} className="member-item">
              <span className="member-avatar">
                {m.user.avatar_url ? (
                  <img src={m.user.avatar_url} alt="" className="member-avatar-img" />
                ) : (
                  <span className="member-avatar-fallback">{m.user.display_name[0]?.toUpperCase()}</span>
                )}
              </span>
              <span className="member-name">{m.user.display_name}</span>
            </div>
          ))}
        </>
      )}
      {regular.length > 0 && (
        <>
          <div className="members-role-header">Members — {regular.length}</div>
          {regular.map((m) => (
            <div key={m.user.id} className="member-item">
              <span className="member-avatar">
                {m.user.avatar_url ? (
                  <img src={m.user.avatar_url} alt="" className="member-avatar-img" />
                ) : (
                  <span className="member-avatar-fallback">{m.user.display_name[0]?.toUpperCase()}</span>
                )}
              </span>
              <span className="member-name">{m.user.display_name}</span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
