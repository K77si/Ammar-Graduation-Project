'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '')

export function TicketFiles({ ticketId }: { ticketId: string }) {
  const [files, setFiles] = useState<Array<{ id: string; name: string; url: string }>>([])
  const [note, setNote] = useState('جاري جلب المرفقات...')

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
      const next = (result.files || []).filter((file: { url?: string }) => file.url)
      setFiles(next)
      setNote(next.length ? '' : 'لا يوجد مرفق.')
    }
    load()
    return () => { stop = true }
  }, [ticketId])

  return (
    <div style={{ marginBottom: '1rem' }}>
      <h4 style={{ fontSize: '14px', margin: '0 0 8px' }}>المرفقات</h4>
      {note && <p style={{ margin: 0, color: '#94a3b8', fontSize: '12px' }}>{note}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {files.map((file) => (
          <a key={file.id} href={file.url} target="_blank" rel="noreferrer" style={{ color: '#7c3aed', fontSize: '13px', fontWeight: 700 }}>{file.name}</a>
        ))}
      </div>
    </div>
  )
}
