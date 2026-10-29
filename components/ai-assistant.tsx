'use client'

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ArrowUp, Loader2, Plus } from 'lucide-react'
import { FAULT_TYPES, ticketAction } from '@/lib/workflow'
import { formatTicketNo } from '@/lib/display'

type Choice = { id: string; label: string }
type Confirm = { action: string; label: string; payload: Record<string, string> }
type Followup = { kind: 'reopen'; ticketId: string; label: string }
type Reply = {
  answer: string
  steps: string[]
  fault_type: string
  urgent: boolean
  needs_ticket: boolean
  kind?: 'stats' | 'help' | 'action'
  choices?: Choice[]
  confirm?: Confirm | null
  draft?: Record<string, string> | null
  followups?: Followup[]
}
type Status = { configured: boolean; enabled: boolean } | null
type Mode = 'employee' | 'technician' | 'admin'

export function AiAssistant({
  supabase,
  mode = 'employee',
  seed = '',
  compact = false,
  ticketId = '',
  onOpenTicket,
  onTicketsChanged
}: {
  supabase: SupabaseClient
  mode?: Mode
  seed?: string
  compact?: boolean
  ticketId?: string
  onOpenTicket?: (question: string, fault: string) => void
  onTicketsChanged?: () => void
}) {
  const [status, setStatus] = useState<Status>(null)
  const [question, setQuestion] = useState(seed)
  const [asked, setAsked] = useState('')
  const [reply, setReply] = useState<Reply | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [solved, setSolved] = useState(false)
  const [filing, setFiling] = useState(false)
  const [filedNo, setFiledNo] = useState('')
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const [image, setImage] = useState<{ mediaType: string; data: string; name: string } | null>(null)

  useEffect(() => {
    let alive = true
    const tokenFrom = async () => {
      const { data } = await supabase.auth.getSession()
      return data.session?.access_token || ''
    }
    const waitForToken = () => new Promise<string>((resolve) => {
      const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!session?.access_token) return
        sub.subscription.unsubscribe()
        resolve(session.access_token)
      })
      window.setTimeout(() => {
        sub.subscription.unsubscribe()
        resolve('')
      }, 2000)
    })
    const load = async (token: string) => {
      const response = await fetch('/api/assistant', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      const result = await response.json().catch(() => null) as { configured?: boolean; enabled?: boolean } | null
      return { response, result }
    }
    ;(async () => {
      let token = await tokenFrom()
      if (!token) token = await waitForToken()
      if (!alive) return
      let loaded = await load(token)
      if (loaded.response.status === 401) {
        const retryToken = (await tokenFrom()) || await waitForToken()
        if (retryToken) loaded = await load(retryToken)
      }
      if (!alive) return
      const result = loaded.result
      if (result && typeof result.configured === 'boolean') {
        setStatus({ configured: result.configured, enabled: result.enabled !== false })
        return
      }
      setStatus({ configured: true, enabled: true })
    })()
    return () => { alive = false }
  }, [supabase])

  const send = async (payload: { question?: string; choice?: string; confirm?: Confirm | null } = {}) => {
    const text = (payload.question ?? question).trim()
    if (loading) return
    if (!payload.choice && !payload.confirm && text.length < 5 && !image && !draft) return
    setLoading(true)
    setError('')
    setSolved(false)
    setFiledNo('')
    const { data } = await supabase.auth.getSession()
    const response = await fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` },
      body: JSON.stringify({
        question: text || 'تأكيد',
        audience: mode === 'technician' ? 'technician' : 'employee',
        choice: payload.choice,
        draft,
        confirm: payload.confirm || null,
        ticketId,
        image: image ? { mediaType: image.mediaType, data: image.data } : null
      })
    })
    const result = await response.json().catch(() => ({ error: 'تعذّر الوصول إلى المساعد الذكي.' }))
    setLoading(false)
    if (!response.ok) { setError(result.error || 'تعذّر الوصول إلى المساعد الذكي.'); return }
    setAsked(text)
    setQuestion('')
    setImage(null)
    setDraft(result.draft || null)
    setReply(result)
    if (payload.confirm) onTicketsChanged?.()
  }

  const ask = (event: React.FormEvent) => {
    event.preventDefault()
    void send()
  }

  const raiseTicket = async () => {
    if (!reply || filing || filedNo) return
    setFiling(true)
    setError('')
    const { data: session } = await supabase.auth.getSession()
    const userId = session.session?.user.id
    if (!userId) {
      setFiling(false)
      setError('يلزم تسجيل الدخول لرفع البلاغ.')
      return
    }
    const fault = (FAULT_TYPES as readonly string[]).includes(reply.fault_type) ? reply.fault_type : 'أخرى'
    const { data, error: insertError } = await supabase.from('tickets').insert([{
      title: asked.trim(),
      status: 'مفتوحة',
      ai_resolved: false,
      user_id: userId,
      priority: reply.urgent ? 'عاجل' : 'عادي',
      priority_reason: reply.urgent ? 'العمل متوقف حسب وصف الموظف.' : '',
      fault_type: fault,
      site_place: '',
      device_number: '',
      is_private: false,
      is_outage: false
    }]).select('id, ticket_number')
    setFiling(false)
    if (insertError || !data?.[0]) {
      const raw = insertError?.message || ''
      setError(/[\u0600-\u06FF]/.test(raw) ? raw : 'تعذّر رفع البلاغ. أعد المحاولة.')
      return
    }
    setFiledNo(formatTicketNo(data[0].ticket_number))
    const sessionToken = session.session?.access_token || ''
    if (data[0].id) {
      await fetch('/api/tickets/opened', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ ticketId: data[0].id })
      })
    }
    onTicketsChanged?.()
  }

  if (!status) return null
  if (status.configured && !status.enabled && mode !== 'admin') return null
  const ready = status.enabled || mode === 'admin'
  const helpReply = reply?.kind === 'help'
  const canSend = question.trim().length >= 5 || Boolean(image) || Boolean(draft)

  const placeholder = compact ? 'اسأل عن هذا البلاغ' : 'اسأل سند'

  return (
    <section className={`ai-gemini ${compact ? 'ai-gemini-compact' : ''}`}>
      <form onSubmit={ask} className="ai-gemini-bar">
        <label className="ai-gemini-plus" aria-label="إرفاق صورة">
          <Plus size={18} />
          <input
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file || file.size > 1_200_000) { setError(file ? 'الصورة أكبر من 1.2 ميغابايت.' : ''); return }
              const reader = new FileReader()
              reader.onload = () => {
                const value = String(reader.result || '')
                const data = value.slice(value.indexOf(',') + 1)
                setImage({ mediaType: file.type, data, name: file.name })
              }
              reader.readAsDataURL(file)
            }}
          />
        </label>
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          disabled={!ready}
          placeholder={placeholder}
          maxLength={600}
        />
        <button type="submit" className="ai-gemini-send" disabled={!ready || loading || !canSend} aria-label="اسأل">
          {loading ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={18} />}
        </button>
      </form>

      {image && <p className="ai-gemini-meta">مرفقة: {image.name}</p>}
      {status.configured === false && <p className="ai-gemini-meta">اقتراح الحل يحتاج مفتاح المساعد على الخادم. أسئلة التذاكر تعمل الآن.</p>}
      {mode === 'admin' && status.configured && !status.enabled && <p className="ai-gemini-meta">المساعد متوقف من الإعدادات.</p>}
      {error && <p className="ai-box-error">{error}</p>}

      {reply && (
        <div className="ai-box-reply">
          <p>{reply.answer}</p>
          {reply.steps.length > 0 && (
            <ol>
              {reply.steps.map((step, index) => <li key={index}>{step}</li>)}
            </ol>
          )}
          {(reply.choices?.length || reply.confirm || reply.followups?.length) ? (
            <div className="ai-box-actions">
              {reply.choices?.map((choice) => (
                <button key={choice.id} type="button" className="ai-ghost" disabled={loading} onClick={() => void send({ question: choice.label, choice: choice.id })}>{choice.label}</button>
              ))}
              {reply.confirm && (
                <button type="button" className="ai-primary" disabled={loading} onClick={() => void send({ question: 'تأكيد', confirm: reply.confirm })}>{reply.confirm.label}</button>
              )}
              {reply.followups?.map((item) => (
                <button key={item.ticketId} type="button" className="ai-primary" disabled={loading} onClick={async () => {
                  const result = await ticketAction(supabase, item.ticketId, 'reopen', { reason: 'عادت المشكلة', via: 'sanad' })
                  if (result.error) setError(result.error)
                  else { setReply({ ...reply, answer: `${reply.answer}\nتمت إعادة فتح البلاغ.` , followups: [] }); onTicketsChanged?.() }
                }}>{item.label}</button>
              ))}
            </div>
          ) : null}
          {mode === 'employee' && helpReply && (filedNo ? (
            <p className="ai-box-done">تم رفع البلاغ {filedNo} وإحالته إلى الدعم التقني.</p>
          ) : solved ? (
            <p className="ai-box-done">ممتاز، يسعدنا أن المشكلة حُلّت.</p>
          ) : (
            <div className="ai-box-actions">
              <button type="button" className="ai-ghost" onClick={() => { setSolved(true); setQuestion('') }}>حُلّت المشكلة</button>
              <button type="button" className="ai-primary" disabled={filing} onClick={raiseTicket}>
                {filing ? 'جارٍ الرفع...' : 'ارفع البلاغ للدعم'}
              </button>
              {onOpenTicket && (
                <button type="button" className="ai-ghost" onClick={() => onOpenTicket(asked, reply.fault_type)}>أضف تفاصيل قبل الرفع</button>
              )}
            </div>
          ))}
          {mode === 'employee' && helpReply && reply.urgent && !solved && !filedNo && <p className="ai-box-note">يبدو أن العمل متوقف، وسيُرفع البلاغ بدرجة عاجل.</p>}
          {mode === 'technician' && helpReply && reply.needs_ticket && <p className="ai-box-note">قد يحتاج تصعيداً.</p>}
        </div>
      )}
    </section>
  )
}
