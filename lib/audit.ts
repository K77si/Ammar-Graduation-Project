import { serviceClient } from '@/lib/server-auth'

export async function writeAudit(actorId: string, action: string, targetName: string, detail = '') {
  const admin = serviceClient()
  const { data } = await admin.from('profiles').select('full_name').eq('id', actorId).maybeSingle()
  const inserted = await admin.from('admin_audit').insert({
    actor_id: actorId,
    actor_name: data?.full_name || 'مدير',
    action,
    target_name: targetName,
    detail
  })
  if (inserted.error) return 'تم تنفيذ الإجراء، وتعذر تسجيله في سجل العمليات.'
  return null
}
