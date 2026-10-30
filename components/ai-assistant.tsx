'use client'

import { useEffect, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ArrowUp, Loader2, Plus } from 'lucide-react'
import { FAULT_TYPES, ticketAction } from '@/lib/workflow'
import { formatTicketNo } from '@/lib/display'
import { SanadMark } from '@/components/sanad-mark'

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
type Status = { configured: boolean; enabled: boolean; signedIn: boolean } | null
type Mode = 'employee' | 'technician' | 'admin'
type Persona = 'user' | 'department_head' | 'technician' | 'admin'

type Chip = { label: string; question: string; group: string; need?: string }
type Turn = { q: string; a: string }

function threadKey(userId: string, mode: string) {
  return `sanad-thread:${userId}:${mode}`
}

const MENUS: Record<Persona, Chip[]> = {
  admin: [
    { group: 'حسابات', need: 'users', label: 'إنشاء حساب', question: 'إنشاء حساب' },
    { group: 'حسابات', need: 'reset_password', label: 'تغيير كلمة المرور', question: 'تغيير كلمة المرور' },
    { group: 'حسابات', need: 'approvals', label: 'بانتظار الاعتماد', question: 'حسابات بانتظار الاعتماد' },
    { group: 'حسابات', need: 'approvals', label: 'تعطيل حساب', question: 'تعطيل حساب' },
    { group: 'حسابات', need: 'delete_users', label: 'حذف حساب', question: 'حذف حساب' },
    { group: 'حسابات', need: 'users', label: 'نقل لقسم', question: 'انقل حساب' },
    { group: 'حسابات', need: 'users', label: 'تغيير الدور', question: 'غيّر دور' },
    { group: 'حسابات', need: 'settings', label: 'إضافة قسم', question: 'أضف قسم' },
    { group: 'بلاغات', need: 'tickets', label: 'تقرير اليوم', question: 'تقرير اليوم' },
    { group: 'بلاغات', need: 'tickets', label: 'البلاغات المفتوحة', question: 'كم بلاغ مفتوح' },
    { group: 'بلاغات', need: 'tickets', label: 'الفني الفاضي', question: 'مين فاضي' },
    { group: 'بلاغات', need: 'tickets', label: 'أكثر الأعطال', question: 'أكثر الأعطال' },
    { group: 'بلاغات', need: 'tickets', label: 'إسناد بلاغ', question: 'أسند بلاغ' },
    { group: 'بلاغات', need: 'settings', label: 'للأسئلة الشائعة', question: 'أضف الحل للأسئلة الشائعة' }
  ],
  technician: [
    { group: 'الطابور', label: 'من أين أبدأ', question: 'أبدأ بأي بلاغ' },
    { group: 'الطابور', label: 'بلاغاتي', question: 'بلاغاتي المسندة' },
    { group: 'الطابور', label: 'التذاكر الفعالة', question: 'وش عندنا بلاغات فعالة' },
    { group: 'الطابور', label: 'بانتظار الاستلام', question: 'البلاغات بانتظار الاستلام' },
    { group: 'الطابور', label: 'المتأخرة', question: 'البلاغات المتأخرة' },
    { group: 'الطابور', label: 'تسليم الوردية', question: 'تسليم الوردية' },
    { group: 'على البلاغ', label: 'استلام', question: 'استلم البلاغ' },
    { group: 'على البلاغ', label: 'طلب معلومة', question: 'اطلب معلومة من الموظف' },
    { group: 'على البلاغ', label: 'إعادة للمعالجة', question: 'أعد البلاغ للمعالجة' },
    { group: 'على البلاغ', label: 'إنجاز', question: 'إنجاز البلاغ' },
    { group: 'على البلاغ', label: 'إرجاع للطابور', question: 'أرجع البلاغ للطابور' },
    { group: 'على البلاغ', label: 'رد على الموظف', question: 'أرسل رداً للموظف' },
    { group: 'على البلاغ', label: 'ملاحظة داخلية', question: 'ملاحظة داخلية' },
    { group: 'على البلاغ', label: 'الأهمية', question: 'غيّر أهمية البلاغ' },
    { group: 'على البلاغ', label: 'نوع العطل', question: 'غيّر نوع العطل' }
  ],
  department_head: [
    { group: 'بلاغات', label: 'تعطل القسم', question: 'تعطل القسم' },
    { group: 'بلاغات', label: 'بلاغات الموظفين', question: 'بلاغات موظفين قسمي' },
    { group: 'بلاغات', label: 'مقارنة الأسبوع', question: 'بلاغات الأسبوع' },
    { group: 'بلاغات', label: 'مين المتابع', question: 'من المتابع' },
    { group: 'بلاغات', label: 'جملة للمدير', question: 'جملة للمدير' },
    { group: 'بلاغات', label: 'تقييم ضعيف', question: 'تقييم ضعيف' }
  ],
  user: [
    { group: 'صف العطل', label: 'جهازي لا يعمل', question: 'جهازي لا يعمل' },
    { group: 'صف العطل', label: 'الطابعة لا تطبع', question: 'الطابعة لا تطبع' },
    { group: 'تابع بلاغاتك', label: 'بلاغاتي المفتوحة', question: 'كم بلاغ مفتوح عندي' },
    { group: 'تابع بلاغاتك', label: 'بانتظار ردي', question: 'بانتظار ردي' },
    { group: 'بعد الإنجاز', label: 'رجعت المشكلة', question: 'رجعت المشكلة' },
    { group: 'بعد الإنجاز', label: 'تقييم بلاغ', question: 'تقييم بلاغ' }
  ]
}

