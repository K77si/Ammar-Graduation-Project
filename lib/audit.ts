import { serviceClient } from '@/lib/server-auth'

export type AuditSource = 'يدوي' | 'سند'

export async function writeAudit(
  actorId: string,
  action: string,
  targetName: string,
  detail = '',
  meta?: { source?: AuditSource; targetId?: string | null }
) {
  const admin = serviceClient()
  const { data } = await admin.from('profiles').select('full_name').eq('id', actorId).maybeSingle()
  const source = meta?.source || 'يدوي'
  const marked = source === 'سند' && detail && !detail.startsWith('سند · ') ? `سند · ${detail}` : source === 'سند' && !detail ? 'سند' : detail
  const inserted = await admin.from('admin_audit').insert({
    actor_id: actorId,
    actor_name: data?.full_name || 'مدير',
    action,
    target_name: targetName,
    detail: marked,
    target_id: meta?.targetId || null,
    source
  })
  if (!inserted.error) return null
  const fallback = await admin.from('admin_audit').insert({
    actor_id: actorId,
    actor_name: data?.full_name || 'مدير',
    action,
    target_name: targetName,
    detail: marked
  })
  if (fallback.error) return 'تم تنفيذ الإجراء، وتعذر تسجيله في سجل العمليات.'
  return null
}
