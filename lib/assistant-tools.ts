import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { jsonSchema, tool, type JSONSchema7 } from 'ai'
import { writeAudit } from '@/lib/audit'
import {
  DEPARTMENTS,
  TECH_DEPARTMENT,
  departmentLabel,
  isTechnicianRole,
  normalizeDigits,
  passwordError,
  roleLabel,
  storedDepartment
} from '@/lib/display'
import { canManage, isOwner, serviceClient, type Actor } from '@/lib/server-auth'
import { FAULT_TYPES } from '@/lib/workflow'

const ROLE_DENIED = 'هذا الإجراء غير متاح لهذا الدور.'
const USERS_DENIED = 'ليست لديك صلاحية المستخدمين.'
const TICKETS_DENIED = 'ليست لديك صلاحية البلاغات.'
const PROFILE_FIELDS = 'id, full_name, email, username, department, role, employee_number, is_approved, is_owner'
const STATUSES = ['مفتوحة', 'قيد المعالجة', 'بانتظار الموظف', 'منجزة', 'مغلقة', 'ملغاة'] as const

type ToolOutput = { ok: boolean; error?: string; [key: string]: unknown }

type ToolSpec = {
  name: string
  description: string
  schema: JSONSchema7
}

const objectSchema = (properties: JSONSchema7['properties']): JSONSchema7 => ({
  type: 'object',
  properties,
  additionalProperties: false
})

const TOOLS: ToolSpec[] = [
  {
    name: 'get_employees_count',
    description: 'يعد حسابات جدول profiles. متاح فقط لمدير النظام الذي يملك صلاحية المستخدمين. الموظف والفني ورئيس القسم يُرفضون. لا تخترع الرقم، ولا ترسل هوية المتصل.',
    schema: objectSchema({
      role: { type: 'string', enum: ['user', 'technician', 'department_head', 'admin'], description: 'اختياري. technician يشمل manager. اتركه فارغاً لعد كل الحسابات.' },
      department: { type: 'string', description: 'اسم القسم إن طُلب قسم محدد.' },
      approved_only: { type: 'boolean', description: 'true للمعتمدين فقط.' }
    })
  },
  {
    name: 'search_employees',
    description: 'يبحث في حسابات profiles بالاسم أو البريد أو القسم. لمدير يملك صلاحية المستخدمين فقط. يعيد 8 صفوف كحد أقصى بلا كلمات مرور. لا تستخدمه لمعرفة هوية المتصل.',
    schema: objectSchema({
      query: { type: 'string', description: 'جزء من الاسم أو البريد أو القسم.' }
    })
  },
  {
    name: 'create_employee',
    description: 'ينشئ حساب دخول وملف profiles. لمدير يملك صلاحية المستخدمين. الحقول اللازمة: الاسم، البريد، اسم المستخدم، رقم موظف من 9 أرقام، القسم، الدور، وكلمة المرور. إذا نقص حقل فأعد الخطأ واطلبه. لا تخترع كلمة مرور ولا تنشئ مدير نظام من المحادثة.',
    schema: objectSchema({
      full_name: { type: 'string' },
      email: { type: 'string' },
      username: { type: 'string' },
      employee_number: { type: 'string' },
      department: { type: 'string' },
      role: { type: 'string', enum: ['user', 'technician', 'department_head'] },
      password: { type: 'string' }
    })
  },
  {
    name: 'update_employee',
    description: 'يعدّل ملف حساب آخر: الاسم أو البريد أو القسم أو الدور أو رقم الموظف. لمدير يملك صلاحية المستخدمين. لا يغيّر حساب المالك ولا يرقّي إلى مدير نظام. حدّد الحساب الهدف بالاسم أو البريد أو المعرّف، لا هوية المتصل.',
    schema: objectSchema({
      user_id: { type: 'string', description: 'معرّف الحساب المراد تعديله إن كان معروفاً من بحث سابق.' },
      query: { type: 'string', description: 'اسم أو بريد الحساب المراد تعديله.' },
      full_name: { type: 'string' },
      email: { type: 'string' },
      department: { type: 'string' },
      role: { type: 'string', enum: ['user', 'technician', 'department_head'] },
      employee_number: { type: 'string' }
    })
  },
  {
    name: 'get_tickets_summary',
    description: 'أعداد البلاغات ضمن ما تسمح به جلسة المتصل: الموظف بلاغاته، رئيس القسم بلاغات قسمه غير الخاصة، الفني كل البلاغات، والمدير إذا ملك صلاحية البلاغات. لا ترسل هوية المستخدم.',
    schema: objectSchema({})
  },
  {
    name: 'create_ticket',
    description: 'يفتح بلاغاً لصاحب الجلسة فقط. user_id يُؤخذ من الدخول وليس من النص. النوع من الأنواع المعتمدة. العاجل يحتاج سبب توقف العمل.',
    schema: objectSchema({
      title: { type: 'string', description: 'وصف المشكلة، 5 أحرف على الأقل.' },
      fault_type: { type: 'string', enum: [...FAULT_TYPES] },
      priority: { type: 'string', enum: ['عادي', 'عاجل'] },
      priority_reason: { type: 'string' },
      site_place: { type: 'string' },
      device_number: { type: 'string' },
      is_private: { type: 'boolean' },
      is_outage: { type: 'boolean', description: 'بلاغ تعطل قسم، ورئيس القسم فقط يستطيع فتحه.' }
    })
  },
  {
    name: 'update_ticket_status',
    description: 'يغيّر حالة بلاغ أو يسنده عبر ticket_action. الموظف ورئيس القسم لا يستخدمونها. الفني يغيّر الحالة ويستلم البلاغ لنفسه. إسناد فني آخر لمدير يملك صلاحية البلاغات. لا تطلب من المستخدم كتابة معرّفه.',
    schema: objectSchema({
      ticket_id: { type: 'string' },
      ticket_number: { type: 'string', description: 'رقم البلاغ الظاهر، مثل 1021.' },
      status: { type: 'string', enum: [...STATUSES] },
      resolution: { type: 'string', description: 'نص الحل، لازم قبل الحالة منجزة.' },
      assign_self: { type: 'boolean', description: 'true ليستلم المتصل البلاغ لنفسه. يُستخدم معرّف الجلسة.' },
      technician_id: { type: 'string', description: 'معرّف الفني المراد إسناد البلاغ إليه. للمدير فقط.' },
      technician_name: { type: 'string', description: 'اسم الفني إن لم يُعرف معرّفه. للمدير فقط، ويُبحث بين الفنيين.' }
    })
  }
]