const GROUP_HINT: Record<string, string> = {
  'صف العطل': 'يشرح الخطوات. إذا ما انحلت، ترفع بلاغاً.',
  'تابع بلاغاتك': 'أرقام بلاغاتك، واللي الفني ينتظر ردك فيها.',
  'بعد الإنجاز': 'قيّم البلاغ، أو أعد فتحه إذا رجعت المشكلة.'
}

const INTRO: Record<Persona, string> = {
  admin: 'ينفّذ حسب صلاحيتك: الحسابات والبلاغات، أو اكتب طلبك.',
  technician: 'اكتب طلبك بلغتك. ينفّذ ما تسمح به صلاحية الفني، ويطلب تأكيدك قبل أي تغيير.',
  department_head: 'تابع قسمك: التعطل، المتابعة، والتقييم.',
  user: 'صف العطل، أو تابع بلاغاتك.'
}

const STEP_HINT: Record<string, string> = {
  name: 'الاسم الثلاثي',
  email: 'البريد الإلكتروني',
  username: 'اسم المستخدم بالإنجليزية',
  number: 'رقم الموظف من 9 أرقام',
  password: 'كلمة المرور الجديدة',
  resolution: 'اكتب ماذا تم إصلاحه',
  body: 'نص الملاحظة الداخلية',
  why: 'سبب جعله عاجلاً',
  deptname: 'اسم القسم الجديد',
  reason: 'سبب التقييم'
}

