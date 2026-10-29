import { DEPARTMENTS, TECH_DEPARTMENT, departmentLabel, normalizeDigits, passwordError, storedDepartment } from '@/lib/display'
import { ADMIN_PERMISSIONS, normalizeAdminPermissions } from '@/lib/admin-access'
import { writeAudit } from '@/lib/audit'
import { canManage, getActor, isOwner, serviceClient, verifyOwner } from '@/lib/server-auth'

const ROLES = new Set(['admin', 'user', 'manager', 'technician', 'department_head'])

export async function POST(request: Request) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return Response.json({ error: 'مفتاح الخدمة غير مضبوط على الخادم.' }, { status: 500 })
  const actor = await getActor(request)
  if (!actor || !canManage(actor, 'users')) return Response.json({ error: 'هذا الإجراء متاح لمدير يملك صلاحية المستخدمين.' }, { status: 403 })

  const body = await request.json().catch(() => null) as {
    fullName?: string
    email?: string
    username?: string
    employeeNumber?: string
    department?: string
    role?: string
    password?: string
    ownerUsername?: string
    ownerPassword?: string
    permissions?: string[]
  } | null
  const fullName = body?.fullName?.trim() || ''
  const email = body?.email?.trim().toLowerCase() || ''
  const username = body?.username?.trim().toLowerCase() || ''
  const employeeNumber = normalizeDigits(body?.employeeNumber || '').replace(/\D/g, '')
  const requestedDepartment = body?.department?.trim() || ''
  const role = (body?.role === 'manager' ? 'technician' : body?.role) || 'user'
  const password = body?.password || ''
  const departmentResult = storedDepartment(role, requestedDepartment)
  if ('error' in departmentResult) return Response.json({ error: departmentResult.error }, { status: 400 })
  const department = departmentResult.department
  if (!fullName || !email || !username || !department || !password || !employeeNumber) {
    return Response.json({ error: 'أكمل جميع البيانات المطلوبة.' }, { status: 400 })
  }
  if (!/^\d{9}$/.test(employeeNumber)) {
    return Response.json({ error: 'رقم الموظف يجب أن يكون 9 أرقام.' }, { status: 400 })
  }
  if (!ROLES.has(role)) return Response.json({ error: 'الصلاحية غير مسموحة.' }, { status: 400 })

  let adminPermissions: string[] | null = null
  if (role === 'admin') {
    const owner = await verifyOwner(body?.ownerUsername || '', body?.ownerPassword || '')
    if (!owner.ok) return Response.json({ error: owner.error }, { status: 401 })
    adminPermissions = normalizeAdminPermissions(body?.permissions)
    if (!adminPermissions || adminPermissions.length === 0) {
      return Response.json({ error: 'اختر صلاحية واحدة على الأقل لمدير النظام.' }, { status: 400 })
    }
  }

  const admin = serviceClient()
  const [{ data: sameEmail }, { data: sameUsername }, { data: sameNumber }] = await Promise.all([
    admin.from('profiles').select('id').ilike('email', email).maybeSingle(),
    admin.from('profiles').select('id').ilike('username', username).maybeSingle(),
    admin.from('profiles').select('id').eq('employee_number', employeeNumber).maybeSingle()
  ])
  if (sameEmail || sameUsername) return Response.json({ error: 'هذا البريد أو اسم المستخدم مستخدم لحساب آخر.' }, { status: 400 })
  if (sameNumber) return Response.json({ error: 'رقم الموظف مستخدم لحساب آخر.' }, { status: 400 })
  const { data: settings } = await admin.from('system_settings').select('strict_auth, force_password_change, departments').eq('id', 'main_settings').maybeSingle()
  const weakPassword = passwordError(password, settings?.strict_auth === true)
  if (weakPassword) return Response.json({ error: weakPassword }, { status: 400 })
  const knownDepartments = Array.isArray(settings?.departments) && settings.departments.length > 0
    ? (settings.departments as string[]).map((item) => departmentLabel(item))
    : DEPARTMENTS
  if (!knownDepartments.includes(departmentLabel(department)) && department !== TECH_DEPARTMENT) {
    return Response.json({ error: 'القسم غير موجود في إعدادات الأقسام.' }, { status: 400 })
  }
  const approved = role === 'admin' || canManage(actor, 'approvals')
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName }
  })
  if (created.error || !created.data.user) {
    const raw = created.error?.message || ''
    const message = /already|registered|exists/i.test(raw) ? 'هذا البريد مستخدم لحساب آخر.' : (raw || 'تعذر إنشاء حساب الدخول.')
    return Response.json({ error: message }, { status: 400 })
  }

  const saved = await admin.from('profiles').upsert({
    id: created.data.user.id,
    full_name: fullName,
    email,
    username,
    department,
    role,
    is_approved: approved,
    password: null,
    temp_password: null,
    employee_number: employeeNumber,
    must_change_password: settings?.force_password_change !== false,
    admin_permissions: adminPermissions
  })
  if (saved.error) {
    await admin.auth.admin.deleteUser(created.data.user.id)
    const message = saved.error.message.includes('employee_number')
      ? 'رقم الموظف مستخدم لحساب آخر.'
      : saved.error.message.toLowerCase().includes('email')
        ? 'هذا البريد مستخدم لحساب آخر.'
        : saved.error.message
    return Response.json({ error: message }, { status: 400 })
  }
  const permissionText = adminPermissions
    ? ADMIN_PERMISSIONS.filter((item) => adminPermissions?.includes(item.key)).map((item) => item.label).join('، ')
    : ''
  const auditWarning = await writeAudit(
    actor.id,
    role === 'admin' ? 'إنشاء مدير نظام' : 'إنشاء حساب',
    fullName,
    role === 'admin' ? `الصلاحيات: ${permissionText}` : role,
    { source: 'يدوي', targetId: created.data.user.id }
  )
  return Response.json({ id: created.data.user.id, employeeNumber, approved, auditWarning })
}