export const anthropicTools: Anthropic.Tool[] = TOOLS.map((item) => ({
  name: item.name,
  description: item.description,
  input_schema: item.schema as Anthropic.Tool.InputSchema
}))

export function asksEmployeeCount(question: string) {
  return /كم|عدد/.test(question) && /موظف|حساب|فني|مستخدم|رئيس|مدير/.test(question)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function textField(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function userClient(request: Request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '', {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

async function sessionRole(actor: Actor) {
  const { data } = await serviceClient().from('profiles').select('role, department').eq('id', actor.id).maybeSingle()
  const role = (typeof data?.role === 'string' && data.role) || actor.role
  const department = typeof data?.department === 'string' ? data.department : ''
  return { actor: { ...actor, role }, role, department }
}

function usersAdmin(actor: Actor) {
  return actor.role === 'admin' && canManage(actor, 'users')
}

function ticketsAdmin(actor: Actor) {
  return actor.role === 'admin' && canManage(actor, 'tickets')
}

function denyDirectory(actor: Actor): ToolOutput | null {
  if (actor.role !== 'admin') return { ok: false, error: ROLE_DENIED }
  if (!canManage(actor, 'users')) return { ok: false, error: USERS_DENIED }
  return null
}

function cleanDepartment(value: string) {
  const trimmed = value.replace(/^قسم\s+/, '').trim()
  return trimmed ? departmentLabel(trimmed) : ''
}

function roleList(value: string): string[] | null {
  if (!value || value === 'all') return null
  if (value === 'technician' || value === 'manager') return ['technician', 'manager']
  if (value === 'user' || value === 'department_head' || value === 'admin') return [value]
  return null
}

async function getEmployeesCount(actor: Actor, raw: unknown): Promise<ToolOutput> {
  const denied = denyDirectory(actor)
  if (denied) return denied
  const input = asRecord(raw)
  const role = textField(input.role)
  const roles = roleList(role)
  if (role && !roles) return { ok: false, error: 'الدور غير معروف. استخدم user أو technician أو department_head أو admin.' }
  const department = cleanDepartment(textField(input.department))
  const approvedOnly = input.approved_only === true
  let query = serviceClient().from('profiles').select('id', { count: 'exact', head: true })
  if (roles) query = query.in('role', roles)
  if (department) query = query.eq('department', department)
  if (approvedOnly) query = query.eq('is_approved', true)
  const { count, error } = await query
  if (error) return { ok: false, error: 'تعذر عد الحسابات.' }
  return { ok: true, count: count ?? 0, role: role || 'all', department: department || 'all', approved_only: approvedOnly }
}

async function searchEmployees(actor: Actor, raw: unknown): Promise<ToolOutput> {
  const denied = denyDirectory(actor)
  if (denied) return denied
  const queryText = textField(asRecord(raw).query).replace(/[%_,]/g, '').slice(0, 60)
  if (queryText.length < 2) return { ok: false, error: 'اكتب حرفين على الأقل من الاسم أو البريد أو القسم.' }
  const pattern = `%${queryText}%`
  const db = serviceClient()
  const [byName, byEmail, byDepartment] = await Promise.all([
    db.from('profiles').select(PROFILE_FIELDS).ilike('full_name', pattern).limit(8),
    db.from('profiles').select(PROFILE_FIELDS).ilike('email', pattern).limit(8),
    db.from('profiles').select(PROFILE_FIELDS).ilike('department', pattern).limit(8)
  ])
  if (byName.error || byEmail.error || byDepartment.error) return { ok: false, error: 'تعذر البحث في الحسابات.' }
  const seen = new Set<string>()
  const employees = []
  for (const row of [...(byName.data || []), ...(byEmail.data || []), ...(byDepartment.data || [])]) {
    const key = String(row.email || row.full_name || '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    employees.push({
      full_name: row.full_name,
      email: row.email,
      department: row.department,
      role: row.role,
      employee_number: row.employee_number,
      is_approved: row.is_approved
    })
    if (employees.length >= 8) break
  }
  return { ok: true, employees }
}

async function createEmployee(actor: Actor, raw: unknown): Promise<ToolOutput> {
  const denied = denyDirectory(actor)
  if (denied) return denied
  const input = asRecord(raw)
  const fullName = textField(input.full_name)
  const email = textField(input.email).toLowerCase()
  const username = textField(input.username).toLowerCase()
  const employeeNumber = normalizeDigits(textField(input.employee_number)).replace(/\D/g, '')
  const department = textField(input.department)
  let role = textField(input.role) || 'user'
  if (role === 'manager') role = 'technician'
  const password = typeof input.password === 'string' ? input.password : ''
  const missing = [
    fullName.length < 3 ? 'الاسم' : '',
    email ? '' : 'البريد',
    username ? '' : 'اسم المستخدم',
    /^\d{9}$/.test(employeeNumber) ? '' : 'رقم الموظف من 9 أرقام',
    department ? '' : 'القسم',
    password ? '' : 'كلمة المرور'
  ].filter(Boolean)
  if (missing.length) return { ok: false, error: `ناقص: ${missing.join('، ')}. اطلب الحقول الناقصة. لا تُنشأ كلمة مرور ولا يُتجاوز إنشاء حساب الدخول.` }
  if (role === 'admin' || !['user', 'technician', 'department_head'].includes(role)) {
    return { ok: false, error: 'هذا الدور لا يُنشأ من المحادثة. ترقية مدير النظام تتم من شاشة المستخدمين بكلمة المالك.' }
  }
  const checked = storedDepartment(role, department)
  if ('error' in checked) return { ok: false, error: checked.error }
  const db = serviceClient()
  const { data: settings } = await db.from('system_settings').select('strict_auth, force_password_change, departments').eq('id', 'main_settings').maybeSingle()
  const weak = passwordError(password, settings?.strict_auth === true)
  if (weak) return { ok: false, error: weak }
  const known = Array.isArray(settings?.departments) && settings.departments.length
    ? (settings.departments as string[]).map((item) => departmentLabel(item))
    : DEPARTMENTS
  if (!known.includes(departmentLabel(checked.department)) && checked.department !== TECH_DEPARTMENT) {
    return { ok: false, error: 'القسم غير موجود في إعدادات الأقسام.' }
  }
  const [{ data: sameEmail }, { data: sameUsername }, { data: sameNumber }] = await Promise.all([
    db.from('profiles').select('id').ilike('email', email).maybeSingle(),
    db.from('profiles').select('id').ilike('username', username).maybeSingle(),
    db.from('profiles').select('id').eq('employee_number', employeeNumber).maybeSingle()
  ])
  if (sameEmail || sameUsername) return { ok: false, error: 'هذا البريد أو اسم المستخدم مستخدم لحساب آخر.' }
  if (sameNumber) return { ok: false, error: 'رقم الموظف مستخدم لحساب آخر.' }
  const created = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName }
  })
  if (created.error || !created.data.user) {
    const rawMessage = created.error?.message || ''
    return { ok: false, error: /already|registered|exists/i.test(rawMessage) ? 'هذا البريد مستخدم لحساب آخر.' : 'تعذر إنشاء حساب الدخول.' }
  }
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
    must_change_password: settings?.force_password_change !== false,
    admin_permissions: null
  })
  if (saved.error) {
    await db.auth.admin.deleteUser(created.data.user.id)
    return { ok: false, error: 'تعذر حفظ ملف المستخدم، ولم يُترك حساب دخول بلا ملف.' }
  }
  await writeAudit(actor.id, 'إنشاء حساب', fullName, roleLabel(role))
  return { ok: true, full_name: fullName, email, role, department: checked.department, approved }
}

