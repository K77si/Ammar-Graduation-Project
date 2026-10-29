'use client'

import { useEffect, useState } from 'react'
import { browserSupabase } from '@/lib/supabase-browser'

const supabase = browserSupabase()

type TicketFile = { id: string; name: string; url: string }

export function TicketFiles({ ticketId, canUpload = false }: { ticketId: string; canUpload?: boolean }) {
  const [files, setFiles] = useState<TicketFile[]>([])
  const [note, setNote] = useState('جاري جلب المرفقات...')
  const [uploadNote, setUploadNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let stop = false
    async function load() {
      const session = await supabase.auth.getSession()
      const response = await fetch(`/api/tickets/attachments?ticketId=${encodeURIComponent(ticketId)}`, {
        headers: { Authorization: `Bearer ${session.data.session?.access_token || ''}` }
      })
      const result = await response.json().catch(() => ({ files: [] }))
      if (stop) return
      if (!response.ok) {
        setFiles([])
        setNote(result.error || 'تعذر جلب المرفقات.')
        return
      }
      const next = (result.files || []) as TicketFile[]
      setFiles(next)
      setNote(next.length ? '' : 'لا يوجد مرفق.')
    }
    load()
    return () => { stop = true }
  }, [ticketId, version])

  const upload = async (list: FileList | null) => {
    const picked = Array.from(list || []).slice(0, 3)
    if (!picked.length) return
    if (picked.some((file) => file.size > 5 * 1024 * 1024)) {
      setUploadNote('حجم المرفق يجب أن يكون أقل من 5 ميغابايت.')
      return
    }
    if (files.length + picked.length > 3) {
      setUploadNote('الحد الأقصى ثلاثة مرفقات لكل بلاغ.')
      return
    }
    setBusy(true)
    setUploadNote('')
    const session = await supabase.auth.getSession()
    const token = session.data.session?.access_token || ''
    let failed = ''
    for (const file of picked) {
      const body = new FormData()
      body.append('ticketId', ticketId)
      body.append('file', file)
      const uploaded = await fetch('/api/tickets/attachments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body
      })
      if (!uploaded.ok) {
        const result = await uploaded.json().catch(() => ({}))
        failed = result.error || 'تعذّر رفع المرفق.'
      }
    }
    setBusy(false)
    setUploadNote(failed || 'تم رفع المرفق.')
    setVersion((value) => value + 1)
  }

  return (
    <div style={{ marginBottom: '1rem' }}>
      <h4 style={{ fontSize: '14px', margin: '0 0 8px' }}>المرفقات</h4>
      {note && <p style={{ margin: 0, color: '#94a3b8', fontSize: '12px' }}>{note}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {files.map((file) => (
          file.url
            ? <a key={file.id} href={file.url} target="_blank" rel="noreferrer" style={{ color: '#7c3aed', fontSize: '13px', fontWeight: 700 }}>{file.name}</a>
            : <span key={file.id} style={{ color: 'var(--text)', fontSize: '13px', fontWeight: 700 }}>{file.name}</span>
        ))}
      </div>
      {canUpload && files.length < 3 && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', marginTop: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: 700 }}>
          <span style={{ border: '1px solid #c4b5fd', borderRadius: '8px', padding: '6px 10px' }}>{busy ? 'جاري الرفع...' : 'إرفاق ملف'}</span>
          <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '12px' }}>صورة أو PDF، أقل من 5 ميغابايت</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf"
            disabled={busy}
            onChange={(event) => {
              void upload(event.target.files)
              event.target.value = ''
            }}
            style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}
          />
        </label>
      )}
      {uploadNote && <p style={{ margin: '6px 0 0', fontSize: '12px', color: uploadNote.startsWith('تم') ? '#059669' : '#ef4444' }}>{uploadNote}</p>}
    </div>
  )
}