export async function PATCH(request: Request) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return Response.json({ error: 'مفتاح الخدمة غير مضبوط على الخادم.' }, { status: 500 })
  const actor = await getActor(request)
  if (!actor) return Response.json({ error: 'يلزم تسجيل الدخول.' }, { status: 401 })

  const body = await request.json().catch(() => null) as {
    userId?: string
    password?: string
    fullName?: string
    department?: string
    role?: string
    ownerUsername?: string
    ownerPassword?: string
    permissions?: string[]
  } | null
  const userId = body?.userId || ''
  const password = body?.password || ''
  if (!userId) return Response.json({ error: 'المستخدم غير محدد.' }, { status: 400 })

  const admin = serviceClient()
  let normalizedDepartment = ''
  if (body?.role || body?.department) {
    const { data: current } = await admin.from('profiles').select('role, department').eq('id', userId).maybeSingle()
    const nextRole = (body.role === 'manager' ? 'technician' : body.role) || current?.role || 'user'
    const nextDepartment = (body.department ?? current?.department ?? '').trim()
    const checked = storedDepartment(nextRole, nextDepartment)
    if ('error' in checked) return Response.json({ error: checked.error }, { status: 400 })
    normalizedDepartment = checked.department
  }
  let promoted = false
  if (body?.role === 'admin') {
    const { data: target } = await admin.from('profiles').select('role').eq('id', userId).maybeSingle()
    if (!target) return Response.json({ error: 'المستخدم غير موجود.' }, { status: 404 })
    if (target.role !== 'admin') {
      if (!canManage(actor, 'users')) return Response.json({ error: 'ليست لديك صلاحية المستخدمين.' }, { status: 403 })
      const owner = await verifyOwner(body.ownerUsername || '', body.ownerPassword || '')
      if (!owner.ok) return Response.json({ error: owner.error }, { status: 401 })
      const permissions = normalizeAdminPermissions(body.permissions)
      if (!permissions || permissions.length === 0) {
        return Response.json({ error: 'اختر صلاحية واحدة على الأقل لمدير النظام.' }, { status: 400 })
      }
      const update: { full_name?: string; department?: string; role: string; admin_permissions: string[] } = {
        role: 'admin',
        admin_permissions: permissions
      }
      if (body.fullName?.trim()) update.full_name = body.fullName.trim()
      if (normalizedDepartment) update.department = normalizedDepartment
      const saved = await admin.from('profiles').update(update).eq('id', userId)
      if (saved.error) return Response.json({ error: saved.error.message }, { status: 400 })
      const permissionText = ADMIN_PERMISSIONS.filter((item) => permissions.includes(item.key)).map((item) => item.label).join('، ')
      const auditWarning = await writeAudit(actor.id, 'إنشاء مدير نظام', body.fullName?.trim() || 'مدير نظام', `الصلاحيات: ${permissionText}`, { source: 'يدوي', targetId: userId })
      promoted = true
      if (!password) return Response.json({ ok: true, auditWarning })
    }
  }

  if (!password) {
    if (promoted) return Response.json({ ok: true })
    return Response.json({ error: 'كلمة المرور غير مقبولة.' }, { status: 400 })
  }

  const { data: settings } = await admin.from('system_settings').select('strict_auth').eq('id', 'main_settings').maybeSingle()
  const weakPassword = passwordError(password, settings?.strict_auth === true)
  if (weakPassword) return Response.json({ error: weakPassword }, { status: 400 })

  const ownPassword = actor.id === userId
  if (!ownPassword && !canManage(actor, 'reset_password')) {
    return Response.json({ error: 'لا تملك صلاحية تغيير كلمة المرور.' }, { status: 403 })
  }
  if (!ownPassword) {
    const { data: target } = await admin.from('profiles').select('full_name, role, is_owner').eq('id', userId).maybeSingle()
    if (isOwner(target)) {
      return Response.json({ error: 'لا يمكن تغيير كلمة مرور المالك من حساب آخر.' }, { status: 403 })
    }
  }

  const updated = await admin.auth.admin.updateUserById(userId, { password })
  if (updated.error) return Response.json({ error: updated.error.message }, { status: 400 })

  const { error } = await admin.from('profiles').update({
    password: null,
    temp_password: null,
    must_change_password: ownPassword ? false : true
  }).eq('id', userId)
  if (error) return Response.json({ error: error.message }, { status: 400 })
  const { data: target } = await admin.from('profiles').select('full_name').eq('id', userId).maybeSingle()
  const auditWarning = await writeAudit(
    actor.id,
    ownPassword ? 'تغيير كلمة المرور' : 'إعادة تعيين كلمة المرور',
    target?.full_name || 'مستخدم',
    '',
    { source: 'يدوي', targetId: userId }
  )
  return Response.json({ ok: true, auditWarning })
}

