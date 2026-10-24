import { createClient } from '@supabase/supabase-js'
import { normalizeDigits } from '@/lib/display'
import { LOCKED_ERROR, clearFailures, clientIp, recordFailure, tooManyAttempts } from '@/lib/server-auth'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const INVALID = 'البريد الإلكتروني أو رقم الموظف أو كلمة المرور غير صحيحة.'

export async function POST(request: Request) {
  if (!serviceRoleKey || !supabaseUrl || !supabaseAnonKey) {
    return Response.json({ error: 'إعداد الدخول غير مكتمل على الخادم.' }, { status: 500 })
  }

  const body = await request.json().catch(() => null) as { identifier?: string; password?: string } | null
  const identifier = (body?.identifier || '').trim()
  const password = body?.password || ''
  if (!identifier || !password) return Response.json({ error: INVALID }, { status: 401 })

  const ip = clientIp(request)
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })

  let email = identifier.toLowerCase()
  if (!identifier.includes('@')) {
    const employeeNumber = normalizeDigits(identifier).replace(/\D/g, '')
    if (!/^\d{9}$/.test(employeeNumber)) return Response.json({ error: INVALID }, { status: 401 })
    const { data } = await admin.from('profiles').select('email').eq('employee_number', employeeNumber).maybeSingle()
    if (!data?.email) {
      const key = `login:${employeeNumber}`
      if (await tooManyAttempts([key], ip)) return Response.json({ error: LOCKED_ERROR }, { status: 429 })
      await recordFailure([key], ip)
      return Response.json({ error: INVALID }, { status: 401 })
    }
    email = data.email.toLowerCase()
  }

  const key = `login:${email}`
  if (await tooManyAttempts([key], ip)) return Response.json({ error: LOCKED_ERROR }, { status: 429 })

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
  const signed = await client.auth.signInWithPassword({ email, password })
  if (signed.error || !signed.data.session || !signed.data.user) {
    await recordFailure([key], ip)
    return Response.json({ error: INVALID }, { status: 401 })
  }
  await clearFailures([key])

  const { data: profile } = await admin.from('profiles').select('is_approved').eq('id', signed.data.user.id).maybeSingle()
  if (!profile || profile.is_approved === false) {
    await client.auth.signOut()
    return Response.json({
      error: profile ? 'حسابك بانتظار موافقة مسؤولي النظام.' : 'لم يتم العثور على ملف تعريف لهذا المستخدم.'
    }, { status: 403 })
  }

  return Response.json({
    access_token: signed.data.session.access_token,
    refresh_token: signed.data.session.refresh_token
  })
}
