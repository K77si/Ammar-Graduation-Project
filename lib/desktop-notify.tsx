'use client'

import { useSyncExternalStore } from 'react'

type Permission = NotificationPermission | 'unsupported'

const listeners = new Set<() => void>()

function currentPermission(): Permission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  return Notification.permission
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useNotifyPermission() {
  const permission = useSyncExternalStore(subscribe, currentPermission, () => 'unsupported' as Permission)
  const request = async () => {
    if (currentPermission() !== 'default') return
    await Notification.requestPermission()
    listeners.forEach((listener) => listener())
  }
  return { permission, request }
}

export function notifyDesktop(title: string, body: string, tag: string) {
  if (currentPermission() !== 'granted') return
  try {
    const note = new Notification(title, { body, tag, lang: 'ar', dir: 'rtl' })
    note.onclick = () => {
      window.focus()
      note.close()
    }
  } catch {
    // Mobile browsers only allow notifications through a service worker.
  }
}

export function DesktopNotifyStatus({ permission, onEnable }: { permission: Permission; onEnable: () => void }) {
  if (permission === 'unsupported') return null
  if (permission === 'granted') return <p style={statusStyle}>تنبيهات سطح المكتب مفعّلة.</p>
  if (permission === 'denied') return <p style={statusStyle}>تنبيهات سطح المكتب محظورة من إعدادات المتصفح.</p>
  return (
    <button type="button" onClick={onEnable} style={{ width: '100%', background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '8px', padding: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', marginBottom: '8px' }}>
      تفعيل تنبيهات سطح المكتب
    </button>
  )
}

const statusStyle = { margin: '0 0 8px', fontSize: '11px', color: '#94a3b8' }