type ProfileRow = {
  id: string
  full_name: string | null
  email: string | null
  department: string | null
  role: string | null
  employee_number: string | null
  is_owner: boolean | null
}

async function findTargets(queryText: string, userId: string): Promise<{ error: string } | { people: ProfileRow[] }> {
  const db = serviceClient()
  if (userId) {
    const { data, error } = await db.from('profiles').select(PROFILE_FIELDS).eq('id', userId).maybeSingle()
    if (error) return { error: 'تعذر قراءة الحساب.' }
    if (!data) return { error: 'الحساب غير موجود.' }
    return { people: [data as ProfileRow] }
  }
  const safe = queryText.replace(/[%_,]/g, '').slice(0, 60)
  if (safe.length < 2) return { error: 'حدد الحساب الهدف بالاسم أو البريد.' }
  const pattern = `%${safe}%`
  const [byName, byEmail] = await Promise.all([
    db.from('profiles').select(PROFILE_FIELDS).ilike('full_name', pattern).limit(8),
    db.from('profiles').select(PROFILE_FIELDS).ilike('email', pattern).limit(8)
  ])
  if (byName.error || byEmail.error) return { error: 'تعذر البحث عن الحساب.' }
  const seen = new Set<string>()
  const people: ProfileRow[] = []
  for (const row of [...(byName.data || []), ...(byEmail.data || [])] as ProfileRow[]) {
    if (!row.id || seen.has(row.id)) continue
    seen.add(row.id)
    people.push(row)
    if (people.length >= 8) break
  }
  if (!people.length) return { error: 'ما لقيت حساباً بهذا الاسم أو البريد.' }
  return { people }
}