export function AiAssistant({
  supabase,
  mode = 'employee',
  role,
  permissions,
  seed = '',
  compact = false,
  ticketId = '',
  onOpenTicket,
  onTicketsChanged
}: {
  supabase: SupabaseClient
  mode?: Mode
  role?: Persona
  permissions?: string[] | null
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
  const [pickQuery, setPickQuery] = useState('')
  const [thread, setThread] = useState<Turn[]>([])
  const [lastQuestion, setLastQuestion] = useState('')
  const restored = useRef(false)

  useEffect(() => {
    if (compact) {
      restored.current = true
      return
    }
    let alive = true
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return
      const userId = data.session?.user.id
      if (userId) {
        try {
          const raw = localStorage.getItem(threadKey(userId, mode))
          const saved = raw ? JSON.parse(raw) as { thread?: Turn[]; current?: Turn | null } : null
          const turns = Array.isArray(saved?.thread)
            ? saved.thread.filter((turn) => turn && typeof turn.q === 'string' && typeof turn.a === 'string').slice(-8)
            : []
          setThread(turns)
          if (saved?.current?.q && saved?.current?.a) {
            setLastQuestion(saved.current.q)
            setReply({ answer: saved.current.a, steps: [], fault_type: '', urgent: false, needs_ticket: false, kind: 'stats' })
          }
        } catch {
          localStorage.removeItem(threadKey(userId, mode))
        }
      }
      restored.current = true
    })
    return () => { alive = false }
  }, [supabase, mode, compact])

  useEffect(() => {
    if (compact || !restored.current) return
    let alive = true
    supabase.auth.getSession().then(({ data }) => {
      const userId = data.session?.user.id
      if (!alive || !userId) return
      const current = lastQuestion && reply?.answer ? { q: lastQuestion, a: reply.answer } : null
      localStorage.setItem(threadKey(userId, mode), JSON.stringify({ thread, current }))
    })
    return () => { alive = false }
  }, [thread, lastQuestion, reply, supabase, mode, compact])

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
      if (loaded.response.status === 401) {
        setStatus({ configured: false, enabled: false, signedIn: false })
        return
      }
      const result = loaded.result
      if (result && typeof result.configured === 'boolean') {
        setStatus({ configured: result.configured, enabled: result.enabled !== false, signedIn: true })
        return
      }
      setStatus({ configured: true, enabled: true, signedIn: true })
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
    const sessionToken = async () => {
      const current = await supabase.auth.getSession()
      if (current.data.session?.access_token) return current.data.session.access_token
      const refreshed = await supabase.auth.refreshSession()
      return refreshed.data.session?.access_token || ''
    }
    const post = (access: string) => fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
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
    let access = await sessionToken()
    let response = await post(access)
    if (response.status === 401) {
      const refreshed = await supabase.auth.refreshSession()
      access = refreshed.data.session?.access_token || ''
      if (access) response = await post(access)
    }
    if (response.status === 401) {
      setLoading(false)
      setStatus({ configured: false, enabled: false, signedIn: false })
      setError('')
      return
    }
    const result = await response.json().catch(() => ({ error: 'تعذّر الوصول إلى المساعد الذكي.' }))
    setLoading(false)
    if (!response.ok) { setError(result.error || 'تعذّر الوصول إلى المساعد الذكي.'); return }
    const visibleQuestion = draft?.step === 'password' ? 'كلمة المرور' : text
    if (reply?.answer && lastQuestion) setThread((current) => [...current, { q: lastQuestion, a: reply.answer }].slice(-8))
    if (visibleQuestion) setLastQuestion(visibleQuestion)
    if (draft?.step !== 'password') setAsked(text)
    setQuestion('')
    setPickQuery('')
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
  if (!status.signedIn) {
    return (
      <section className={`ai-gemini ${compact ? 'ai-gemini-compact' : ''}`}>
        <p className="ai-box-error">يلزم تسجيل الدخول.</p>
      </section>
    )
  }
  if (status.configured && !status.enabled && mode !== 'admin') return null
  const ready = status.enabled || mode === 'admin'
  const helpReply = reply?.kind === 'help'

  const persona: Persona = role || (mode === 'admin' ? 'admin' : mode === 'technician' ? 'technician' : 'user')
  const prompts = MENUS[persona].filter((chip) => persona !== 'admin' || !chip.need || permissions == null || permissions.includes(chip.need))
  const groups = [...new Set(prompts.map((chip) => chip.group))]
  const intro = INTRO[persona]
  const step = draft?.step || ''
  const placeholder = step === 'body' && draft?.intent === 'reply'
    ? 'نص الرد للموظف'
    : step === 'body' && draft?.intent === 'info'
      ? 'المعلومة المطلوبة من الموظف'
      : (STEP_HINT[step] || (compact ? 'اكتب لسند الإجراء، مثل: اطلب رقم الجهاز' : 'اكتب طلبك بلغتك'))
  const secretStep = step === 'password'
  const choices = reply?.choices || []
  const listed = choices.filter((choice) => choice.id !== 'cancel')
  const cancelChoice = choices.find((choice) => choice.id === 'cancel')
  const usePicker = listed.length > 8
  const picked = listed.filter((choice) => choice.label.includes(pickQuery.trim()))
  const guiding = Boolean(draft || choices.length || reply?.confirm)
  const shownGroups = compact ? groups.filter((group) => group === 'على البلاغ') : groups
  const canSend = STEP_HINT[step] ? question.trim().length >= 1 : question.trim().length >= 5 || Boolean(image)

  return (
    <section className={`ai-gemini ${compact ? 'ai-gemini-compact' : ''}`}>
      {compact ? (
        <div className="ai-ticket-head">
          <span className="ai-gemini-mark" aria-hidden="true"><SanadMark size={20} /></span>
          <div>
            <strong>سند</strong>
            <p>هذا الصندوق لسند، مو للرد على الموظف. تكتب الإجراء بكلامك على هذا البلاغ، يتأكد منك، ثم ينفّذه ويسجّله في السجل.</p>
          </div>
        </div>
      ) : (
        <div className="ai-gemini-intro">
          <span className="ai-gemini-mark" aria-hidden="true"><SanadMark size={26} /></span>
          <p>{intro}</p>
        </div>
      )}
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
          type={secretStep ? 'password' : 'text'}
          autoComplete={secretStep ? 'new-password' : 'off'}
        />
        <button type="submit" className="ai-gemini-send" disabled={!ready || loading || !canSend} aria-label="اسأل">
          {loading ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={18} />}
        </button>
      </form>

      {image && <p className="ai-gemini-meta">مرفقة: {image.name}</p>}
      {status.configured === false && <p className="ai-gemini-meta">اقتراح الحل يحتاج مفتاح المساعد على الخادم. أسئلة التذاكر تعمل الآن.</p>}
      {mode === 'admin' && status.configured && !status.enabled && <p className="ai-gemini-meta">المساعد متوقف من الإعدادات.</p>}
      {error && <p className="ai-box-error">{error}</p>}

      {!compact && thread.length > 0 && (
        <div className="ai-thread">
          {thread.map((turn, index) => (
            <div key={`${turn.q}-${index}`} className="ai-turn">
              <p className="ai-thread-q">{turn.q}</p>
              <div className="ai-thread-a">
                <span className="ai-turn-who"><SanadMark size={14} /> سند</span>
                <p>{turn.a}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {reply && (
        <div className="ai-box-reply">
          <span className="ai-turn-who"><SanadMark size={14} /> سند</span>
          <p>{reply.answer}</p>
          {reply.steps.length > 0 && (
            <ol>
              {reply.steps.map((item, index) => <li key={index}>{item}</li>)}
            </ol>
          )}
          {(choices.length || reply.confirm || reply.followups?.length) ? (
            <div className="ai-box-actions">
              {reply.confirm && (
                <button type="button" className="ai-primary" disabled={loading} onClick={() => void send({ question: 'تأكيد', confirm: reply.confirm })}>{reply.confirm.label}</button>
              )}
              {usePicker ? (
                <div className="ai-picker">
                  <input
                    value={pickQuery}
                    onChange={(event) => setPickQuery(event.target.value)}
                    placeholder="ابحث بالاسم أو رقم الموظف"
                    aria-label="بحث في الحسابات"
                  />
                  <div className="ai-picker-list">
                    {picked.length === 0 ? <p>لا يوجد حساب بهذا البحث.</p> : picked.map((choice) => (
                      <button key={choice.id} type="button" disabled={loading} onClick={() => void send({ question: choice.label, choice: choice.id })}>{choice.label}</button>
                    ))}
                  </div>
                </div>
              ) : listed.map((choice) => (
                <button key={choice.id} type="button" className="ai-ghost" disabled={loading} onClick={() => void send({ question: choice.label, choice: choice.id })}>{choice.label}</button>
              ))}
              {cancelChoice && (
                <button type="button" className="ai-ghost" disabled={loading} onClick={() => void send({ question: cancelChoice.label, choice: cancelChoice.id })}>{cancelChoice.label}</button>
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

      {!guiding && shownGroups.map((group) => (
        <div key={group} className="ai-gemini-group">
          {reply && group === shownGroups[0] && <p className="ai-gemini-again">أو اختر خطوة</p>}
          <p className="ai-gemini-group-label">{compact ? 'أو اختر إجراءً' : group}</p>
          {!compact && GROUP_HINT[group] && <p className="ai-gemini-hint">{GROUP_HINT[group]}</p>}
          <div className="ai-gemini-prompts">
            {prompts.filter((prompt) => prompt.group === group).map((prompt) => (
              <button key={prompt.question} type="button" disabled={!ready || loading} onClick={() => void send({ question: prompt.question })}>{prompt.label}</button>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}
