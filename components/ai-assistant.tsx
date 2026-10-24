'use client'

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Bot, Loader2, Send } from 'lucide-react'

type Reply = { answer: string; steps: string[]; fault_type: string; urgent: boolean; needs_ticket: boolean }
type Status = { configured: boolean; enabled: boolean } | null
type Mode = 'employee' | 'technician' | 'admin'

const SUBTITLE: Record<Mode, string> = {
  employee: 'اكتب مشكلتك واحصل على حل.',
  technician: 'خطوات تشخيص وإصلاح.',
  admin: 'تجربة المساعد.'
}

export function AiAssistant({
  supabase,
  mode = 'employee',
  seed = '',
  compact = false,
  onOpenTicket
}: {
  supabase: SupabaseClient
  mode?: Mode
  seed?: string
  compact?: boolean
  onOpenTicket?: (question: string, fault: string) => void
}) {
  const [status, setStatus] = useState<Status>(null)
  const [question, setQuestion] = useState(seed)
  const [asked, setAsked] = useState('')
  const [reply, setReply] = useState<Reply | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [solved, setSolved] = useState(false)

  useEffect(() => {
    let alive = true
    supabase.auth.getSession().then(async ({ data }) => {
      const response = await fetch('/api/assistant', { headers: { Authorization: `Bearer ${data.session?.access_token || ''}` } })
      const result = await response.json().catch(() => null)
      if (alive) setStatus(response.ok && result ? result : { configured: false, enabled: false })
    })
    return () => { alive = false }
  }, [supabase])

  const ask = async (event: React.FormEvent) => {
    event.preventDefault()
    const text = question.trim()
    if (text.length < 5 || loading) return
    setLoading(true)
    setError('')
    setReply(null)
    setSolved(false)
    const { data } = await supabase.auth.getSession()
    const response = await fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` },
      body: JSON.stringify({ question: text, audience: mode === 'technician' ? 'technician' : 'employee' })
    })
    const result = await response.json().catch(() => ({ error: 'تعذّر الوصول إلى المساعد الذكي.' }))
    setLoading(false)
    if (!response.ok) { setError(result.error || 'تعذّر الوصول إلى المساعد الذكي.'); return }
    setAsked(text)
    setReply(result)
  }

  if (!status) return null
  if (status.configured && !status.enabled && mode !== 'admin') return null
  const ready = status.configured && status.enabled

  if (!status.configured && mode !== 'admin') {
    return (
      <section className={`ai-box ai-box-slim ${compact ? 'ai-box-compact' : ''}`}>
        <div className="ai-box-head">
          <span className="ai-box-icon"><Bot size={16} /></span>
          <strong>المساعد الذكي</strong>
          <small>غير مفعّل بعد.</small>
        </div>
      </section>
    )
  }

  return (
    <section className={`ai-box ${compact ? 'ai-box-compact' : ''}`}>
      <div className="ai-box-head">
        <span className="ai-box-icon"><Bot size={18} /></span>
        <div>
          <strong>{mode === 'technician' && compact ? 'اقتراح حل بالمساعد الذكي' : 'المساعد الذكي'}</strong>
          <small>{SUBTITLE[mode]}</small>
        </div>
      </div>

      {!status.configured && <p className="ai-box-note">غير مفعّل: أضف ANTHROPIC_API_KEY على الخادم.</p>}
      {mode === 'admin' && status.configured && !status.enabled && (
        <p className="ai-box-note">متوقف من الإعدادات.</p>
      )}

      <form onSubmit={ask} className="ai-box-form">
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          disabled={!ready}
          placeholder={mode === 'technician' ? 'مثال: الطابعة لا تستقبل أوامر الطباعة' : 'مثال: الطابعة تطبع صفحات فارغة'}
          maxLength={600}
        />
        <button type="submit" disabled={!ready || loading || question.trim().length < 5} aria-label="اسأل المساعد">
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} style={{ transform: 'rotate(180deg)' }} />}
          <span>{loading ? 'جاري التفكير...' : 'اسأل'}</span>
        </button>
      </form>

      {error && <p className="ai-box-error">{error}</p>}

      {reply && (
        <div className="ai-box-reply">
          <p>{reply.answer}</p>
          {reply.steps.length > 0 && (
            <ol>
              {reply.steps.map((step, index) => <li key={index}>{step}</li>)}
            </ol>
          )}
          {mode === 'employee' && (solved ? (
            <p className="ai-box-done">ممتاز، يسعدنا أن المشكلة حُلّت.</p>
          ) : (
            <div className="ai-box-actions">
              <button type="button" className="ai-ghost" onClick={() => { setSolved(true); setQuestion('') }}>حُلّت المشكلة</button>
              <button type="button" className="ai-primary" onClick={() => onOpenTicket?.(asked, reply.fault_type)}>
                {reply.needs_ticket ? 'افتح بلاغاً بهذه المشكلة' : 'لم تُحل، افتح بلاغاً'}
              </button>
            </div>
          ))}
          {mode === 'employee' && reply.urgent && !solved && <p className="ai-box-note">يبدو أن العمل متوقف؛ اختر «عاجل» عند فتح البلاغ.</p>}
          {mode === 'technician' && reply.needs_ticket && <p className="ai-box-note">قد يحتاج تصعيداً.</p>}
        </div>
      )}
    </section>
  )
}