async function updateEmployee(actor: Actor, raw: unknown): Promise<ToolOutput> {
  const denied = denyDirectory(actor)
  if (denied) return denied
  const input = asRecord(raw)
  const found = await findTargets(textField(input.query), textField(input.user_id))
  if ('error' in found) return { ok: false, error: found.error }
  if (found.people.length !== 1) {
    return {
      ok: false,
      error: 'أكثر من حساب. حدد واحداً بالمعرّف.',
      matches: found.people.map((person) => ({
        user_id: person.id,
        full_name: person.full_name,
        email: person.email,
        department: person.department,
        role: person.role
      }))
    }
  }
  const person = found.people[0]
  if (isOwner(person)) return { ok: false, error: 'لا يمكن تعديل حساب المالك من هنا.' }
  const requestedRole = textField(input.role)
  const nextRole = requestedRole === 'manager' ? 'technician' : (requestedRole || person.role || 'user')
  if (nextRole === 'admin' && person.role !== 'admin') {
    return { ok: false, error: 'ترقية مدير النظام تتم من شاشة المستخدمين بكلمة المالك.' }
  }
  if (!['user', 'technician', 'department_head', 'admin'].includes(nextRole)) {
    return { ok: false, error: 'هذا الدور غير مسموح.' }
  }
  const patch: Record<string, string> = {}
  const fullName = textField(input.full_name)
  if (fullName) patch.full_name = fullName.slice(0, 80)
  if (requestedRole || textField(input.department)) {
    const checked = storedDepartment(nextRole, textField(input.department) || person.department || '')
    if ('error' in checked) return { ok: false, error: checked.error }
    patch.role = nextRole
    patch.department = checked.department
  }
  const employeeNumber = normalizeDigits(textField(input.employee_number)).replace(/\D/g, '')
  if (textField(input.employee_number)) {
    if (!/^\d{9}$/.test(employeeNumber)) return { ok: false, error: 'رقم الموظف يجب أن يكون 9 أرقام.' }
    const { data: sameNumber } = await serviceClient().from('profiles').select('id').eq('employee_number', employeeNumber).neq('id', person.id).maybeSingle()
    if (sameNumber) return { ok: false, error: 'رقم الموظف مستخدم لحساب آخر.' }
    patch.employee_number = employeeNumber
  }
  const email = textField(input.email).toLowerCase()
  if (email && email !== (person.email || '').toLowerCase()) {
    const { data: sameEmail } = await serviceClient().from('profiles').select('id').ilike('email', email).neq('id', person.id).maybeSingle()
    if (sameEmail) return { ok: false, error: 'هذا البريد مستخدم لحساب آخر.' }
    const updated = await serviceClient().auth.admin.updateUserById(person.id, { email, email_confirm: true })
    if (updated.error) return { ok: false, error: 'تعذر تحديث بريد الدخول.' }
    patch.email = email
  }
  if (!Object.keys(patch).length) return { ok: false, error: 'لا توجد حقول للتحديث. يمكن تعديل الاسم أو البريد أو القسم أو الدور أو رقم الموظف.' }
  const saved = await serviceClient().from('profiles').update(patch).eq('id', person.id)
  if (saved.error) return { ok: false, error: 'تعذر تعديل الحساب.' }
  await writeAudit(actor.id, 'تعديل حساب', patch.full_name || person.full_name || 'مستخدم', `${roleLabel(patch.role || person.role)} · ${patch.department || person.department || ''}`)
  return { ok: true, user_id: person.id, updated: patch }
}