export async function DELETE(request: Request) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return Response.json({ error: 'مفتاح الخدمة غير مضبوط على الخادم.' }, { status: 500 })
  const actor = await getActor(request)
  if (!actor || !canManage(actor, 'delete_users')) return Response.json({ error: 'ليست لديك صلاحية حذف الحسابات.' }, { status: 403 })

  const body = await request.json().catch(() => null) as { userId?: string } | null
  const userId = body?.userId || ''
  if (!userId) return Response.json({ error: 'المستخدم غير محدد.' }, { status: 400 })
  if (userId === actor.id) return Response.json({ error: 'لا يمكن حذف حسابك الحالي.' }, { status: 400 })

  const admin = serviceClient()
  const { data: target } = await admin.from('profiles').select('full_name, role, is_owner').eq('id', userId).maybeSingle()
  if (isOwner(target)) {
    return Response.json({ error: 'لا يمكن حذف حساب المالك.' }, { status: 400 })
  }
  const removed = await admin.auth.admin.deleteUser(userId)
  if (removed.error && !/not found/i.test(removed.error.message)) {
    return Response.json({ error: 'تعذّر حذف حساب الدخول، ولا يزال الحساب موجوداً.' }, { status: 400 })
  }
  const { error } = await admin.from('profiles').delete().eq('id', userId)
  if (error) return Response.json({ error: 'حُذف حساب الدخول وتعذّر حذف ملف المستخدم. أعد المحاولة.' }, { status: 400 })
  const auditWarning = await writeAudit(actor.id, 'حذف حساب', target?.full_name || 'مستخدم', target?.role || '', { source: 'يدوي', targetId: userId })
  return Response.json({ ok: true, auditWarning })
}
