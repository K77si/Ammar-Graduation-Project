import { createClient } from '@supabase/supabase-js'
import { hasAdminPermission, normalizeAdminPermissions } from '@/lib/admin-access'
import { normalizeDigits } from '@/lib/display'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const OWNER_ERROR = 'البريد أو اسم المستخدم أو كلمة المرور غير صحيحة.'

export type Actor = {
  id: string
  role: string
  permissions: string[] | null
}

export function serviceClient() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
}

export async function getActor(request: Request): Promise<Actor | null> {
  const header = request.headers.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token || !supabaseUrl || !supabaseAnonKey) return null
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false }
  })
  const { data } = await client.auth.getUser(token)
  if (!data.user) return null
  const { data: profile } = await client.from('profiles').select('role, admin_permissions').eq('id', data.user.id).maybeSingle()
  return {
    id: data.user.id,
    role: (profile?.role as string) || 'user',
    permissions: normalizeAdminPermissions(profile?.admin_permissions)
  }
}

export function canManage(actor: Actor, key: string) {
  return actor.role === 'admin' && hasAdminPermission(actor.permissions, key)
}

export function isOwner(profile?: { role?: string | null; is_owner?: boolean | null } | null) {
  return profile?.role === 'admin' && profile.is_owner === true
}

export async function verifyOwner(identifier: string, password: string) {
  const clean = identifier.trim()
  if (!clean || !password || !serviceRoleKey || !supabaseUrl || !supabaseAnonKey) {
    return { ok: false as const, error: OWNER_ERROR }
  }
  if (await tooManyAttempts(['owner'])) return { ok: false as const, error: LOCKED_ERROR }
  const admin = serviceClient()
  const lookup = admin.from('profiles').select('id, email, role, is_owner')
  const employeeNumber = normalizeDigits(clean).replace(/\D/g, '')
  const { data } = clean.includes('@')
    ? await lookup.ilike('email', clean).maybeSingle()
    : /^\d{9}$/.test(employeeNumber)
      ? await lookup.eq('employee_number', employeeNumber).maybeSingle()
      : await lookup.ilike('username', clean).maybeSingle()
  if (!data?.email || !isOwner(data)) {
    await recordFailure(['owner'])
    return { ok: false as const, error: OWNER_ERROR }
  }
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
  const signed = await client.auth.signInWithPassword({ email: data.email, password })
  if (signed.error || signed.data.user?.id !== data.id) {
    await recordFailure(['owner'])
    return { ok: false as const, error: OWNER_ERROR }
  }
  // Local only. A global sign-out revokes every session for this owner, including the admin tab that just verified, so the following role save is rejected.
  await client.auth.signOut({ scope: 'local' })
  await clearFailures(['owner'])
  return { ok: true as const }
}

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES_PER_KEY = 5
const MAX_FAILURES_PER_IP = 30

export const LOCKED_ERROR = 'محاولات دخول خاطئة كثيرة. حاول مرة أخرى بعد 15 دقيقة.'

export function clientIp(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || ''
  return forwarded.split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown'
}

export async function tooManyAttempts(keys: string[], ip?: string) {
  const admin = serviceClient()
  const since = new Date(Date.now() - ATTEMPT_WINDOW_MS).toISOString()
  const checks = keys.map((key) => admin.from('login_attempts').select('id', { count: 'exact', head: true }).eq('key', key).gte('created_at', since))
  if (ip) checks.push(admin.from('login_attempts').select('id', { count: 'exact', head: true }).eq('key', `ip:${ip}`).gte('created_at', since))
  const counts = await Promise.all(checks)
  return counts.some((result, index) => (result.count || 0) >= (ip && index === counts.length - 1 ? MAX_FAILURES_PER_IP : MAX_FAILURES_PER_KEY))
}

export async function recordFailure(keys: string[], ip?: string) {
  const admin = serviceClient()
  const rows = keys.map((key) => ({ key }))
  if (ip) rows.push({ key: `ip:${ip}` })
  await admin.from('login_attempts').insert(rows)
  await admin.from('login_attempts').delete().lt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
}

export async function clearFailures(keys: string[]) {
  await serviceClient().from('login_attempts').delete().in('key', keys)
}
