import type { SupabaseClient } from '@supabase/supabase-js'

export interface ThreadMessage {
  sender: string
  text: string
  time: string
  created_at: string
}

export interface TicketMeta {
  problem: string
  assigneeId: string | null
  assigneeName: string
  messages: ThreadMessage[]
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('ar-SA-u-nu-latn', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function toMessage(row: { sender?: string; sender_name?: string; message?: string; text?: string; created_at?: string }): ThreadMessage {
  const created_at = row.created_at || new Date().toISOString()
  return {
    sender: row.sender || row.sender_name || 'مستخدم',
    text: row.message || row.text || '',
    created_at,
    time: formatTime(created_at),
  }
}

export function readTicketMeta(title: string | null | undefined): TicketMeta {
  const source = title || ''
  const index = source.indexOf('---THREAD---')
  if (index === -1) {
    return { problem: source, assigneeId: null, assigneeName: '', messages: [] }
  }

  const problem = source.slice(0, index).replace(/\s+$/, '')
  let payload: { assigneeId?: string | null; assigneeName?: string; messages?: unknown } = {}
  try {
    payload = JSON.parse(source.slice(index + '---THREAD---'.length).trim() || '{}')
  } catch {
    payload = {}
  }

  const rawMessages = Array.isArray(payload.messages) ? payload.messages : []
  return {
    problem,
    assigneeId: payload.assigneeId || null,
    assigneeName: payload.assigneeName || '',
    messages: rawMessages.map((row) => toMessage(row as { sender?: string; message?: string; text?: string; created_at?: string })),
  }
}

type DbClient = SupabaseClient

export async function loadTicketThread(supabase: DbClient, ticketId: string): Promise<{ messages: ThreadMessage[]; error: string | null }> {
  const replies = await supabase.from('ticket_replies').select('sender_name, message, created_at').eq('ticket_id', ticketId).order('created_at', { ascending: true })
  const ticket = await supabase.from('tickets').select('title').eq('id', ticketId).maybeSingle()
  const legacy = ticket.error ? [] : readTicketMeta(ticket.data?.title).messages
  if (!replies.error) {
    const messages = (replies.data || []).map((row: { sender_name?: string; message?: string; created_at?: string }) => toMessage(row))
    const combined = [...legacy]
    messages.forEach((message: ThreadMessage) => {
      if (!combined.some((item) => item.text === message.text && item.sender === message.sender)) combined.push(message)
    })
    return { messages: combined, error: null }
  }

  if (ticket.error) return { messages: [], error: replies.error.message as string }
  return { messages: legacy, error: null }
}

export async function sendTicketReply(supabase: DbClient, ticketId: string, sender: string, message: string): Promise<{ error: string | null }> {
  const inserted = await supabase.from('ticket_replies').insert({ ticket_id: ticketId, sender_name: sender, message })
  return { error: inserted.error ? (inserted.error.message as string) : null }
}

export function subscribeTicketChanges(supabase: SupabaseClient, onChange: () => void) {
  const channel = supabase.channel(`helpdesk-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ticket_replies' }, onChange)
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}