async function getTicketsSummary(actor: Actor, request: Request): Promise<ToolOutput> {
  const session = await sessionRole(actor)
  if (session.role === 'admin' && !canManage(session.actor, 'tickets')) return { ok: false, error: TICKETS_DENIED }
  const client = userClient(request)
  let memberIds: string[] = []
  if (session.role === 'department_head') {
    const { data: members } = await serviceClient().from('profiles').select('id').eq('department', session.department)
    memberIds = (members || []).map((member) => member.id as string)
    if (!memberIds.length) memberIds = [actor.id]
  }
  const countStatuses = async (statuses: string[]) => {
    let query = client.from('tickets').select('id', { count: 'exact', head: true }).in('status', statuses)
    if (session.role === 'department_head') query = query.in('user_id', memberIds).eq('is_private', false)
    else if (!isTechnicianRole(session.role) && session.role !== 'admin') query = query.eq('user_id', actor.id)
    const { count, error } = await query
    if (error) throw error
    return count ?? 0
  }
  try {
    const [open, pending, closed] = await Promise.all([
      countStatuses(['مفتوحة', 'قيد المعالجة']),
      countStatuses(['بانتظار الموظف']),
      countStatuses(['منجزة', 'مغلقة'])
    ])
    const scope = session.role === 'admin' || isTechnicianRole(session.role) ? 'staff' : session.role === 'department_head' ? 'department' : 'own'
    return { ok: true, open, pending, closed, scope }
  } catch {
    return { ok: false, error: 'تعذر قراءة ملخص البلاغات.' }
  }
}

