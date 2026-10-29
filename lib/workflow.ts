import type { SupabaseClient } from '@supabase/supabase-js'
import { rankSimilar } from '@/lib/similar'

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

export type QuickTip = { id: string; title: string; body: string }

const BUILTIN_TIPS: Record<string, QuickTip> = {
  طابعة: {
    id: 'tip-printer',
    title: 'الطابعة لا تطبع',
    body: 'تأكد أن الطابعة شغالة وفيها ورق وحبر، ثم أطفئها وشغلها. إذا استمر العطل أكمل البلاغ واكتب رقم الطابعة.'
  },
  شبكة: {
    id: 'tip-network',
    title: 'الشبكة قاطعة',
    body: 'إذا كان جهازك وحده بلا شبكة، أعد تشغيله وتأكد من الكابل. إذا كان القسم كله منقطعاً، رئيس القسم يفتح بلاغ قسم ويصل للدعم عاجلاً.'
  },
  حساب: {
    id: 'tip-account',
    title: 'لا أستطيع الدخول',
    body: 'تأكد من رقم الموظف أو البريد ومن كلمة المرور. الحساب الجديد لا يفتح قبل أن يعتمده مدير النظام.'
  },
  جهاز: {
    id: 'tip-device',
    title: 'الشاشة تطفئ أو الجهاز لا يعمل',
    body: 'افصل كهرباء الجهاز والشاشة ثلاثين ثانية ثم شغّلهما، وتأكد أن كابل الشاشة موصل. إذا استمر العطل اكتب رقم الجهاز وأكمل البلاغ.'
  },
  برامج: {
    id: 'tip-software',
    title: 'البرنامج لا يعمل',
    body: 'أغلق البرنامج ثم افتحه من جديد. إذا ظهرت رسالة خطأ، انسخها في وصف البلاغ.'
  }
}

export function quickTips(problem: string, fault: string, faqs: QuickTip[]) {
  const text = problem.trim()
  if (text.length >= 6) {
    const ranked = rankSimilar(text, faqs, (item) => `${item.title} ${item.body}`, 2, 0.25)
    if (ranked.length) return ranked
  }
  if (fault && fault !== 'أخرى') {
    const related = faqs.filter((item) => suggestFault(`${item.title} ${item.body}`) === fault)
    if (related.length) return related.slice(0, 2)
    const builtin = BUILTIN_TIPS[fault]
    if (builtin) return [builtin]
  }
  return []
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
