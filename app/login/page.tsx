'use client'

import { useEffect, useState } from 'react'
import { Lock, UserRound, ArrowLeft, Loader2, Moon, Sun } from 'lucide-react'
import { SanadMark } from '@/components/sanad-mark'
import { browserSupabase } from '@/lib/supabase-browser'
import { useTheme } from '@/lib/theme'

const supabase = browserSupabase()

const fieldStyle = {
  width: '100%',
  background: 'var(--field)',
  border: '1px solid var(--field-border)',
  borderRadius: '12px',
  padding: '12px 14px',
  paddingInlineEnd: '44px',
  color: 'var(--text)',
  fontSize: '15px',
  outline: 'none'
} as const

export default function LoginPage() {
  const { dark, toggle } = useTheme()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [mustChange, setMustChange] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [pendingRole, setPendingRole] = useState('')
  const [checking, setChecking] = useState(true)

  const goToRole = (role: string) => {
    if (role === 'admin') window.location.href = '/'
    else if (role === 'technician' || role === 'manager') window.location.href = '/technician'
    else window.location.href = '/employee'
  }

  useEffect(() => {
    let alive = true
    supabase.auth.getSession().then(async ({ data }) => {
      const user = data.session?.user
      if (!user) { if (alive) setChecking(false); return }
      const { data: profile } = await supabase.from('profiles').select('role, is_approved, must_change_password').eq('id', user.id).maybeSingle()
      if (!alive) return
      if (profile && profile.is_approved !== false && !profile.must_change_password) {
        goToRole(profile.role)
        return
      }
      if (profile?.must_change_password) {
        setPendingRole(profile.role)
        setMustChange(true)
      } else {
        await supabase.auth.signOut()
      }
      setChecking(false)
    })
    return () => { alive = false }
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setErrorMsg('')

    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: identifier.trim(), password })
    })
    const result = await response.json().catch(() => ({ error: 'تعذر تسجيل الدخول.' }))
    if (!response.ok || !result.access_token || !result.refresh_token) {
      setErrorMsg(result.error || 'البريد الإلكتروني أو رقم الموظف أو كلمة المرور غير صحيحة.')
      setLoading(false)
      return
    }

    const signed = await supabase.auth.setSession({
      access_token: result.access_token,
      refresh_token: result.refresh_token
    })
    if (signed.error || !signed.data.user) {
      setErrorMsg('تعذر فتح الجلسة. حاول مرة أخرى.')
      setLoading(false)
      return
    }

    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('role, is_approved, must_change_password')
      .eq('id', signed.data.user.id)
      .single()

    if (profileError || !profileData) {
      await supabase.auth.signOut()
      setErrorMsg('لم يتم العثور على ملف تعريف لهذا المستخدم.')
      setLoading(false)
      return
    }

    if (profileData.is_approved === false) {
      await supabase.auth.signOut()
      setErrorMsg('حسابك بانتظار موافقة مسؤولي النظام.')
      setLoading(false)
      return
    }

    if (profileData.must_change_password) {
      setPendingRole(profileData.role)
      setMustChange(true)
      setLoading(false)
      return
    }

    goToRole(profileData.role)
  }

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setErrorMsg('')
    const session = await supabase.auth.getSession()
    const response = await fetch('/api/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.data.session?.access_token || ''}` },
      body: JSON.stringify({ userId: session.data.session?.user.id, password: newPassword })
    })
    const result = await response.json().catch(() => ({ error: 'تعذر تغيير كلمة المرور.' }))
    setLoading(false)
    if (!response.ok) { setErrorMsg(result.error || 'تعذر تغيير كلمة المرور.'); return }
    goToRole(pendingRole)
  }

  return (
    <main dir="rtl" style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'radial-gradient(circle at top, var(--surface) 0%, var(--bg) 55%, var(--bg) 100%)',
      color: 'var(--text)',
      padding: '1.5rem',
      position: 'relative'
    }}>
      <button type="button" onClick={toggle} aria-label="تبديل المظهر" style={{ position: 'absolute', top: '1.25rem', left: '1.25rem', width: 42, height: 42, borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
      <div style={{
        width: '100%',
        maxWidth: '440px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: '24px',
        padding: '2.5rem 2.25rem',
        boxShadow: 'var(--shadow)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', marginBottom: '2rem', color: 'var(--accent)' }}>
          <div style={{ textAlign: 'right' }}>
            <h1 style={{ fontSize: '34px', fontWeight: 800, margin: 0, lineHeight: 1, color: 'var(--text)' }}>سند</h1>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: '6px 0 0' }}>منصة الدعم الفني</p>
          </div>
          <SanadMark size={58} />
        </div>

        {errorMsg && (
          <div style={{
            background: 'var(--danger-bg)',
            border: '1px solid var(--danger-border)',
            color: 'var(--danger-text)',
            padding: '10px 14px',
            borderRadius: '12px',
            fontSize: '13px',
            marginBottom: '1.25rem',
            textAlign: 'center'
          }}>
            {errorMsg}
          </div>
        )}

        {checking ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem 0', color: '#7c3aed' }} aria-label="جاري التحقق">
            <Loader2 className="animate-spin" size={26} />
          </div>
        ) : mustChange ? (
          <form onSubmit={handlePasswordChange} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: 0, lineHeight: 1.6 }}>يجب تعيين كلمة مرور جديدة قبل الدخول.</p>
            <div>
              <label htmlFor="new-password" style={{ display: 'block', fontSize: '13px', fontWeight: 700, marginBottom: '6px', color: 'var(--text)' }}>كلمة المرور الجديدة</label>
              <input id="new-password" type="password" required minLength={6} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={fieldStyle} />
            </div>
            <button type="submit" disabled={loading} style={{ background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '12px', padding: '13px', fontSize: '15px', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer' }}>{loading ? 'جاري الحفظ...' : 'حفظ والدخول'}</button>
          </form>
        ) : (
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label htmlFor="login-identifier" style={{ display: 'block', fontSize: '13px', fontWeight: 700, marginBottom: '6px', color: 'var(--text)' }}>البريد أو رقم الموظف</label>
              <div dir="ltr" style={{ position: 'relative' }}>
                <UserRound size={18} style={{ position: 'absolute', left: '14px', top: '14px', color: '#94a3b8' }} />
                <input
                  id="login-identifier"
                  type="text"
                  required
                  dir="ltr"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="name@company.com / 445213615"
                  autoComplete="username"
                  style={{ ...fieldStyle, direction: 'ltr', textAlign: 'left', unicodeBidi: 'isolate', paddingInlineStart: '44px', paddingInlineEnd: '14px' }}
                />
              </div>
            </div>

            <div>
              <label htmlFor="login-password" style={{ display: 'block', fontSize: '13px', fontWeight: 700, marginBottom: '6px', color: 'var(--text)' }}>كلمة المرور</label>
              <div style={{ position: 'relative' }}>
                <Lock size={18} style={{ position: 'absolute', insetInlineEnd: '14px', top: '14px', color: '#94a3b8' }} />
                <input
                  id="login-password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="كلمة المرور"
                  autoComplete="current-password"
                  style={fieldStyle}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                background: '#7c3aed',
                color: '#fff',
                border: 'none',
                borderRadius: '12px',
                padding: '13px',
                fontSize: '15px',
                fontWeight: 700,
                cursor: loading ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                marginTop: '0.35rem'
              }}
            >
              {loading ? <Loader2 className="animate-spin" size={18} /> : <>دخول سند <ArrowLeft size={16} /></>}
            </button>
          </form>
        )}
      </div>
    </main>
  )
}
