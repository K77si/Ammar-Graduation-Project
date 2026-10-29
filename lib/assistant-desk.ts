import { createClient } from '@supabase/supabase-js'
import { canManage, isOwner, serviceClient, type Actor } from '@/lib/server-auth'
import { writeAudit } from '@/lib/audit'
import { logSanadQuestion, tagRecentTicketEvents } from '@/lib/sanad-log'
import { FAULT_TYPES, isActive } from '@/lib/workflow'
import { similarity, normalizeArabic } from '@/lib/similar'
import { readTicketMeta } from '@/lib/ticket-thread'
import {
  DEPARTMENTS,
  TECH_DEPARTMENT,
  departmentLabel,
  formatTicketNo,
  isTechnicianRole,
  passwordError,
  roleLabel,
  statusLabel,
  storedDepartment
} from '@/lib/display'

export type DeskChoice = { id: string; label: string }
export type DeskFollowup = { kind: 'reopen'; ticketId: string; label: string }
export type DeskReply = {
  answer: string
  kind: 'stats' | 'action' | 'help'
  steps?: string[]
  choices?: DeskChoice[]
  confirm?: { action: string; label: string; payload: Record<string, string> }
  draft?: Record<string, string> | null
  followups?: DeskFollowup[]
}
export type DeskInput = {
  question: string
  choice?: string
  draft?: Record<string, string> | null
  confirm?: { action: string; payload: Record<string, string> } | null
  ticketId?: string
}
export type DeskOutcome =
  | { type: 'reply'; reply: DeskReply }
  | { type: 'help'; preface: string; facts: string }

type Row = {
  id: string
  title: string | null
  status: string
  created_at: string
  priority: string | null
  fault_type: string | null
  assigned_technician: string | null
  user_id: string | null
  ticket_number: number | null
  is_outage: boolean | null
  is_private: boolean | null
  affected_department: string | null
  rating: number | null
  resolution: string | null
}
type Person = {
  id: string
  full_name: string | null
  email: string | null
  username: string | null
  department: string | null
  role: string | null
  is_approved: boolean | null
  employee_number: string | null
  must_change_password: boolean | null
  availability: string | null
  is_owner: boolean | null
}
type Desk = {
  role: string
  department: string
  permissions: string[] | null
  start: string
  weekStart: string
  prevStart: string
  rows: Row[]
  people: Person[]
  names: Map<string, string>
  departments: string[]
  templates: string[]
  settings: { ai_enabled: boolean; email_alerts: boolean; strict_auth: boolean; force_password_change: boolean }
}

const COLUMNS = 'id, title, status, created_at, priority, fault_type, assigned_technician, user_id, ticket_number, is_outage, is_private, affected_department, rating, resolution'
const ROLE_CHOICES: DeskChoice[] = [
  { id: 'user', label: 'موظف' },
  { id: 'technician', label: 'فني الدعم' },
  { id: 'department_head', label: 'رئيس قسم' }
]
const CANCEL: DeskChoice = { id: 'cancel', label: 'إلغاء' }

function say(answer: string, extra: Partial<DeskReply> = {}): DeskReply {
  return { answer, kind: 'action', steps: [], ...extra }
}

function riyadhStart(daysAgo = 0) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const start = new Date(`${day}T00:00:00+03:00`)
  start.setTime(start.getTime() - daysAgo * 86400000)
  return start.toISOString()
}

function problemOf(row: Row) {
  return readTicketMeta(row.title).problem.replace(/\s+/g, ' ').trim()
}

function lineOf(row: Row, actorId: string, names: Map<string, string>) {
  const who = !row.assigned_technician ? 'غير مسند' : row.assigned_technician === actorId ? 'مسند لك' : (names.get(row.assigned_technician) || 'مسند لفني')
  const bits = [statusLabel(row.status), row.priority === 'عاجل' ? 'عاجل' : 'عادي', row.is_outage ? 'تعطل قسم' : '', row.is_private ? 'خاص' : '', who].filter(Boolean)
  return `${formatTicketNo(row.ticket_number)} ${problemOf(row).slice(0, 60)} — ${bits.join(' — ')}`
}

function listLines(rows: Row[], actorId: string, names: Map<string, string>, title: string) {
  if (!rows.length) return `${title}: لا يوجد.`
  const lines = rows.slice(0, 8).map((row) => lineOf(row, actorId, names))
  const more = rows.length > 8 ? `\nوغيرها ${rows.length - 8}.` : ''
  return `${title}: ${rows.length}.\n${lines.join('\n')}${more}`
}

function leaksSecret(text: string) {
  if (/سياسة|شروط|إعداد|اعداد/.test(text)) return false
  if (/أنشئ|انشئ|أضف مستخدم|اضف مستخدم|حساب جديد|سوّ?ب\s*يوزر/.test(text)) return false
  return /(?:كلمة\s*المرور|كلمة\s*السر|الباسورد|password)[^\n]{0,24}[A-Za-z0-9]{4,}/i.test(text)
}

function toolAction(text: string) {
  return /غيّر حالة|غير حالة|حدّث وضع|استلم|أسند|اسند|ملخص أعداد|أعداد البلاغات|عدد الموظفين|عدد الحسابات|أنشئ حساب|انشئ حساب|أضف مستخدم|اضف مستخدم|حساب جديد|سوّ?ب\s*يوزر|عدّل حساب|عدل حساب/.test(text)
}

function findPeople(people: Person[], text: string) {
  const query = normalizeArabic(text).replace(/[^\u0621-\u064a\s]/g, ' ').replace(/\s+/g, ' ').trim()
  const parts = query.split(' ').filter((part) => part.length >= 2)
  if (!parts.length) return []
  return people.filter((person) => {
    const name = normalizeArabic(person.full_name || '')
    return parts.every((part) => name.includes(part))
  }).slice(0, 8)
}

function personChoices(list: Person[]): DeskChoice[] {
  return list.map((person) => ({ id: person.id, label: `${person.full_name || 'مستخدم'} · ${roleLabel(person.role)} · ${departmentLabel(person.department)}` }))
}

function delayed(row: Row) {
  if (row.status !== 'مفتوحة' || row.assigned_technician) return false
  return Date.now() - new Date(row.created_at).getTime() > 24 * 60 * 60 * 1000
}

