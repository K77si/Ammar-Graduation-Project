import { serviceClient } from '@/lib/server-auth'

async function insertEvent(row: Record<string, string | null>) {
  const db = serviceClient()
  const withSource = await db.from('ticket_events').insert({ ...row, source: 'سند' })
  if (!withSource.error) return
  await db.from('ticket_events').insert(row)
}

export async function tagRecentTicketEvents(ticketId: string) {
  const db = serviceClient()
  const since = new Date(Date.now() - 8000).toISOString()
  const { data } = await db.from('ticket_events').select('id, note').eq('ticket_id', ticketId).gte('created_at', since)
  for (const row of data || []) {
    const note = String(row.note || '')
    if (note.startsWith('سند · ')) continue
    const next = note ? `سند · ${note}` : 'سند · إجراء'
    const stamped = await db.from('ticket_events').update({ note: next, source: 'سند' }).eq('id', row.id)
    if (stamped.error) await db.from('ticket_events').update({ note: next }).eq('id', row.id)
  }
}

export async function logSanadQuestion(input: {
  ticketId: string
  actorName: string
  status?: string | null
  question: string
}) {
  const body = input.question.replace(/\s+/g, ' ').trim().slice(0, 180)
  if (body.length < 5) return
  await insertEvent({
    ticket_id: input.ticketId,
    actor_name: input.actorName,
    from_status: input.status || null,
    to_status: input.status || null,
    note: `سند · سؤال: ${body}`
  })
}

export async function markTicketOpenedBySanad(ticketId: string, actorId: string) {
  const db = serviceClient()
  const { data: ticket } = await db.from('tickets').select('id, user_id, created_at').eq('id', ticketId).maybeSingle()
  if (!ticket || ticket.user_id !== actorId) return
  const age = Date.now() - new Date(String(ticket.created_at || '')).getTime()
  if (!Number.isFinite(age) || age > 2 * 60 * 1000) return
  const { data: actor } = await db.from('profiles').select('full_name').eq('id', actorId).maybeSingle()
  const { data: rows } = await db.from('ticket_events').select('id, note').eq('ticket_id', ticketId).order('created_at', { ascending: false }).limit(8)
  const opened = (rows || []).find((row) => row.note === 'فتح البلاغ' || row.note === 'سند · فتح البلاغ')
  if (opened?.note === 'فتح البلاغ') {
    const stamped = await db.from('ticket_events').update({ note: 'سند · فتح البلاغ', source: 'سند' }).eq('id', opened.id)
    if (stamped.error) await db.from('ticket_events').update({ note: 'سند · فتح البلاغ' }).eq('id', opened.id)
    return
  }
  if (opened) return
  await insertEvent({
    ticket_id: ticketId,
    actor_name: actor?.full_name || 'مستخدم',
    from_status: 'مفتوحة',
    to_status: 'مفتوحة',
    note: 'سند · فتح البلاغ'
  })
}
