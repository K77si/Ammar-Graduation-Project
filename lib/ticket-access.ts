import { departmentLabel } from '@/lib/display'
import { getActor, serviceClient, type Actor } from '@/lib/server-auth'

const STAFF = new Set(['admin', 'technician', 'manager'])

export async function loadVisibleTicket(request: Request, ticketId: string) {
  const actor = await getActor(request)
  if (!actor || !ticketId) return { actor: actor as Actor | null, ticket: null }
  const admin = serviceClient()
  const { data: ticket } = await admin.from('tickets').select('id, user_id, department').eq('id', ticketId).maybeSingle()
  if (!ticket) return { actor, ticket: null }
  if (STAFF.has(actor.role) || ticket.user_id === actor.id) return { actor, ticket }
  if (actor.role === 'department_head') {
    const { data: me } = await admin.from('profiles').select('department').eq('id', actor.id).maybeSingle()
    const owner = ticket.user_id
      ? await admin.from('profiles').select('department').eq('id', ticket.user_id).maybeSingle()
      : { data: null }
    const mine = departmentLabel(me?.department)
    if (departmentLabel(ticket.department) === mine || departmentLabel(owner.data?.department) === mine) {
      return { actor, ticket }
    }
  }
  return { actor, ticket: null }
}
