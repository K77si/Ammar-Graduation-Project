import type { SupabaseClient } from '@supabase/supabase-js'

export const FAULT_TYPES = ['طابعة', 'شبكة', 'حساب', 'جهاز', 'برامج', 'أخرى'] as const
export const PRIORITIES = ['عادي', 'عاجل'] as const
export const WORK_STATUSES = ['مفتوحة', 'قيد المعالجة', 'بانتظار الموظف', 'منجزة', 'مغلقة'] as const
export const AVAILABILITY = ['متاح', 'مشغول', 'خارج الدوام'] as const
export const ACTIVE_STATUSES = ['مفتوحة', 'قيد المعالجة', 'بانتظار الموظف'] as const

export type WorkflowTicket = {
  id: string
  title?: string
  department?: string | null
  status: string
  created_at: string
  user_id?: string | null
  priority?: string | null
  priority_reason?: string | null
  site_place?: string | null
  device_number?: string | null
  fault_type?: string | null
  resolution?: string | null
  rating_reason?: string | null
  is_private?: boolean | null
  is_outage?: boolean | null
  affected_department?: string | null
  cancel_reason?: string | null
  resolved_at?: string | null
  closed_at?: string | null
  assigned_to?: string | null
}

export function isActive(status?: string | null) {
  return (ACTIVE_STATUSES as readonly string[]).includes(status || '')
}

export function isDelayed(ticket: { status?: string | null; created_at?: string | null; assigned_to?: string | null }) {
  if (ticket.status !== 'مفتوحة' || ticket.assigned_to) return false
  const opened = new Date(ticket.created_at || '').getTime()
  if (Number.isNaN(opened)) return false
  return Date.now() - opened > 24 * 60 * 60 * 1000
}

export function withinDays(value: string | null | undefined, days: number) {
  const time = new Date(value || '').getTime()
  if (Number.isNaN(time)) return false
  return Date.now() - time <= days * 24 * 60 * 60 * 1000
}

export function canReopen(ticket: WorkflowTicket) {
  if (ticket.status !== 'منجزة' && ticket.status !== 'مغلقة') return false
  return withinDays(ticket.resolved_at || ticket.closed_at || ticket.created_at, 7)
}

export function suggestFault(text: string): (typeof FAULT_TYPES)[number] | '' {
  if (/طابع|طبع|حبر|ورق/.test(text)) return 'طابعة'
  if (/شبك|نت|انترنت|إنترنت|واي|wifi|اتصال/i.test(text)) return 'شبكة'
  if (/دخول|كلمة|مرور|باسورد|حساب|قفل|مقفل|ايميل|بريد/.test(text)) return 'حساب'
  if (/جهاز|شاشة|لابتوب|حاسوب|كمبيوتر|ماوس|كيبورد|يشتغل|يطفي/.test(text)) return 'جهاز'
  if (/برنامج|نظام|اكسل|إكسل|وورد|ويندوز|تحديث|تطبيق/.test(text)) return 'برامج'
  return ''
}

export function asFault(value?: string | null): (typeof FAULT_TYPES)[number] {
  return (FAULT_TYPES as readonly string[]).includes(value || '') ? value as (typeof FAULT_TYPES)[number] : 'أخرى'
}

export function sortTickets<T extends { priority?: string | null; created_at?: string | null; is_outage?: boolean | null; status?: string | null }>(rows: T[]) {
  return [...rows].sort((a, b) => {
    const active = Number(isActive(b.status)) - Number(isActive(a.status))
    if (active) return active
    const outage = Number(Boolean(b.is_outage)) - Number(Boolean(a.is_outage))
    if (outage) return outage
    const urgent = Number(b.priority === 'عاجل') - Number(a.priority === 'عاجل')
    if (urgent) return urgent
    const age = +new Date(a.created_at || 0) - +new Date(b.created_at || 0)
    return isActive(a.status) ? age : -age
  })
}

export async function ticketAction(
  supabase: SupabaseClient,
  ticket: string,
  action: string,
  payload: Record<string, string> = {}
) {
  const { data, error } = await supabase.rpc('ticket_action', { ticket, action, payload })
  return { data, error: error?.message || '' }
}

export async function closeStale(supabase: SupabaseClient) {
  await supabase.rpc('close_stale_tickets')
}

export function monthKey(value?: string | null) {
  const date = new Date(value || '')
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export type CsvTicket = {
  ticket_number?: number | null
  title?: string
  status?: string
  priority?: string | null
  fault_type?: string | null
  affected_department?: string | null
  is_outage?: boolean | null
  requester?: string
  requesterNumber?: string
  technician?: string
  resolution?: string | null
  rating?: number | null
  rating_reason?: string | null
  created_at?: string | null
}

export function ticketsToCsv(rows: CsvTicket[]) {
  const headers = ['الرقم', 'المشكلة', 'الحالة', 'الأهمية', 'نوع العطل', 'القسم', 'بلاغ قسم', 'مقدّم البلاغ', 'رقم الموظف', 'الفني', 'الحل', 'التقييم', 'سبب التقييم', 'الوقت']
  const lines = rows.map((row) => [
    row.ticket_number,
    row.title,
    row.status,
    row.priority,
    row.fault_type,
    row.affected_department,
    row.is_outage ? 'نعم' : '',
    row.requester,
    row.requesterNumber,
    row.technician,
    row.resolution,
    row.rating,
    row.rating_reason,
    row.created_at
  ].map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(','))
  return `\uFEFF${headers.join(',')}\n${lines.join('\n')}`
}

export function downloadText(filename: string, contents: string) {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