function asUser(request: Request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '', {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

async function loadDesk(actor: Actor): Promise<Desk> {
  const db = serviceClient()
  const start = riyadhStart(0)
  const weekStart = riyadhStart(6)
  const prevStart = riyadhStart(13)
  const { data: profile } = await db.from('profiles').select('role, department, admin_permissions').eq('id', actor.id).maybeSingle()
  const role = (profile?.role as string) || actor.role
  const department = (profile?.department as string) || ''
  const { data: settings } = await db.from('system_settings').select('ai_enabled, email_alerts, strict_auth, force_password_change, departments').eq('id', 'main_settings').maybeSingle()
  const departments = Array.isArray(settings?.departments) && settings.departments.length
    ? (settings.departments as string[]).map((item) => departmentLabel(item))
    : [...DEPARTMENTS]
  let memberIds: string[] = []
  if (role === 'department_head' && department) {
    const { data: members } = await db.from('profiles').select('id').eq('department', department)
    memberIds = (members || []).map((member) => member.id as string)
  }
  const scoped = () => {
    const query = db.from('tickets').select(COLUMNS)
    if (isTechnicianRole(role) || role === 'admin') return query
    if (role === 'department_head') return query.in('user_id', memberIds.length ? memberIds : [actor.id]).eq('is_private', false)
    return query.eq('user_id', actor.id)
  }
  const [recentRes, openRes, outageRes, peopleRes, templateRes] = await Promise.all([
    scoped().gte('created_at', prevStart).order('created_at', { ascending: false }).limit(250),
    scoped().in('status', ['مفتوحة', 'قيد المعالجة', 'بانتظار الموظف']).order('created_at', { ascending: false }).limit(200),
    role === 'department_head'
      ? db.from('tickets').select(COLUMNS).eq('is_outage', true).eq('affected_department', department).eq('is_private', false).order('created_at', { ascending: false }).limit(40)
      : Promise.resolve({ data: [] }),
    db.from('profiles').select('id, full_name, email, username, department, role, is_approved, employee_number, must_change_password, availability, is_owner').order('full_name').limit(500),
    db.from('reply_templates').select('body').order('sort_order', { ascending: true }).limit(12)
  ])
  const merged = new Map<string, Row>()
  for (const row of [...(recentRes.data || []), ...(openRes.data || []), ...(outageRes.data || [])] as Row[]) {
    if (row.id) merged.set(row.id, row)
  }
  const people = (peopleRes.data || []) as Person[]
  const names = new Map(people.map((person) => [person.id, person.full_name || 'مستخدم']))
  return {
    role,
    department,
    permissions: actor.permissions,
    start,
    weekStart,
    prevStart,
    rows: [...merged.values()],
    people,
    names,
    departments,
    templates: (templateRes.data || []).map((item) => String(item.body || '')).filter(Boolean),
    settings: {
      ai_enabled: settings?.ai_enabled !== false,
      email_alerts: settings?.email_alerts !== false,
      strict_auth: settings?.strict_auth === true,
      force_password_change: settings?.force_password_change !== false
    }
  }
}

function ticketByNumber(desk: Desk, value: string) {
  return desk.rows.find((row) => String(row.ticket_number) === value)
}

function statusHelp(question: string) {
  if (!/معنى|يعني|شرح/.test(question)) return ''
  const lines = [
    [/مفتوح/, 'مفتوح: البلاغ في الانتظار حتى يستلمه فني.'],
    [/معالج/, 'قيد المعالجة: استلمه فني ويعمل عليه.'],
    [/بانتظار/, 'بانتظار رد الموظف: الفني طلب معلومة، ويعود للعمل بعد الرد.'],
    [/منجز/, 'منجز: كتب الفني الحل، وبانتظار تأكيد الموظف، ثم يُغلق بعد 3 أيام.'],
    [/مغلق/, 'مغلق: انتهى البلاغ، ويمكن لصاحبه إعادة فتحه خلال 7 أيام.'],
    [/ملغ/, 'ملغى: ألغاه صاحبه قبل أن يستلمه فني.']
  ] as const
  const hit = lines.filter(([pattern]) => pattern.test(question)).map(([, text]) => text)
  return hit.length ? hit.join('\n') : lines.map(([, text]) => text).join('\n')
}

function clusters(rows: Row[]) {
  const since = Date.now() - 6 * 60 * 60 * 1000
  const counts = new Map<string, number>()
  rows.filter((row) => isActive(row.status) && new Date(row.created_at).getTime() >= since && row.fault_type && row.fault_type !== 'أخرى').forEach((row) => {
    counts.set(row.fault_type || '', (counts.get(row.fault_type || '') || 0) + 1)
  })
  return [...counts.entries()].filter(([, count]) => count >= 3)
}

function duplicatePairs(rows: Row[]) {
  const today = rows.slice(0, 25)
  const pairs: string[] = []
  for (let index = 0; index < today.length; index += 1) {
    for (let next = index + 1; next < today.length; next += 1) {
      const score = similarity(problemOf(today[index]), problemOf(today[next]))
      if (score >= 0.6) pairs.push(`${formatTicketNo(today[index].ticket_number)} و${formatTicketNo(today[next].ticket_number)}`)
      if (pairs.length >= 3) return pairs
    }
  }
  return pairs
}

function helpPreface(desk: Desk, actor: Actor, question: string) {
  const ownOpen = desk.rows.filter((row) => row.user_id === actor.id && isActive(row.status))
  const similar = ownOpen.find((row) => similarity(question, problemOf(row)) >= 0.5)
  const bits = []
  if (similar) bits.push(`عندك بلاغ مفتوح مشابه ${formatTicketNo(similar.ticket_number)} بعنوان «${problemOf(similar).slice(0, 50)}». لا تفتح بلاغاً جديداً إذا كانت نفس المشكلة.`)
  const closed = desk.rows.find((row) => row.user_id === actor.id && (row.status === 'مغلقة' || row.status === 'منجزة') && Date.now() - new Date(row.created_at).getTime() < 10 * 86400000 && similarity(question, problemOf(row)) >= 0.5)
  if (/رجعت|عادت|رجعت المشكلة|من جديد/.test(question) && closed) bits.push(`يمكن إعادة فتح ${formatTicketNo(closed.ticket_number)} خلال 7 أيام من إنجازه بدل بلاغ جديد.`)
  const group = clusters(desk.rows)
  if (group.length && (isTechnicianRole(desk.role) || desk.role === 'admin' || desk.role === 'department_head')) {
    bits.push(`تنبيه عطل جماعي: ${group.map(([fault, count]) => `${fault} (${count})`).join('، ')} خلال الساعات الأخيرة.`)
  }
  return bits.join('\n')
}

function ticketQuestion(question: string) {
  const about = /بلاغ|تذاكر|تذكرة|تذكره/.test(question)
  const asks = /كم|عدد|وش|ايش|إيش|ما هي|ماهي|عندنا|عندي|لدي|اليوم|عاجل|مفتوح|مسند|حالة|رقم|قائمة|وريني|اعطني|أعطني|متأخر|مكرر/.test(question)
  const fault = /مشكل|عطل|لا يعمل|ما يشتغل|ما تطبع|لا تطبع|طابع|شبك|انقطع|تعطل|جهاز|برنامج/.test(question)
  return about && asks && !fault
}

function rowsForQuestion(desk: Desk, actor: Actor, question: string) {
  const wanted = question.match(/(\d{3,})/)
  if (wanted) {
    const hit = ticketByNumber(desk, wanted[1])
    return hit ? [hit] : []
  }
  let rows = desk.rows
  const mine = /عندي|لدي|لي\b|المسندة لي/.test(question) && !/عندنا/.test(question)
  if (mine && isTechnicianRole(desk.role)) rows = rows.filter((row) => row.assigned_technician === actor.id)
  if (/اليوم/.test(question)) rows = rows.filter((row) => row.created_at >= desk.start)
  if (/عاجل/.test(question)) rows = rows.filter((row) => row.priority === 'عاجل')
  if (/لم تُسند|لم تسند|غير مسند|ما انسند|ما أُسند/.test(question)) rows = rows.filter((row) => !row.assigned_technician)
  if (/مفتوح|قيد/.test(question)) rows = rows.filter((row) => isActive(row.status))
  if (/بانتظار/.test(question)) rows = rows.filter((row) => row.status === 'بانتظار الموظف')
  if (/متأخر/.test(question)) rows = rows.filter(delayed)
  return rows
}

function answerTickets(desk: Desk, actor: Actor, question: string): DeskReply {
  const wanted = question.match(/(\d{3,})/)
  if (wanted) {
    const hit = ticketByNumber(desk, wanted[1])
    if (!hit) return say(`ما لقيت بلاغاً رقمه ${wanted[1]} ضمن الظاهر لك.`, { kind: 'stats' })
    if (hit.is_private && desk.role === 'department_head') return say('هذا البلاغ خاص ولا يظهر لرئيس القسم.', { kind: 'stats' })
    return say(lineOf(hit, actor.id, desk.names), { kind: 'stats' })
  }
  const rows = rowsForQuestion(desk, actor, question)
  const mine = /عندي|لدي|لي\b|المسندة لي/.test(question) && !/عندنا/.test(question)
  const scope = isTechnicianRole(desk.role) || desk.role === 'admin' ? (mine ? 'المسندة لك' : 'عند الدعم') : desk.role === 'department_head' ? `قسم ${departmentLabel(desk.department)}` : 'بلاغاتك'
  return say(listLines(rows, actor.id, desk.names, `${scope}${/اليوم/.test(question) ? ' اليوم' : ''}`), { kind: 'stats' })
}

function employeeDesk(desk: Desk, actor: Actor, question: string): DeskReply | null {
  if (/بانتظار|ينتظر رد/.test(question)) {
    const rows = desk.rows.filter((row) => row.user_id === actor.id && row.status === 'بانتظار الموظف')
    return say(rows.length ? `الفني ينتظر ردك في:\n${rows.map((row) => lineOf(row, actor.id, desk.names)).join('\n')}` : 'ما فيه بلاغ بانتظار ردك.', { kind: 'stats' })
  }
  if (/رجعت|عادت/.test(question)) {
    const closed = desk.rows.find((row) => row.user_id === actor.id && (row.status === 'مغلقة' || row.status === 'منجزة'))
    if (!closed) return say('ما فيه بلاغ مغلق حديث يمكن إعادة فتحه. افتح بلاغاً جديداً إذا استمرت المشكلة.', { kind: 'stats' })
    return say(`إذا رجعت مشكلة ${formatTicketNo(closed.ticket_number)} خلال 7 أيام من إنجازه، أعد فتحه بدل بلاغ جديد.`, {
      kind: 'action',
      followups: [{ kind: 'reopen', ticketId: closed.id, label: `أعد فتح ${formatTicketNo(closed.ticket_number)}` }]
    })
  }
  if (/تقييم|انحلت|تحلت/.test(question)) {
    const done = desk.rows.filter((row) => row.user_id === actor.id && (row.status === 'منجزة' || row.status === 'مغلقة') && !row.rating)
    return say(done.length ? `قيّم البلاغ من شاشته بعد التأكد أن المشكلة انحلت:\n${done.slice(0, 5).map((row) => lineOf(row, actor.id, desk.names)).join('\n')}` : 'ما فيه بلاغ منجز بانتظار تقييمك.', { kind: 'stats' })
  }
  return null
}

function technicianDesk(desk: Desk, actor: Actor, question: string): DeskReply | null {
  if (/وردية|أسلم|اسلم|تسليم/.test(question)) {
    const mine = desk.rows.filter((row) => row.assigned_technician === actor.id && isActive(row.status))
    const urgent = desk.rows.filter((row) => row.status === 'مفتوحة' && !row.assigned_technician && (row.priority === 'عاجل' || row.is_outage))
    return say(`${listLines(mine, actor.id, desk.names, 'مفتوح عندك للتسليم')}\n${listLines(urgent, actor.id, desk.names, 'عاجل لم يُستلم')}`, { kind: 'stats' })
  }
  if (/أستلم أولا|استلم اولا|أبدأ بأي|ابدأ بأي|أول بلاغ|اول بلاغ/.test(question)) {
    const next = desk.rows.filter((row) => row.status === 'مفتوحة' && !row.assigned_technician).sort((a, b) => Number(delayed(b)) - Number(delayed(a)) || Number(b.priority === 'عاجل') - Number(a.priority === 'عاجل'))
    return say(listLines(next, actor.id, desk.names, 'ابدأ بهذه البلاغات'), { kind: 'stats' })
  }
  if (/مكرر/.test(question)) {
    const pairs = duplicatePairs(desk.rows.filter((row) => row.created_at >= desk.start))
    return say(pairs.length ? `بلاغات اليوم المتشابهة:\n${pairs.join('\n')}` : 'ما ظهر تكرار واضح في تذاكر اليوم.', { kind: 'stats' })
  }
  if (/رد جاهز|قالب/.test(question)) {
    return say(desk.templates.length ? `قوالب الرد:\n${desk.templates.slice(0, 5).map((item, index) => `${index + 1}. ${item}`).join('\n')}` : 'ما فيه قوالب رد محفوظة.', { kind: 'stats' })
  }
  if (/ملاحظة/.test(question)) {
    const number = question.match(/(\d{3,})/)
    const body = question.split(/ملاحظة/).slice(1).join(' ').replace(/^[\s:]+/, '').trim()
    const hit = number ? ticketByNumber(desk, number[1]) : null
    if (!hit || body.length < 2) return say('اكتب: ملاحظة على رقم البلاغ ثم نص الملاحظة. الملاحظة يراها الفني والمدير فقط.', { kind: 'action' })
    return say(`تُحفظ ملاحظة داخلية على ${formatTicketNo(hit.ticket_number)} ولا يراها الموظف.`, {
      confirm: { action: 'note', label: 'احفظ الملاحظة', payload: { ticketId: hit.id, body: body.slice(0, 400) } }
    })
  }
  if (/قارن/.test(question)) {
    const numbers = [...question.matchAll(/(\d{3,})/g)].map((item) => item[1])
    const first = numbers[0] ? ticketByNumber(desk, numbers[0]) : null
    const second = numbers[1] ? ticketByNumber(desk, numbers[1]) : null
    if (!first || !second) return say('اكتب رقمي البلاغين، مثل: قارن 1021 و1024.', { kind: 'stats' })
    const score = similarity(problemOf(first), problemOf(second))
    const same = score >= 0.5 || (first.fault_type && first.fault_type === second.fault_type && first.fault_type !== 'أخرى')
    return say(`${lineOf(first, actor.id, desk.names)}\n${lineOf(second, actor.id, desk.names)}\n${same ? 'الغالب أنهما نفس العطل.' : 'يبدوان عطلين مختلفين.'}`, { kind: 'stats' })
  }
  if (/لخص|تاريخ/.test(question)) {
    const number = question.match(/(\d{3,})/)
    const hit = number ? ticketByNumber(desk, number[1]) : null
    if (!hit) return say('اكتب رقم البلاغ مع كلمة لخص أو تاريخ.', { kind: 'stats' })
    return say(`الخلاصة: ${lineOf(hit, actor.id, desk.names)}${hit.resolution ? `\nالحل المسجل: ${hit.resolution.slice(0, 180)}` : ''}`, { kind: 'stats' })
  }
  if (/أنجز|انجز|أغلق|اغلق/.test(question)) {
    const number = question.match(/(\d{3,})/)
    const hit = number ? ticketByNumber(desk, number[1]) : null
    if (!hit) return say('اكتب رقم البلاغ الذي تريد جعله منجزاً.', { kind: 'action' })
    if (!hit.fault_type || hit.fault_type === 'أخرى') {
      return say('قبل الإنجاز اختر نوع العطل.', {
        choices: FAULT_TYPES.filter((item) => item !== 'أخرى').map((item) => ({ id: item, label: item })),
        draft: { intent: 'close', step: 'fault', ticketId: hit.id }
      })
    }
    if ((hit.resolution || '').trim().length < 3) {
      return say('اكتب نص الحل في الرسالة التالية. لا يُنجز البلاغ من غيره.', { draft: { intent: 'close', step: 'resolution', ticketId: hit.id, fault: hit.fault_type } })
    }
    return say(`البلاغ ${formatTicketNo(hit.ticket_number)} فيه نوع عطل وحل. تأكيد الإنجاز.`, {
      confirm: { action: 'close', label: 'اجعله منجزاً', payload: { ticketId: hit.id, resolution: hit.resolution || '' } }
    })
  }
  return null
}

function headDesk(desk: Desk, actor: Actor, question: string): DeskReply | null {
  const mine = desk.rows.filter((row) => !row.is_private)
  if (/عطل جماعي|تعطل القسم|التعطل/.test(question)) {
    const outages = mine.filter((row) => row.is_outage && isActive(row.status))
    const personal = mine.filter((row) => !row.is_outage && isActive(row.status))
    return say(`${listLines(outages, actor.id, desk.names, 'تعطل القسم المفتوح')}\n${listLines(personal, actor.id, desk.names, 'بلاغات الموظفين الفردية')}`, { kind: 'stats' })
  }
  if (/موظفي|موظفين قسم/.test(question)) {
    const open = mine.filter((row) => isActive(row.status) && !row.is_outage)
    const grouped = new Map<string, number>()
    open.forEach((row) => grouped.set(row.user_id || '', (grouped.get(row.user_id || '') || 0) + 1))
    const lines = [...grouped.entries()].map(([id, count]) => `${desk.names.get(id) || 'موظف'}: ${count}`).slice(0, 8)
    return say(lines.length ? `بلاغات مفتوحة حسب الموظف:\n${lines.join('\n')}` : 'ما فيه بلاغ فردي مفتوح في القسم.', { kind: 'stats' })
  }
  if (/الفني المتابع|مين متابع|من المتابع/.test(question)) {
    const counts = new Map<string, number>()
    mine.filter((row) => isActive(row.status) && row.assigned_technician).forEach((row) => counts.set(row.assigned_technician || '', (counts.get(row.assigned_technician || '') || 0) + 1))
    const lines = [...counts.entries()].map(([id, count]) => `${desk.names.get(id) || 'فني'}: ${count}`)
    return say(lines.length ? `المتابعة الآن:\n${lines.join('\n')}` : 'ما فيه فني مسند على بلاغات القسم حالياً.', { kind: 'stats' })
  }
  if (/الأسبوع|الاسبوع|مقارنة/.test(question)) {
    const thisWeek = mine.filter((row) => row.created_at >= desk.weekStart).length
    const prev = mine.filter((row) => row.created_at >= desk.prevStart && row.created_at < desk.weekStart).length
    const direction = thisWeek === prev ? 'مثل الأسبوع السابق' : thisWeek > prev ? 'أكثر من الأسبوع السابق' : 'أقل من الأسبوع السابق'
    return say(`بلاغات قسم ${departmentLabel(desk.department)} هذا الأسبوع ${thisWeek}، والسابق ${prev}. الوضع ${direction}.`, { kind: 'stats' })
  }
  if (/تقييم ضعيف|تقييم منخفض|تقييم سيئ/.test(question)) {
    const weak = mine.filter((row) => typeof row.rating === 'number' && row.rating <= 2)
    return say(listLines(weak, actor.id, desk.names, 'تقييم ضعيف'), { kind: 'stats' })
  }
  if (/رسالة للقسم|أخبر الموظفين|اخبر الموظفين/.test(question)) {
    const open = mine.filter((row) => row.is_outage && isActive(row.status))
    const text = open.length
      ? `زملاء قسم ${departmentLabel(desk.department)}: ما زال بلاغ التعطل مفتوحاً لدى الدعم. نبلغكم فور رجوع الخدمة.`
      : `زملاء قسم ${departmentLabel(desk.department)}: لا يوجد تعطل قسم مفتوح حالياً. إذا بقيت مشكلة فردية فافتح بلاغاً.`
    return say(text, { kind: 'stats' })
  }
  if (/للمدير|جملة للمدير/.test(question)) {
    const open = mine.filter((row) => isActive(row.status))
    const outage = open.filter((row) => row.is_outage).length
    return say(`قسم ${departmentLabel(desk.department)}: ${open.length} بلاغ مفتوح، منها ${outage} تعطل قسم.`, { kind: 'stats' })
  }
  return null
}

function adminDesk(desk: Desk, actor: Actor, question: string): DeskReply | null {
  if (/تقرير|ملخص المناقشة|ملخص للمناقشة/.test(question)) {
    const today = desk.rows.filter((row) => row.created_at >= desk.start).length
    const week = desk.rows.filter((row) => row.created_at >= desk.weekStart).length
    const open = desk.rows.filter((row) => isActive(row.status)).length
    const urgent = desk.rows.filter((row) => row.priority === 'عاجل' && isActive(row.status)).length
    const waiting = desk.rows.filter((row) => row.status === 'مفتوحة' && !row.assigned_technician).length
    const done = desk.rows.filter((row) => row.created_at >= desk.weekStart && (row.status === 'منجزة' || row.status === 'مغلقة')).length
    return say(`اليوم دخل ${today} بلاغ. هذا الأسبوع ${week}. المفتوح الآن ${open}، منها ${urgent} عاجل، و${waiting} لم يُسند. المنجز أو المغلق هذا الأسبوع ${done}.`, { kind: 'stats' })
  }
  if (/أكثر الأعطال|اكثر الاعطال|أنواع العطل|انواع العطل/.test(question)) {
    const counts = new Map<string, number>()
    desk.rows.filter((row) => row.created_at >= desk.weekStart).forEach((row) => counts.set(row.fault_type || 'أخرى', (counts.get(row.fault_type || 'أخرى') || 0) + 1))
    const lines = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([fault, count]) => `${fault}: ${count}`)
    return say(lines.length ? `أعطال هذا الأسبوع:\n${lines.join('\n')}` : 'ما فيه بلاغات هذا الأسبوع.', { kind: 'stats' })
  }
  if (/حمل الفني|اداء الفني|أداء الفني|مين فاضي|من فاضي/.test(question)) {
    const techs = desk.people.filter((person) => isTechnicianRole(person.role))
    const lines = techs.map((person) => {
      const open = desk.rows.filter((row) => row.assigned_technician === person.id && isActive(row.status)).length
      return `${person.full_name}: ${open} مفتوح · ${person.availability || 'متاح'}`
    })
    return say(lines.length ? lines.join('\n') : 'ما فيه فنيون.', { kind: 'stats' })
  }
  if (/حسابات ناقصة|بدون قسم|بدون رقم|لم تُعتمد|لم تعتمد|بانتظار الاعتماد/.test(question)) {
    const pending = desk.people.filter((person) => person.is_approved === false)
    const incomplete = desk.people.filter((person) => !person.department || !person.employee_number || person.must_change_password)
    const lines = [
      pending.length ? `بانتظار الاعتماد:\n${pending.slice(0, 6).map((person) => person.full_name).join('، ')}` : 'لا حسابات بانتظار الاعتماد.',
      incomplete.length ? `بيانات ناقصة أو كلمة مرور لم تُغيّر:\n${incomplete.slice(0, 6).map((person) => person.full_name).join('، ')}` : ''
    ].filter(Boolean)
    return say(lines.join('\n'), { kind: 'stats', choices: pending.slice(0, 6).map((person) => ({ id: person.id, label: `اعتمد ${person.full_name}` })), draft: pending.length ? { intent: 'approve', step: 'pick' } : null })
  }
  if (/وريني حساب|بيانات حساب|حساب /.test(question) && !/مقف|عطل|مشكل/.test(question)) {
    const name = question.replace(/.*حساب\s*/, '').trim()
    const found = findPeople(desk.people, name)
    if (!found.length) return say('ما لقيت حساباً بهذا الاسم.', { kind: 'stats' })
    const lines = found.map((person) => `${person.full_name} · ${roleLabel(person.role)} · ${departmentLabel(person.department)} · ${person.employee_number || 'بدون رقم'} · ${person.is_approved === false ? 'بانتظار الاعتماد' : 'معتمد'}`)
    return say(lines.join('\n'), { kind: 'stats' })
  }
  if (/الإعدادات|الاعدادات|سياسة كلمة|المساعد شغ|المساعد متوقف/.test(question)) {
    const ai = desk.settings.ai_enabled ? 'المساعد شغّال' : 'المساعد متوقف'
    const mail = desk.settings.email_alerts ? 'تنبيهات البوابة مفعّلة' : 'تنبيهات البوابة متوقفة'
    const password = desk.settings.strict_auth ? 'كلمة المرور صارمة: 8 أحرف وفيها حرف ورقم.' : 'كلمة المرور 6 أحرف على الأقل، و123456 ممنوعة.'
    const change = desk.settings.force_password_change ? 'الحساب الجديد يغيّر كلمة المرور عند أول دخول.' : 'لا يُفرض تغيير كلمة المرور.'
    return say(`${ai}. ${mail}. ${password} ${change}\nالأقسام: ${desk.departments.join('، ')}`, { kind: 'stats' })
  }
  if (/أوقف المساعد|اوقف المساعد|شغّل المساعد|شغل المساعد/.test(question)) {
    if (!canManage(actor, 'settings')) return say('تشغيل المساعد من صلاحية الإعدادات.')
    const enable = /شغ/.test(question)
    return say(enable ? 'سيعمل المساعد لكل الأدوار بعد التأكيد.' : 'سيتوقف اقتراح الحلول وأوامر المساعد بعد التأكيد. أسئلة الإعدادات ترجع من صفحة الإعدادات.', {
      confirm: { action: 'toggle_ai', label: enable ? 'شغّل المساعد' : 'أوقف المساعد', payload: { enabled: enable ? 'true' : 'false' } }
    })
  }
  if (/أضف قسم|اضف قسم|قسم جديد/.test(question)) {
    if (!canManage(actor, 'settings')) return say('إضافة الأقسام من صلاحية الإعدادات.')
    const name = question.replace(/.*قسم(?:\s+جديد)?\s*(?:باسم|اسمه)?\s*/, '').trim()
    if (name.length < 2) return say('اكتب: أضف قسم باسم ثم اسم القسم.', { kind: 'action' })
    return say(`سيُضاف القسم «${name}» إلى الإعدادات.`, { confirm: { action: 'add_department', label: 'أضف القسم', payload: { name } } })
  }
  if (/اسم قسم/.test(question)) {
    const match = question.match(/قسم\s+(.+?)\s+(?:إلى|الى)\s+(.+)/)
    if (!match) return say('اكتب: غيّر اسم قسم المالية إلى الحسابات.', { kind: 'action' })
    return say(`سيصبح قسم «${match[1].trim()}» باسم «${match[2].trim()}» في الإعدادات وحسابات الموظفين.`, {
      confirm: { action: 'rename_department', label: 'غيّر اسم القسم', payload: { from: match[1].trim(), to: match[2].trim() } }
    })
  }
  if (/سوّ?ب\s*يوزر|أنشئ|انشئ|أضف مستخدم|اضف مستخدم|حساب جديد/.test(question)) {
    if (!canManage(actor, 'users')) return say('إنشاء الحسابات من صلاحية المستخدمين.')
    const named = question.match(/(?:باسم|اسمه)\s+([\u0600-\u06FF\s]{3,40})/)
    const fullName = named?.[1]?.trim() || ''
    if (fullName.length < 3) return say('اكتب: سوّب يوزر باسم ثم الاسم الثلاثي.', { kind: 'action' })
    return say(`إنشاء حساب باسم ${fullName}. اختر الدور. حساب مدير النظام يُنشأ من شاشة المستخدمين لأنه يحتاج كلمة المالك.`, {
      choices: [...ROLE_CHOICES, CANCEL],
      draft: { intent: 'create_user', step: 'role', fullName }
    })
  }
  if (/(?:غيّ?ر|بدّ?ل|بدل|إعادة تعيين|اعادة تعيين|أعد تعيين|اعد تعيين).{0,40}(?:كلمة\s*(?:السر|المرور)|باسورد)|(?:كلمة\s*(?:السر|المرور)|باسورد).{0,40}(?:جديد|غيّ?ر|بدّ?ل)/.test(question)) {
    if (!canManage(actor, 'reset_password')) return say('تغيير كلمة المرور من صلاحية إعادة التعيين.')
    const name = question.replace(/كلمة\s*(?:السر|المرور)|باسورد|جديد|إعادة|اعادة|تعيين|غيّ?ر|بدّ?ل|بدل|حساب|للمستخدم|للموظف/g, ' ')
    const found = findPeople(desk.people, name)
    if (!found.length) return say('اكتب: غيّر كلمة مرور ثم اسم الحساب.', { kind: 'action' })
    if (found.length > 1) return say('أكثر من حساب. اختر واحداً.', { choices: personChoices(found), draft: { intent: 'reset_password', step: 'pick' } })
    return passwordPrompt(found[0])
  }
  if (/احذف|عطّل حساب|عطل حساب|أوقف حساب|اوقف حساب/.test(question)) {
    const disabling = /عط|اوقف|أوقف/.test(question)
    if (!canManage(actor, disabling ? 'approvals' : 'delete_users')) return say(disabling ? 'تعطيل الحساب من صلاحية الاعتمادات.' : 'حذف الحساب من صلاحية حذف الحسابات.')
    const name = question.replace(/.*(?:احذف|حساب)\s*/, '').trim()
    const found = findPeople(desk.people, name)
    if (!found.length) return say('ما لقيت هذا الحساب.', { kind: 'action' })
    if (found.length > 1) return say('أكثر من حساب. اختر واحداً.', { choices: personChoices(found), draft: { intent: disabling ? 'disable' : 'delete', step: 'pick' } })
    return confirmPerson(actor, desk, found[0], disabling ? 'disable' : 'delete')
  }
  if (/انقل|حوّل|حول|غيّر دور|غير دور|خل دور/.test(question)) {
    if (!canManage(actor, 'users')) return say('تعديل الحساب من صلاحية المستخدمين.')
    const move = question.match(/(?:انقل|حوّل|حول)\s+(.+?)\s+(?:إلى|الى|لقسم)\s+(.+)/)
    const roleChange = question.match(/(?:دور)\s+(.+?)\s+(?:إلى|الى)?\s*(موظف|فني(?:\s+الدعم)?|رئيس(?:\s+قسم)?)/)
    if (move) {
      const found = findPeople(desk.people, move[1])
      if (found.length !== 1) return say(found.length ? 'اختر الحساب.' : 'ما لقيت الحساب.', { choices: personChoices(found), draft: { intent: 'move', step: 'pick', department: move[2].trim() } })
      return say(`نقل ${found[0].full_name} إلى ${move[2].trim()}.`, { confirm: { action: 'update_user', label: 'انقل الحساب', payload: { userId: found[0].id, department: move[2].trim(), role: found[0].role || 'user' } } })
    }
    if (roleChange) {
      const role = /فني/.test(roleChange[2]) ? 'technician' : /رئيس/.test(roleChange[2]) ? 'department_head' : 'user'
      const found = findPeople(desk.people, roleChange[1])
      if (found.length !== 1) return say('حدد الحساب من القائمة.', { choices: personChoices(found), draft: { intent: 'role', step: 'pick', role } })
      return say(`تغيير دور ${found[0].full_name} إلى ${roleLabel(role)}.`, { confirm: { action: 'update_user', label: 'غيّر الدور', payload: { userId: found[0].id, role, department: found[0].department || '' } } })
    }
    return say('اكتب: انقل الاسم إلى اسم القسم، أو غيّر دور الاسم إلى فني.', { kind: 'action' })
  }
  if (/أسند|اسند/.test(question)) {
    if (!canManage(actor, 'tickets')) return say('إسناد البلاغ من صلاحية البلاغات.')
    const number = question.match(/(\d{3,})/)
    const hit = number ? ticketByNumber(desk, number[1]) : null
    if (!hit) return say('اكتب: أسند رقم البلاغ.', { kind: 'action' })
    const techs = desk.people.filter((person) => isTechnicianRole(person.role) && person.availability !== 'خارج الدوام' && person.is_approved !== false)
      .map((person) => ({ person, open: desk.rows.filter((row) => row.assigned_technician === person.id && isActive(row.status)).length }))
      .sort((a, b) => a.open - b.open)
    if (!techs.length) return say('ما فيه فني متاح الآن.', { kind: 'stats' })
    const best = techs[0]
    return say(`أقترح إسناد ${formatTicketNo(hit.ticket_number)} إلى ${best.person.full_name}، عنده ${best.open} بلاغ مفتوح.`, {
      confirm: { action: 'assign', label: 'أسند البلاغ', payload: { ticketId: hit.id, technicianId: best.person.id } }
    })
  }
  if (/أضف الحل|اضف الحل|للأسئلة الشائعة|للاسئلة الشائعة/.test(question)) {
    if (!canManage(actor, 'settings')) return say('إضافة الحلول من صلاحية الإعدادات.')
    const number = question.match(/(\d{3,})/)
    const hit = number ? ticketByNumber(desk, number[1]) : null
    if (!hit || (hit.resolution || '').trim().length < 3) return say('اكتب: أضف الحل للأسئلة الشائعة من بلاغ رقمه، بعد ما يكون الحل مسجلاً.', { kind: 'action' })
    return say(`سيُضاف حل ${formatTicketNo(hit.ticket_number)} إلى الأسئلة الشائعة.`, {
      confirm: { action: 'add_faq', label: 'أضف الحل', payload: { title: problemOf(hit).slice(0, 80), body: (hit.resolution || '').slice(0, 500) } }
    })
  }
  return null
}

function passwordPrompt(person: Person): DeskReply {
  if (isOwner(person)) return say('لا يمكن تغيير كلمة مرور المالك من هنا.')
  return say(`اكتب كلمة المرور الجديدة لـ ${person.full_name} وحدها في الرسالة التالية. لن أعيدها.`, {
    choices: [CANCEL],
    draft: { intent: 'reset_password', step: 'password', userId: person.id }
  })
}

function confirmPerson(actor: Actor, desk: Desk, person: Person, action: 'delete' | 'disable'): DeskReply {
  if (person.id === actor.id) return say('لا يمكن تنفيذ ذلك على حسابك الحالي.')
  if (isOwner(person)) return say('لا يمكن حذف حساب المالك أو تعطيله.')
  if (action === 'delete' && person.role === 'admin' && desk.people.filter((item) => item.role === 'admin').length <= 1) return say('لا يمكن حذف مدير النظام الوحيد.')
  const label = action === 'delete' ? `احذف ${person.full_name}` : `عطّل ${person.full_name}`
  return say(action === 'delete' ? `سيُحذف حساب ${person.full_name} نهائياً.` : `سيُوقف دخول ${person.full_name} حتى يُعتمد من جديد.`, {
    confirm: { action, label, payload: { userId: person.id } }
  })
}

function continueDraft(desk: Desk, actor: Actor, input: DeskInput): DeskReply {
  const draft = { ...(input.draft || {}) }
  const choice = input.choice || ''
  const text = input.question.trim()
  if (choice === 'cancel' || /^(إلغاء|الغاء|ألغ|الغِ)$/.test(text)) return say('تم إلغاء الأمر.', { draft: null })
  if (draft.intent === 'approve' && choice) {
    const person = desk.people.find((item) => item.id === choice)
    if (!person) return say('الحساب غير موجود.', { draft: null })
    return say(`اعتماد ${person.full_name}.`, { confirm: { action: 'approve', label: 'اعتمد الحساب', payload: { userId: person.id } }, draft: null })
  }
  if (draft.intent === 'reset_password' && draft.step === 'pick') {
    const person = choice ? desk.people.find((item) => item.id === choice) : null
    if (!person) return say('اختر الحساب من الأزرار، أو ألغِ الأمر.', { choices: [CANCEL], draft })
    return passwordPrompt(person)
  }
  if (draft.intent === 'reset_password' && draft.step === 'password') {
    const weak = passwordError(text, desk.settings.strict_auth)
    if (weak) return say(weak, { choices: [CANCEL], draft })
    const person = desk.people.find((item) => item.id === draft.userId)
    return say(`تأكيد تعيين كلمة مرور جديدة لـ ${person?.full_name || 'الحساب'}. لن تُعرض الكلمة.`, {
      choices: [CANCEL],
      confirm: { action: 'reset_password', label: 'عيّن كلمة المرور', payload: { userId: draft.userId, password: text } },
      draft: null
    })
  }
  if ((draft.intent === 'delete' || draft.intent === 'disable') && choice) {
    const person = desk.people.find((item) => item.id === choice)
    if (!person) return say('الحساب غير موجود.', { draft: null })
    return confirmPerson(actor, desk, person, draft.intent)
  }
  if (draft.intent === 'move' && choice) {
    const person = desk.people.find((item) => item.id === choice)
    if (!person) return say('الحساب غير موجود.', { draft: null })
    return say(`نقل ${person.full_name} إلى ${draft.department}.`, { confirm: { action: 'update_user', label: 'انقل الحساب', payload: { userId: person.id, department: draft.department, role: person.role || 'user' } }, draft: null })
  }
  if (draft.intent === 'role' && choice) {
    const person = desk.people.find((item) => item.id === choice)
    if (!person) return say('الحساب غير موجود.', { draft: null })
    return say(`تغيير دور ${person.full_name}.`, { confirm: { action: 'update_user', label: 'غيّر الدور', payload: { userId: person.id, role: draft.role, department: person.department || '' } }, draft: null })
  }
  if (draft.intent === 'close' && draft.step === 'fault' && choice) {
    return say('اكتب نص الحل في الرسالة التالية.', { draft: { ...draft, step: 'resolution', fault: choice } })
  }
  if (draft.intent === 'close' && draft.step === 'resolution') {
    if (text.length < 3) return say('الحل أقصر من المطلوب. اكتب ماذا تم إصلاحه.', { draft })
    return say('تأكيد جعل البلاغ منجزاً بهذا الحل.', { confirm: { action: 'close', label: 'اجعله منجزاً', payload: { ticketId: draft.ticketId, resolution: text.slice(0, 500), fault: draft.fault || '' } }, draft: null })
  }
  if (draft.intent !== 'create_user') return say('الأمر انقطع. ابدأ من جديد.', { draft: null })
  if (draft.step === 'role') {
    if (!ROLE_CHOICES.some((item) => item.id === choice)) return say('اختر الدور من الأزرار.', { choices: [...ROLE_CHOICES, CANCEL], draft })
    draft.role = choice
    if (choice === 'technician') {
      draft.department = TECH_DEPARTMENT
      draft.step = 'email'
      return say(`الدور فني الدعم والقسم ${TECH_DEPARTMENT}. اكتب البريد الإلكتروني.`, { choices: [CANCEL], draft })
    }
    draft.step = 'department'
    return say('اختر القسم.', { choices: [...desk.departments.map((item) => ({ id: item, label: item })), CANCEL], draft })
  }
  if (draft.step === 'department') {
    if (!choice || choice === 'cancel') return say('اختر القسم من الأزرار.', { choices: [...desk.departments.map((item) => ({ id: item, label: item })), CANCEL], draft })
    draft.department = choice
    draft.step = 'email'
    return say('اكتب البريد الإلكتروني.', { choices: [CANCEL], draft })
  }
  if (draft.step === 'email') {
    if (!text.includes('@') || !text.includes('.')) return say('البريد غير واضح. اكتبه مثل name@company.com', { choices: [CANCEL], draft })
    draft.email = text.toLowerCase()
    draft.step = 'username'
    return say('اكتب اسم المستخدم بالإنجليزية، بدون مسافات.', { choices: [CANCEL], draft })
  }
  if (draft.step === 'username') {
    if (!/^[a-z0-9._-]{3,30}$/i.test(text)) return say('اسم المستخدم من 3 إلى 30 حرفاً إنجليزياً أو رقماً.', { choices: [CANCEL], draft })
    draft.username = text.toLowerCase()
    draft.step = 'number'
    return say('اكتب رقم الموظف من 9 أرقام.', { choices: [CANCEL], draft })
  }
  if (draft.step === 'number') {
    const employeeNumber = text.replace(/\D/g, '')
    if (!/^\d{9}$/.test(employeeNumber)) return say('رقم الموظف يجب أن يكون 9 أرقام.', { choices: [CANCEL], draft })
    draft.employeeNumber = employeeNumber
    draft.step = 'password'
    return say('اكتب كلمة المرور. لن أعيدها في الرد.', { choices: [CANCEL], draft })
  }
  if (draft.step === 'password') {
    const weak = passwordError(text, desk.settings.strict_auth)
    if (weak) return say(weak, { choices: [CANCEL], draft })
    draft.password = text
    draft.step = 'confirm'
    return say(`راجع الحساب ثم أكد:\nالاسم: ${draft.fullName}\nالدور: ${roleLabel(draft.role)}\nالقسم: ${draft.department}\nالبريد: ${draft.email}\nالمستخدم: ${draft.username}\nرقم الموظف: ${draft.employeeNumber}\nكلمة المرور محفوظة لهذه الخطوة ولن تُعرض.`, {
      choices: [CANCEL],
      confirm: {
        action: 'create_user',
        label: 'أنشئ الحساب',
        payload: {
          fullName: draft.fullName,
          role: draft.role,
          department: draft.department,
          email: draft.email,
          username: draft.username,
          employeeNumber: draft.employeeNumber,
          password: draft.password
        }
      },
      draft: null
    })
  }
  return say('ابدأ إنشاء الحساب من جديد.', { draft: null })
}

async function execute(actor: Actor, request: Request, desk: Desk, action: string, payload: Record<string, string>): Promise<DeskReply> {
  const db = serviceClient()
  if (action === 'toggle_ai') {
    if (!canManage(actor, 'settings')) return say('ليست لديك صلاحية الإعدادات.')
    const enabled = payload.enabled === 'true'
    const saved = await db.from('system_settings').update({ ai_enabled: enabled }).eq('id', 'main_settings')
    if (saved.error) return say('تعذّر تغيير حالة المساعد.')
    await writeAudit(actor.id, enabled ? 'تشغيل المساعد' : 'إيقاف المساعد', 'المساعد الذكي', '', { source: 'سند' })
    return say(enabled ? 'تم تشغيل المساعد.' : 'تم إيقاف المساعد.')
  }
  if (action === 'add_department') {
    if (!canManage(actor, 'settings')) return say('ليست لديك صلاحية الإعدادات.')
    const name = departmentLabel(payload.name || '')
    if (desk.departments.some((item) => departmentLabel(item) === name)) return say('القسم موجود.')
    const saved = await db.from('system_settings').update({ departments: [...desk.departments, name] }).eq('id', 'main_settings')
    if (saved.error) return say('تعذّر إضافة القسم.')
    await writeAudit(actor.id, 'إضافة قسم', name, '', { source: 'سند' })
    return say(`تمت إضافة قسم ${name}. حدّث الصفحة لرؤيته في الإعدادات.`)
  }
  if (action === 'rename_department') {
    if (!canManage(actor, 'settings')) return say('ليست لديك صلاحية الإعدادات.')
    const from = payload.from.trim()
    const to = departmentLabel(payload.to || '')
    const next = desk.departments.map((item) => departmentLabel(item) === departmentLabel(from) ? to : item)
    const saved = await db.from('system_settings').update({ departments: next }).eq('id', 'main_settings')
    if (saved.error) return say('تعذّر تعديل القسم.')
    await db.from('profiles').update({ department: to }).eq('department', from)
    await writeAudit(actor.id, 'تعديل قسم', to, from, { source: 'سند' })
    return say(`أصبح القسم ${to}.`)
  }
  if (action === 'approve' || action === 'disable') {
    if (!canManage(actor, 'approvals')) return say('ليست لديك صلاحية الاعتمادات.')
    const person = desk.people.find((item) => item.id === payload.userId)
    if (!person) return say('الحساب غير موجود.')
    if (person.id === actor.id || isOwner(person)) return say('لا يمكن تغيير حالة هذا الحساب.')
    const saved = await db.from('profiles').update({ is_approved: action === 'approve' }).eq('id', person.id)
    if (saved.error) return say('تعذّر تحديث الحساب.')
    await writeAudit(actor.id, action === 'approve' ? 'اعتماد حساب' : 'إيقاف حساب', person.full_name || 'مستخدم', '', { source: 'سند', targetId: person.id })
    return say(action === 'approve' ? `تم اعتماد ${person.full_name}.` : `تم إيقاف ${person.full_name}.`)
  }
  if (action === 'delete') {
    if (!canManage(actor, 'delete_users')) return say('ليست لديك صلاحية حذف الحسابات.')
    const person = desk.people.find((item) => item.id === payload.userId)
    if (!person) return say('الحساب غير موجود.')
    if (person.id === actor.id) return say('لا يمكن حذف حسابك الحالي.')
    if (isOwner(person)) return say('لا يمكن حذف حساب المالك.')
    if (person.role === 'admin' && desk.people.filter((item) => item.role === 'admin').length <= 1) return say('لا يمكن حذف مدير النظام الوحيد.')
    const removed = await db.auth.admin.deleteUser(person.id)
    if (removed.error && !/not found/i.test(removed.error.message)) return say('تعذّر حذف حساب الدخول.')
    const deleted = await db.from('profiles').delete().eq('id', person.id)
    if (deleted.error) return say('حُذف الدخول وتعذّر حذف الملف. أعد المحاولة.')
    await writeAudit(actor.id, 'حذف حساب', person.full_name || 'مستخدم', person.role || '', { source: 'سند', targetId: person.id })
    return say(`تم حذف ${person.full_name}.`)
  }
  if (action === 'update_user') {
    if (!canManage(actor, 'users')) return say('ليست لديك صلاحية المستخدمين.')
    const person = desk.people.find((item) => item.id === payload.userId)
    if (!person || isOwner(person)) return say('لا يمكن تعديل هذا الحساب من هنا.')
    const nextRole = payload.role === 'manager' ? 'technician' : (payload.role || person.role || 'user')
    if (nextRole === 'admin') return say('ترقية مدير النظام تتم من شاشة المستخدمين بكلمة المالك.')
    const checked = storedDepartment(nextRole, payload.department || person.department || '')
    if ('error' in checked) return say(checked.error)
    const saved = await db.from('profiles').update({ role: nextRole, department: checked.department }).eq('id', person.id)
    if (saved.error) return say('تعذّر تعديل الحساب.')
    await writeAudit(actor.id, 'تعديل حساب', person.full_name || 'مستخدم', `${roleLabel(nextRole)} · ${checked.department}`, { source: 'سند', targetId: person.id })
    return say(`تم تحديث ${person.full_name}: ${roleLabel(nextRole)}، ${checked.department}.`)
  }
  if (action === 'create_user') {
    if (!canManage(actor, 'users')) return say('ليست لديك صلاحية المستخدمين.')
    const role = payload.role === 'manager' ? 'technician' : payload.role
    if (role === 'admin' || !['user', 'technician', 'department_head'].includes(role)) return say('هذا الدور لا يُنشأ من المحادثة.')
    const checked = storedDepartment(role, payload.department)
    if ('error' in checked) return say(checked.error)
    const employeeNumber = (payload.employeeNumber || '').replace(/\D/g, '')
    if (!/^\d{9}$/.test(employeeNumber)) return say('رقم الموظف يجب أن يكون 9 أرقام.')
    const weak = passwordError(payload.password || '', desk.settings.strict_auth)
    if (weak) return say(weak)
    const email = (payload.email || '').trim().toLowerCase()
    const username = (payload.username || '').trim().toLowerCase()
    const fullName = (payload.fullName || '').trim()
    const [{ data: sameEmail }, { data: sameUsername }, { data: sameNumber }] = await Promise.all([
      db.from('profiles').select('id').ilike('email', email).maybeSingle(),
      db.from('profiles').select('id').ilike('username', username).maybeSingle(),
      db.from('profiles').select('id').eq('employee_number', employeeNumber).maybeSingle()
    ])
    if (sameEmail || sameUsername) return say('هذا البريد أو اسم المستخدم مستخدم لحساب آخر.')
    if (sameNumber) return say('رقم الموظف مستخدم لحساب آخر.')
    const created = await db.auth.admin.createUser({ email, password: payload.password, email_confirm: true, user_metadata: { full_name: fullName } })
    if (created.error || !created.data.user) return say('تعذر إنشاء حساب الدخول.')
    const approved = canManage(actor, 'approvals')
    const saved = await db.from('profiles').upsert({
      id: created.data.user.id,
      full_name: fullName,
      email,
      username,
      department: checked.department,
      role,
      is_approved: approved,
      password: null,
      temp_password: null,
      employee_number: employeeNumber,
      must_change_password: desk.settings.force_password_change,
      admin_permissions: null
    })
    if (saved.error) {
      await db.auth.admin.deleteUser(created.data.user.id)
      return say('تعذر حفظ ملف المستخدم.')
    }
    await writeAudit(actor.id, 'إنشاء حساب', fullName, roleLabel(role), { source: 'سند', targetId: created.data.user.id })
    return say(`تم إنشاء حساب ${fullName}. ${approved ? 'الحساب معتمد.' : 'الحساب بانتظار الاعتماد.'} حدّث صفحة المستخدمين لرؤيته.`)
  }
  if (action === 'reset_password') {
    if (!canManage(actor, 'reset_password')) return say('ليست لديك صلاحية تغيير كلمة المرور.')
    const person = desk.people.find((item) => item.id === payload.userId)
    if (!person || isOwner(person)) return say('لا يمكن تغيير كلمة مرور هذا الحساب من هنا.')
    const weak = passwordError(payload.password || '', desk.settings.strict_auth)
    if (weak) return say(weak)
    const updated = await db.auth.admin.updateUserById(person.id, { password: payload.password })
    if (updated.error) return say('تعذر تغيير كلمة المرور.')
    await db.from('profiles').update({ password: null, temp_password: null, must_change_password: true }).eq('id', person.id)
    await writeAudit(actor.id, 'إعادة تعيين كلمة المرور', person.full_name || 'مستخدم', '', { source: 'سند', targetId: person.id })
    return say(`تم تعيين كلمة مرور جديدة لـ ${person.full_name}. سيُطلب منه تغييرها عند الدخول.`)
  }
  if (action === 'assign' || action === 'close' || action === 'note') {
    const client = asUser(request)
    if (action === 'close' && payload.fault) {
      await client.rpc('ticket_action', { ticket: payload.ticketId, action: 'fault', payload: { fault_type: payload.fault, via: 'sanad' } })
    }
    const call = action === 'assign'
      ? await client.rpc('ticket_action', { ticket: payload.ticketId, action: 'assign', payload: { technician_id: payload.technicianId, via: 'sanad' } })
      : action === 'note'
        ? await client.rpc('ticket_action', { ticket: payload.ticketId, action: 'note', payload: { body: payload.body, via: 'sanad' } })
        : await client.rpc('ticket_action', { ticket: payload.ticketId, action: 'status', payload: { status: 'منجزة', resolution: payload.resolution, via: 'sanad' } })
    if (call.error) return say(call.error.message || 'تعذّر تنفيذ الإجراء على البلاغ.')
    await tagRecentTicketEvents(payload.ticketId)
    if (action === 'close') return say('أصبح البلاغ منجزاً. إذا تكرر العطل قل: أضف الحل للأسئلة الشائعة من بلاغ رقمه.')
    if (action === 'note') return say('حُفظت الملاحظة الداخلية.')
    return say('تم إسناد البلاغ.')
  }
  if (action === 'add_faq') {
    if (!canManage(actor, 'settings')) return say('ليست لديك صلاحية الإعدادات.')
    const { data: last } = await db.from('faq_items').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle()
    const saved = await db.from('faq_items').insert({ title: payload.title.slice(0, 80), body: payload.body.slice(0, 500), sort_order: (last?.sort_order || 0) + 1 })
    if (saved.error) return say('تعذّر إضافة الحل إلى الأسئلة الشائعة.')
    await writeAudit(actor.id, 'إضافة حل شائع', payload.title, '', { source: 'سند' })
    return say('أُضيف الحل إلى الأسئلة الشائعة.')
  }
  return say('هذا الإجراء غير معروف.')
}

async function traceQuestion(actor: Actor, request: Request, desk: Desk, input: DeskInput) {
  if (input.confirm || input.draft?.intent || input.choice) return
  const question = input.question.trim()
  if (question.length < 5 || question === 'تأكيد') return
  let ticketId = input.ticketId || ''
  let status: string | null = null
  const client = asUser(request)
  if (ticketId) {
    const { data } = await client.from('tickets').select('id, status').eq('id', ticketId).maybeSingle()
    if (!data?.id) return
    status = (data.status as string) || null
  } else {
    const number = question.match(/(\d{3,})/)
    if (!number) return
    const local = ticketByNumber(desk, number[1])
    if (local) {
      ticketId = local.id
      status = local.status
    } else {
      const { data } = await client.from('tickets').select('id, status').eq('ticket_number', Number(number[1])).maybeSingle()
      if (!data?.id) return
      ticketId = data.id as string
      status = (data.status as string) || null
    }
  }
  await logSanadQuestion({ ticketId, actorName: desk.names.get(actor.id) || 'مستخدم', status, question })
}

async function recordListedQuestions(desk: Desk, actor: Actor, question: string) {
  if (question.match(/(\d{3,})/)) return
  const rows = rowsForQuestion(desk, actor, question).slice(0, 8)
  const actorName = desk.names.get(actor.id) || 'مستخدم'
  for (const row of rows) {
    await logSanadQuestion({ ticketId: row.id, actorName, status: row.status, question })
  }
}

export async function interpret(actor: Actor, request: Request, input: DeskInput): Promise<DeskOutcome> {
  const desk = await loadDesk(actor)
  const question = input.question.trim()
  const typingSecret = (input.draft?.intent === 'create_user' || input.draft?.intent === 'reset_password') && input.draft.step === 'password'
  if (!typingSecret && leaksSecret(question)) {
    return { type: 'reply', reply: say('لا ترسل كلمة المرور داخل الرسالة. احذفها، وتغييرها يكون من صفحة الدخول أو من مدير النظام.') }
  }
  if (input.choice === 'cancel') return { type: 'reply', reply: say('تم إلغاء الأمر.', { draft: null }) }
  await traceQuestion(actor, request, desk, input)
  if (input.confirm?.action) {
    return { type: 'reply', reply: await execute(actor, request, desk, input.confirm.action, input.confirm.payload || {}) }
  }
  if (input.draft?.intent) {
    return { type: 'reply', reply: continueDraft(desk, actor, input) }
  }
  const meaning = /معنى|يعني|شرح الحالة/.test(question) ? statusHelp(question) : ''
  if (meaning) return { type: 'reply', reply: say(meaning, { kind: 'stats' }) }
  const role = desk.role
  if (toolAction(question)) {
    const facts = answerTickets(desk, actor, role === 'department_head' || role === 'user' ? 'بلاغاتي المفتوحة' : 'وش عندنا تذاكر اليوم والمفتوحة').answer
    return { type: 'help', preface: helpPreface(desk, actor, question), facts }
  }
  const specific = role === 'admin'
    ? adminDesk(desk, actor, question)
    : role === 'department_head'
      ? headDesk(desk, actor, question) || employeeDesk(desk, actor, question)
      : isTechnicianRole(role)
        ? technicianDesk(desk, actor, question)
        : employeeDesk(desk, actor, question)
  if (specific) return { type: 'reply', reply: specific }
  if (ticketQuestion(question) || /عطل جماعي|متأخر/.test(question)) {
    await recordListedQuestions(desk, actor, question)
    return { type: 'reply', reply: answerTickets(desk, actor, question) }
  }
  const facts = answerTickets(desk, actor, role === 'department_head' || role === 'user' ? 'بلاغاتي المفتوحة' : 'وش عندنا تذاكر اليوم والمفتوحة').answer
  return { type: 'help', preface: helpPreface(desk, actor, question), facts }
}