async function createTicket(actor: Actor, request: Request, raw: unknown): Promise<ToolOutput> {
  const input = asRecord(raw)
  const title = textField(input.title)
  const fault = textField(input.fault_type)
  const priority = textField(input.priority) === 'عاجل' ? 'عاجل' : 'عادي'
  const priorityReason = textField(input.priority_reason)
  const isOutage = input.is_outage === true
  if (title.length < 5) return { ok: false, error: 'اكتب وصف المشكلة في 5 أحرف على الأقل.' }
  if (!(FAULT_TYPES as readonly string[]).includes(fault)) return { ok: false, error: `نوع العطل يجب أن يكون أحد: ${FAULT_TYPES.join('، ')}.` }
  if (priority === 'عاجل' && !isOutage && priorityReason.length < 3) return { ok: false, error: 'البلاغ العاجل يحتاج سبب وقوف الشغل.' }
  const inserted = await userClient(request).from('tickets').insert([{
    title,
    status: 'مفتوحة',
    ai_resolved: false,
    user_id: actor.id,
    priority: isOutage ? 'عاجل' : priority,
    priority_reason: isOutage ? (priorityReason || 'القسم متعطل') : priorityReason,
    fault_type: fault,
    site_place: textField(input.site_place),
    device_number: textField(input.device_number),
    is_private: isOutage ? false : input.is_private === true,
    is_outage: isOutage
  }]).select('id, ticket_number, status')
  if (inserted.error || !inserted.data?.[0]) {
    const message = inserted.error?.message || ''
    return { ok: false, error: /[\u0600-\u06FF]/.test(message) ? message : 'تعذر فتح البلاغ.' }
  }
  const row = inserted.data[0]
  return { ok: true, ticket_id: row.id, ticket_number: row.ticket_number, status: row.status }
}

async function ticketIdFrom(request: Request, rawId: string, rawNumber: string) {
  if (rawId) return rawId
  const digits = normalizeDigits(rawNumber).replace(/\D/g, '')
  if (!digits) return ''
  const { data } = await userClient(request).from('tickets').select('id').eq('ticket_number', Number(digits)).maybeSingle()
  return (data?.id as string) || ''
}

async function resolveTechnician(nameOrId: string): Promise<{ id: string } | { error: string; matches?: unknown[] }> {
  if (/^[0-9a-f-]{36}$/i.test(nameOrId)) return { id: nameOrId }
  const safe = nameOrId.replace(/[%_,]/g, '').slice(0, 60)
  if (safe.length < 2) return { error: 'حدد الفني بالاسم.' }
  const { data, error } = await serviceClient().from('profiles').select('id, full_name, availability').in('role', ['technician', 'manager']).ilike('full_name', `%${safe}%`).limit(8)
  if (error) return { error: 'تعذر البحث عن الفني.' }
  const matches = data || []
  if (matches.length === 1) return { id: matches[0].id as string }
  if (!matches.length) return { error: 'ما لقيت فنياً بهذا الاسم.' }
  return { error: 'أكثر من فني. حدد المعرّف.', matches: matches.map((person) => ({ technician_id: person.id, full_name: person.full_name, availability: person.availability })) }
}

