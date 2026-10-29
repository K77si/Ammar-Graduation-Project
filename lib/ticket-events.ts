import type { SupabaseClient } from '@supabase/supabase-js'

export type TicketEvent = {
  id: string
  actor_name: string
  from_status: string | null
  to_status: string | null
  note?: string | null
  source?: string | null
  created_at: string
}

export async function loadTicketEvents(supabase: SupabaseClient, ticketId: string): Promise<TicketEvent[]> {
  const rich = await supabase.from('ticket_events').select('id, actor_name, from_status, to_status, note, source, created_at').eq('ticket_id', ticketId).order('created_at', { ascending: true })
  if (!rich.error) return (rich.data || []) as TicketEvent[]
  const plain = await supabase.from('ticket_events').select('id, actor_name, from_status, to_status, note, created_at').eq('ticket_id', ticketId).order('created_at', { ascending: true })
  return (plain.data || []) as TicketEvent[]
}
