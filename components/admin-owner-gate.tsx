'use client'

import { ADMIN_PERMISSIONS } from '@/lib/admin-access'
import { X } from 'lucide-react'

export function AdminOwnerGate({
  dark,
  title,
  username,
  password,
  verified,
  checking,
  saving,
  error,
  permissions,
  submitLabel,
  onUsername,
  onPassword,
  onVerify,
  onToggle,
  onAll,
  onSubmit,
  onBack,
  onClose
}: {
  dark: boolean
  title: string
  username: string
  password: string
  verified: boolean
  checking: boolean
  saving: boolean
  error: string
  permissions: string[]
  submitLabel: string
  onUsername: (value: string) => void
  onPassword: (value: string) => void
  onVerify: () => void
  onToggle: (key: string) => void
  onAll: () => void
  onSubmit: () => void
  onBack: () => void
  onClose: () => void
}) {
  const field = {
    width: '100%',
    background: dark ? '#1a1d2d' : '#f8fafc',
    border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`,
    borderRadius: '8px',
    padding: '10px',
    color: dark ? '#fff' : '#0f172a',
    outline: 'none'
  }
  return (
    <>
      <div className="modal-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h3 style={{ fontSize: '18px', fontWeight: 'bold', margin: 0 }}>{title}</h3>
        <button type="button" onClick={onClose} aria-label="إغلاق" title="إغلاق" style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' }}><X size={20} /></button>
      </div>
      <p style={{ color: '#64748b', fontSize: '13px', lineHeight: 1.7, margin: '0 0 1rem' }}>
        إضافة مدير نظام تتطلب تحقق عمار.
      </p>
      {error && <div style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '10px', borderRadius: '8px', fontSize: '13px', marginBottom: '1rem', textAlign: 'center' }}>{error}</div>}
      {!verified ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label htmlFor="owner-username" style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>البريد أو اسم المستخدم</label>
            <input id="owner-username" value={username} onChange={(event) => onUsername(event.target.value)} autoComplete="username" dir="ltr" placeholder="name@company.com أو ammar" style={field} />
          </div>
          <div>
            <label htmlFor="owner-password" style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>كلمة المرور</label>
            <input id="owner-password" type="password" value={password} onChange={(event) => onPassword(event.target.value)} autoComplete="current-password" dir="ltr" style={field} />
          </div>
          <button type="button" onClick={onVerify} disabled={checking || !username.trim() || !password} style={{ background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '8px', padding: '10px', cursor: 'pointer', opacity: checking || !username.trim() || !password ? 0.7 : 1 }}>{checking ? 'جاري التحقق...' : 'تحقق'}</button>
          <button type="button" onClick={onBack} style={{ background: 'transparent', color: '#64748b', border: 'none', cursor: 'pointer', fontSize: '13px' }}>رجوع</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ background: 'rgba(16, 185, 129, 0.12)', color: '#047857', borderRadius: '8px', padding: '10px 12px', fontSize: '13px' }}>تم التحقق. اختر الصلاحيات.</div>
          <button type="button" onClick={onAll} style={{ alignSelf: 'flex-start', background: 'transparent', border: 'none', color: '#7c3aed', cursor: 'pointer', fontSize: '13px', fontWeight: 700 }}>تفعيل كل الصلاحيات</button>
          {ADMIN_PERMISSIONS.map((item) => {
            const checked = permissions.includes(item.key)
            return (
              <label key={item.key} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '10px 12px', borderRadius: '10px', border: `1px solid ${checked ? '#c4b5fd' : (dark ? '#2a2e43' : '#e2e8f0')}`, background: checked ? 'rgba(139, 92, 246, 0.08)' : 'transparent', cursor: 'pointer' }}>
                <input type="checkbox" checked={checked} onChange={() => onToggle(item.key)} style={{ marginTop: '3px' }} />
                <span>
                  <b style={{ display: 'block', fontSize: '14px' }}>{item.label}</b>
                  <small style={{ color: '#64748b', fontSize: '12px' }}>{item.detail}</small>
                </span>
              </label>
            )
          })}
          <button type="button" onClick={onSubmit} disabled={saving || permissions.length === 0} style={{ background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '8px', padding: '10px', cursor: 'pointer', opacity: saving || permissions.length === 0 ? 0.7 : 1 }}>{submitLabel}</button>
          <button type="button" onClick={onBack} style={{ background: 'transparent', color: '#64748b', border: 'none', cursor: 'pointer', fontSize: '13px' }}>رجوع</button>
        </div>
      )}
    </>
  )
}