async function updateTicketStatus(actor: Actor, request: Request, raw: unknown): Promise<ToolOutput> {
  const session = await sessionRole(actor)
  const tech = isTechnicianRole(session.role)
  if (session.role === 'admin' && !canManage(session.actor, 'tickets')) return { ok: false, error: TICKETS_DENIED }
  if (!tech && session.role !== 'admin') return { ok: false, error: ROLE_DENIED }
  const input = asRecord(raw)
  const status = textField(input.status)
  const assignSelf = input.assign_self === true
  const technicianRaw = textField(input.technician_id) || textField(input.technician_name)
  if (status === 'ملغاة') return { ok: false, error: 'إلغاء البلاغ لصاحب البلاغ من شاشته وهو ما زال مفتوحاً ولم يُسند.' }
  if (status && !STATUSES.includes(status as typeof STATUSES[number])) return { ok: false, error: 'حالة غير معروفة.' }
  if (status === 'منجزة' && textField(input.resolution).length < 3) return { ok: false, error: 'اكتب الحل قبل جعل البلاغ منجزاً.' }
  if (!status && !assignSelf && !technicianRaw) return { ok: false, error: 'حدد الحالة، أو استلام البلاغ، أو الفني.' }
  const ticket = await ticketIdFrom(request, textField(input.ticket_id), textField(input.ticket_number))
  if (!ticket) return { ok: false, error: 'حدد رقم البلاغ الظاهر لك.' }
  const client = userClient(request)
  let claimedSelf = false
  if (assignSelf || (tech && technicianRaw === actor.id)) {
    const claimed = await client.rpc('ticket_action', { ticket, action: 'claim', payload: {} })
    if (claimed.error && !status) return { ok: false, error: claimed.error.message }
    claimedSelf = !claimed.error
  } else if (technicianRaw) {
    if (tech) return { ok: false, error: 'الفني يستلم البلاغ لنفسه فقط. إسناد فني آخر لمدير يملك صلاحية البلاغات.' }
    if (!ticketsAdmin(session.actor)) return { ok: false, error: TICKETS_DENIED }
    const resolved = await resolveTechnician(technicianRaw)
    if ('error' in resolved) return { ok: false, error: resolved.error, matches: resolved.matches }
    const assigned = await client.rpc('ticket_action', { ticket, action: 'assign', payload: { technician_id: resolved.id } })
    if (assigned.error) return { ok: false, error: assigned.error.message }
  }
  if (status) {
    const payload: Record<string, string> = { status }
    const resolution = textField(input.resolution)
    if (resolution) payload.resolution = resolution
    const changed = await client.rpc('ticket_action', { ticket, action: 'status', payload })
    if (changed.error) return { ok: false, error: changed.error.message }
  }
  return { ok: true, ticket_id: ticket, status: status || undefined, claimed_self: claimedSelf || undefined }
}

export async function runAssistantTool(name: string, raw: unknown, actor: Actor, request: Request): Promise<ToolOutput> {
  try {
    const session = await sessionRole(actor)
    if (name === 'get_employees_count') return getEmployeesCount(session.actor, raw)
    if (name === 'search_employees') return searchEmployees(session.actor, raw)
    if (name === 'create_employee') return createEmployee(session.actor, raw)
    if (name === 'update_employee') return updateEmployee(session.actor, raw)
    if (name === 'get_tickets_summary') return getTicketsSummary(session.actor, request)
    if (name === 'create_ticket') return createTicket(session.actor, request, raw)
    if (name === 'update_ticket_status') return updateTicketStatus(session.actor, request, raw)
    return { ok: false, error: 'أداة غير معروفة.' }
  } catch {
    return { ok: false, error: 'تعذر تنفيذ الإجراء.' }
  }
}

export function assistantGatewayTools(actor: Actor, request: Request) {
  const execute = (name: string) => async (input: unknown) => runAssistantTool(name, input, actor, request)
  return {
    get_employees_count: tool({ description: TOOLS[0].description, inputSchema: jsonSchema(TOOLS[0].schema), execute: execute('get_employees_count') }),
    search_employees: tool({ description: TOOLS[1].description, inputSchema: jsonSchema(TOOLS[1].schema), execute: execute('search_employees') }),
    create_employee: tool({ description: TOOLS[2].description, inputSchema: jsonSchema(TOOLS[2].schema), execute: execute('create_employee') }),
    update_employee: tool({ description: TOOLS[3].description, inputSchema: jsonSchema(TOOLS[3].schema), execute: execute('update_employee') }),
    get_tickets_summary: tool({ description: TOOLS[4].description, inputSchema: jsonSchema(TOOLS[4].schema), execute: execute('get_tickets_summary') }),
    create_ticket: tool({ description: TOOLS[5].description, inputSchema: jsonSchema(TOOLS[5].schema), execute: execute('create_ticket') }),
    update_ticket_status: tool({ description: TOOLS[6].description, inputSchema: jsonSchema(TOOLS[6].schema), execute: execute('update_ticket_status') })
  }
}
