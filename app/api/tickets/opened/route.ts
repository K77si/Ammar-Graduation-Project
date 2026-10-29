import { getActor } from '@/lib/server-auth'
import { markTicketOpenedBySanad } from '@/lib/sanad-log'

export async function POST(request: Request) {
  const actor = await getActor(request)
  if (!actor) return Response.json({ error: 'يلزم تسجيل الدخول.' }, { status: 401 })
  const body = await request.json().catch(() => null) as { ticketId?: string } | null
  const ticketId = body?.ticketId || ''
  if (!ticketId) return Response.json({ error: 'البلاغ غير محدد.' }, { status: 400 })
  await markTicketOpenedBySanad(ticketId, actor.id)
  return Response.json({ ok: true })
}
