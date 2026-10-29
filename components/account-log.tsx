'use client'

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatTicketWhen } from '@/lib/display'
import { OriginBadge, OriginFilter, originOf, stripOrigin } from '@/components/origin-badge'

type Row = {
  id: string
  action: string
  detail: string | null
  actor_name: string
  source?: string | null
  created_at: string
}

export function AccountLog({ supabase, userId }: { supabase: SupabaseClient; userId: string }) {
  const [rows, setRows] = useState<Row[]>([])
  const [filter, setFilter] = useState<'الكل' | 'يدوي' | 'سند'>('الكل')

  useEffect(() => {
    if (!userId) return
    let alive = true
    supabase.from('admin_audit').select('id, action, detail, actor_name, source, created_at').eq('target_id', userId).order('created_at', { ascending: false }).limit(20)
      .then(({ data, error }) => { if (alive && !error) setRows((data || []) as Row[]) })
    return () => { alive = false }
  }, [supabase, userId])

  const visible = rows.filter((row) => filter === 'الكل' || originOf(row.source, row.detail) === filter)

  return (
    <details className="account-log">
      <summary>سجل حسابي ({rows.length})</summary>
      <p>إنشاء الحساب وتعديله وتغيير كلمة المرور. يظهر إن كان يدوياً أو عن طريق سند.</p>
      <OriginFilter value={filter} onChange={setFilter} />
      {visible.length === 0 ? (
        <p className="account-log-empty">لا توجد عمليات على هذا الحساب.</p>
      ) : (
        <ul>
          {visible.map((row) => (
            <li key={row.id}>
              <b>{row.action}</b>
              <OriginBadge source={originOf(row.source, row.detail)} />
              <span>{stripOrigin(row.detail) || '—'}</span>
              <small>{row.actor_name} · {formatTicketWhen(row.created_at)}</small>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
