'use client'

import { useEffect, useMemo, useState, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'
import { Ticket, PlusCircle, LogOut, Moon, Sun, Bell, X, MessageSquare, Star, Search, Hash } from 'lucide-react'
import { SanadMark } from '@/components/sanad-mark'
import { TicketFiles } from '@/components/ticket-files'
import { TicketHistory, TicketTools } from '@/components/ticket-tools'
import { StatusBadge } from '@/components/status-badge'
import { TicketConversation } from '@/components/ticket-conversation'
import { AiAssistant } from '@/components/ai-assistant'
import { departmentLabel, statusLabel, formatTicketNo, formatTicketWhen, greetingStyle, normalizeDigits, ticketNoStyle, ticketNumberMatches } from '@/lib/display'
import { useGreeting } from '@/lib/use-greeting'
import { rememberNotices, unseenNotices } from '@/lib/seen-notices'
import { loadTicketThread, readTicketMeta, sendTicketReply, subscribeTicketChanges } from '@/lib/ticket-thread'
import { rankSimilar } from '@/lib/similar'
import { DesktopNotifyStatus, notifyDesktop, useNotifyPermission } from '@/lib/desktop-notify'
import { FAULT_TYPES, closeStale, isActive, sortTickets, suggestFault, ticketAction } from '@/lib/workflow'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const supabase = createClient(supabaseUrl, supabaseAnonKey)

interface TicketItem {
  id: string
  title: string
  department: string
  status: string
  ai_resolved: boolean
  created_at: string
  ticket_number?: number | null
  user_id?: string
  rating?: number
  assigned_to?: string | null
  assigneeName?: string
  priority?: string | null
  priority_reason?: string | null
  site_place?: string | null
  device_number?: string | null
  fault_type?: string | null
  resolution?: string | null
  rating_reason?: string | null
  is_private?: boolean | null
  is_outage?: boolean | null
  affected_department?: string | null
  cancel_reason?: string | null
  resolved_at?: string | null
  closed_at?: string | null
}

interface NotificationItem {
  id: string
  message: string
  created_at: string
  read: boolean
}

export default function EmployeePage() {
  const [dark, setDark] = useState(false)
  const [loading, setLoading] = useState(true)
  const [userEmail, setUserEmail] = useState('')
  const [userName, setUserName] = useState('موظف النظام')
  const [employeeNumber, setEmployeeNumber] = useState('')
  const [isHead, setIsHead] = useState(false)
  const [headDepartment, setHeadDepartment] = useState('')
  const isHeadRef = useRef(false)
  const headDeptRef = useRef('')
  const ownerDepartments = useRef<Record<string, string>>({})
  const userNameRef = useRef('موظف النظام')
  const greeting = useGreeting()
  const [userId, setUserId] = useState('')
  const openTicketId = useRef('')
  const seenStatuses = useRef<Map<string, string> | null>(null)
  const { permission: notifyPermission, request: requestNotify } = useNotifyPermission()
  const [tickets, setTickets] = useState<TicketItem[]>([])
  const [ticketQuery, setTicketQuery] = useState('')
  const [ticketNoQuery, setTicketNoQuery] = useState('')
  const [listFilter, setListFilter] = useState<'الكل' | 'لم تُغلق' | 'مغلقة'>('الكل')
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [showNotifMenu, setShowNotifMenu] = useState(false)
  
  // شريط الإشعارات المتحرك العلوي
  const [liveBanner, setLiveBanner] = useState<string | null>(null)

  // نافذة تفاصيل التذكرة والمراسلة
  const [selectedTicket, setSelectedTicket] = useState<TicketItem | null>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedTicket(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const [ticketReplies, setTicketReplies] = useState<{ sender: string; text: string; time: string }[]>([])
  const [replyText, setReplyText] = useState('')
  const [replyError, setReplyError] = useState('')
  const [ratingMsg, setRatingMsg] = useState('')
  const [names, setNames] = useState<Record<string, string>>({})
  // إنشاء تذكرة جديدة
  const [showNewModal, setShowNewModal] = useState(false)
  const [ticketFiles, setTicketFiles] = useState<File[]>([])
  const [title, setTitle] = useState('')
  const [autoAssign, setAutoAssign] = useState(true)
  const [alertsOn, setAlertsOn] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [faqs, setFaqs] = useState<Array<{ id: string; title: string; body: string }>>([])
  const [outageMode, setOutageMode] = useState(false)
  const [priority, setPriority] = useState<'عادي' | 'عاجل'>('عادي')
  const [priorityReason, setPriorityReason] = useState('')
  const [faultType, setFaultType] = useState<(typeof FAULT_TYPES)[number]>('أخرى')
  const [faultTouched, setFaultTouched] = useState(false)
  const [sitePlace, setSitePlace] = useState('')
  const [deviceNumber, setDeviceNumber] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [ratingReason, setRatingReason] = useState('')
  const [events, setEvents] = useState<Array<{ id: string; actor_name: string; from_status: string | null; to_status: string | null; note?: string | null; created_at: string }>>([])
  const [actionMsg, setActionMsg] = useState('')
  const [actionBusy, setActionBusy] = useState(false)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    return () => document.documentElement.classList.remove('dark')
  }, [dark])


  useEffect(() => {
    openTicketId.current = selectedTicket?.id || ''
  }, [selectedTicket])

  const fetchEmployeeData = async (uid: string, silent = false) => {
    if (!silent) setLoading(true)
    void closeStale(supabase)
    const head = isHeadRef.current
    const headDept = headDeptRef.current
    const ticketQueryBuilder = supabase.from('tickets').select('*').order('created_at', { ascending: false })
    const [{ data: ticketsData }, { data: profiles }, { data: staffNames }, { data: settings }, { data: faqRows }] = await Promise.all([
      ticketQueryBuilder,
      supabase.from('profiles').select('id, full_name, department'),
      supabase.rpc('staff_names'),
      supabase.from('system_settings').select('email_alerts, auto_assign').eq('id', 'main_settings').maybeSingle(),
      supabase.from('faq_items').select('id, title, body').order('sort_order', { ascending: true })
    ])
    const showAlerts = settings?.email_alerts !== false
    setAutoAssign(settings?.auto_assign !== false)
    setAlertsOn(showAlerts)
    if (faqRows) setFaqs(faqRows)
    if (profiles || staffNames) {
      const map: Record<string, string> = {}
      const deptMap: Record<string, string> = {}
      ;(profiles || []).forEach((person: { id: string; full_name?: string | null; department?: string | null }) => {
        map[person.id] = person.full_name || 'فني الدعم'
        if (person.department) deptMap[person.id] = person.department
      })
      ;(staffNames || []).forEach((person: { id: string; full_name?: string | null }) => {
        if (person.full_name) map[person.id] = person.full_name
      })
      setNames(map)
      ownerDepartments.current = deptMap
    }
    const myDept = departmentLabel(headDept)
    const scoped = ((ticketsData || []) as TicketItem[]).filter((ticket) => {
      if (ticket.user_id === uid) return true
      if (ticket.is_private) return false
      if (ticket.is_outage && departmentLabel(ticket.affected_department) === myDept) return true
      if (!head) return false
      const ownerDept = ownerDepartments.current[ticket.user_id || ''] || ''
      return departmentLabel(ticket.affected_department) === myDept || departmentLabel(ownerDept) === myDept
    }).map((ticket) => {
      const meta = readTicketMeta(ticket.title)
      const storedAssignee = (ticket as TicketItem & { assigned_technician?: string | null }).assigned_technician
      return { ...ticket, title: meta.problem, assigned_to: storedAssignee || ticket.assigned_to || meta.assigneeId, assigneeName: meta.assigneeName }
    })
    setTickets(sortTickets(scoped))
    if (!silent) setLoading(false)
    const previous = seenStatuses.current
    if (previous && showAlerts) {
      scoped.forEach((ticket) => {
        const before = previous.get(ticket.id)
        if (ticket.user_id !== uid || !before || before === ticket.status) return
        const no = formatTicketNo(ticket.ticket_number)
        if (ticket.status === 'بانتظار الموظف') notifyDesktop(`الفني بانتظار ردك على البلاغ ${no}`, ticket.title, `${ticket.id}-waiting`)
        if (ticket.status === 'منجزة') notifyDesktop(`تم إنجاز بلاغك ${no}`, 'افتح البلاغ وأكّد الإغلاق إذا حُلّت المشكلة.', `${ticket.id}-done`)
      })
    }
    seenStatuses.current = new Map(scoped.map((ticket) => [ticket.id, ticket.status]))

    const notices: NotificationItem[] = []
    if (showAlerts && scoped.length > 0) {
      const mapped = scoped
      mapped.forEach((ticket) => {
        if (ticket.status !== 'مفتوحة') {
          notices.push({
            id: `${ticket.id}-${ticket.status}`,
            message: `تغيّرت حالة البلاغ ${formatTicketNo(ticket.ticket_number)} إلى «${statusLabel(ticket.status)}».`,
            created_at: ticket.created_at,
            read: false
          })
        }
      })
      const { data: replies } = await supabase.from('ticket_replies').select('id, ticket_id, sender_name, created_at').in('ticket_id', mapped.map((ticket) => ticket.id)).order('created_at', { ascending: false })
      ;(replies || []).forEach((reply) => {
        if (reply.sender_name === userNameRef.current) return
        const ticket = mapped.find((item) => item.id === reply.ticket_id)
        notices.push({
          id: reply.id,
          message: `رد جديد على البلاغ ${formatTicketNo(ticket?.ticket_number)} من ${reply.sender_name}.`,
          created_at: reply.created_at,
          read: false
        })
      })
    }
    const fresh = unseenNotices(uid, notices.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)).slice(0, 8))
    setNotifications(fresh)

    if (!silent) setLoading(false)
  }

  useEffect(() => {
    if (!userId) return
    return subscribeTicketChanges(supabase, () => {
      fetchEmployeeData(userId, true)
      if (openTicketId.current) {
        loadTicketThread(supabase, openTicketId.current).then((thread) => setTicketReplies(thread.messages))
      }
    })
  }, [userId])

  useEffect(() => {
    async function initEmployee() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        window.location.href = '/login'
        return
      }
      setUserId(session.user.id)
      setUserEmail(session.user.email || '')
      
      const { data: profile } = await supabase.from('profiles').select('*').eq('id', session.user.id).single()
      if (!profile) {
        await supabase.auth.signOut()
        window.location.href = '/login'
        return
      }
      if (profile.must_change_password) { window.location.href = '/login'; return }
      if (profile.role === 'admin') { window.location.href = '/'; return }
      if (profile.role === 'technician' || profile.role === 'manager') { window.location.href = '/technician'; return }
      const fullName = profile.full_name || 'موظف النظام'
      userNameRef.current = fullName
      setUserName(fullName)
      setEmployeeNumber(profile.employee_number || '')
      const head = profile.role === 'department_head'
      isHeadRef.current = head
      headDeptRef.current = profile.department || ''
      setIsHead(head)
      setHeadDepartment(profile.department || '')

      fetchEmployeeData(session.user.id)
    }
    initEmployee()
  }, [])

  const handleCreateTicket = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setErrorMsg('')

    const urgent = !outageMode && priority === 'عاجل'
    if (title.trim().length < 5) {
      setErrorMsg('اكتب وصفاً للمشكلة لا يقل عن 5 أحرف.')
      setSubmitting(false)
      return
    }
    if (urgent && priorityReason.trim().length < 3) {
      setErrorMsg('اذكر سبب توقف العمل في البلاغ العاجل.')
      setSubmitting(false)
      return
    }
    const { data, error } = await supabase.from('tickets').insert([{
      title: title.trim(),
      status: 'مفتوحة',
      ai_resolved: false,
      user_id: userId,
      priority: outageMode ? 'عاجل' : priority,
      priority_reason: outageMode ? (priorityReason.trim() || 'القسم متعطل') : priorityReason.trim(),
      fault_type: faultType,
      site_place: sitePlace.trim(),
      device_number: deviceNumber.trim(),
      is_private: outageMode ? false : isPrivate,
      is_outage: outageMode
    }]).select()

    setSubmitting(false)
    if (error) {
      const raw = error.message || ''
      setErrorMsg(/[\u0600-\u06FF]/.test(raw) ? raw : 'تعذّر إرسال البلاغ. تأكد من الاتصال ثم أعد المحاولة.')
    } else {
      let attachmentNote = ''
      if (data && data.length > 0 && ticketFiles.length > 0) {
        const session = await supabase.auth.getSession()
        const token = session.data.session?.access_token || ''
        for (const file of ticketFiles.slice(0, 3)) {
          const body = new FormData()
          body.append('ticketId', data[0].id)
          body.append('file', file)
          const uploaded = await fetch('/api/tickets/attachments', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body
          })
          if (!uploaded.ok) attachmentNote = ' تعذّر رفع أحد المرفقات.'
        }
      }
      resetNewTicket()
      setShowNewModal(false)
      fetchEmployeeData(userId)
      if (data && data.length > 0) {
        const kind = outageMode ? 'بلاغ تعطل القسم' : 'البلاغ'
        setLiveBanner(`تم تسجيل ${kind} ${formatTicketNo(data[0].ticket_number)} وإحالته إلى الدعم التقني.${attachmentNote}`)
      }
    }
  }

  const openTicket = async (ticket: TicketItem) => {
    setReplyError('')
    setRatingMsg('')
    setReplyText('')
    setActionMsg('')
    if (selectedTicket?.id !== ticket.id) {
      setSelectedTicket(ticket)
      setEvents([])
      setTicketReplies([])
    }
    const [{ data: fresh }, history, thread] = await Promise.all([
      supabase.from('tickets').select('*').eq('id', ticket.id).maybeSingle(),
      supabase.from('ticket_events').select('id, actor_name, from_status, to_status, note, created_at').eq('ticket_id', ticket.id).order('created_at', { ascending: true }),
      loadTicketThread(supabase, ticket.id)
    ])
    const source = (fresh as TicketItem) || ticket
    const meta = readTicketMeta(source.title)
    const storedAssignee = (source as TicketItem & { assigned_technician?: string | null }).assigned_technician
    setSelectedTicket({ ...source, title: meta.problem, assigned_to: storedAssignee || source.assigned_to || meta.assigneeId, assigneeName: meta.assigneeName })
    setEvents(history.data || [])
    setTicketReplies(thread.messages)
    if (thread.error) setReplyError(thread.error)
  }

  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!replyText.trim() || !selectedTicket) return
    const text = replyText.trim()
    setReplyText('')
    setReplyError('')

    const result = await sendTicketReply(supabase, selectedTicket.id, userName, text)
    if (result.error) {
      setReplyError(result.error)
      return
    }
    openTicket(selectedTicket)
  }

  const handleRateTicket = async (ratingVal: number) => {
    if (!selectedTicket) return
    setRatingMsg('')
    if (ratingReason.trim().length < 2) {
      setRatingMsg('اكتب سبب التقييم.')
      return
    }
    const { error } = await supabase.rpc('rate_ticket', { ticket_id: selectedTicket.id, new_rating: ratingVal, reason: ratingReason.trim() })
    if (error) {
      setRatingMsg(error.message || 'تعذر حفظ التقييم.')
      return
    }
    setSelectedTicket({ ...selectedTicket, rating: ratingVal, rating_reason: ratingReason.trim() })
    setRatingMsg(`تم حفظ تقييمك (${ratingVal}/5).`)
    fetchEmployeeData(userId, true)
  }

  const runAction = async (action: string, payload: Record<string, string> = {}) => {
    if (!selectedTicket) return
    setActionMsg('')
    setActionBusy(true)
    const result = await ticketAction(supabase, selectedTicket.id, action, payload)
    setActionBusy(false)
    if (result.error) { setActionMsg(result.error); return }
    const done: Record<string, string> = {
      cancel: 'تم إلغاء البلاغ.',
      confirm: 'تم إغلاق البلاغ. شكراً لتأكيدك.',
      reopen: 'أُعيد فتح البلاغ وأُحيل إلى الدعم التقني.'
    }
    fetchEmployeeData(userId, true)
    const { data: fresh } = await supabase.from('tickets').select('*').eq('id', selectedTicket.id).maybeSingle()
    if (fresh) await openTicket(fresh as TicketItem)
    setActionMsg(done[action] || 'تم حفظ الإجراء.')
  }

  const resetNewTicket = () => {
    setTitle('')
    setTicketFiles([])
    setPriority('عادي')
    setPriorityReason('')
    setFaultType('أخرى')
    setFaultTouched(false)
    setSitePlace('')
    setDeviceNumber('')
    setIsPrivate(false)
    setErrorMsg('')
  }

  const openNewTicket = (outage: boolean, seedTitle = '', seedFault = '') => {
    resetNewTicket()
    setOutageMode(outage)
    if (outage) setFaultType('شبكة')
    if (seedTitle) setTitle(seedTitle)
    if ((FAULT_TYPES as readonly string[]).includes(seedFault)) {
      setFaultType(seedFault as (typeof FAULT_TYPES)[number])
      setFaultTouched(true)
    }
    setShowNewModal(true)
  }

  const describeProblem = (value: string) => {
    setTitle(value)
    if (!autoAssign || faultTouched || outageMode) return
    const suggested = suggestFault(value)
    if (suggested) setFaultType(suggested)
  }

  const focusTickets = (next: 'الكل' | 'لم تُغلق' | 'مغلقة') => {
    setListFilter(next)
    document.getElementById('employee-tickets')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  const visibleTickets = useMemo(() => {
    const term = normalizeDigits(ticketQuery).trim().toLowerCase()
    const plainTerm = term.replace(/#/g, '')
    return tickets.filter((ticket) => {
      if (!isHead && ticket.user_id !== userId) return false
      if (listFilter === 'لم تُغلق' && (ticket.status === 'منجزة' || ticket.status === 'مغلقة' || ticket.status === 'ملغاة')) return false
      if (listFilter === 'مغلقة' && ticket.status !== 'منجزة' && ticket.status !== 'مغلقة') return false
      if (!ticketNumberMatches(ticket.ticket_number, ticketNoQuery)) return false
      if (plainTerm && /^\d+$/.test(plainTerm)) return ticketNumberMatches(ticket.ticket_number, plainTerm)
      if (!term) return true
      const worker = ticket.assigneeName || (ticket.assigned_to ? (names[ticket.assigned_to] || '') : '')
      const requester = ticket.user_id ? (names[ticket.user_id] || '') : ''
      const text = normalizeDigits([ticket.title, ticket.status, ticket.department, worker, requester].join(' ')).toLowerCase()
      return text.includes(term) || (plainTerm !== term && text.includes(plainTerm))
    })
  }, [tickets, ticketQuery, ticketNoQuery, names, listFilter, isHead, userId])

  const statTickets = isHead ? tickets : tickets.filter((ticket) => ticket.user_id === userId)
  const openTicketsCount = statTickets.filter((t) => isActive(t.status)).length
  const closedTicketsCount = statTickets.filter(t => t.status === 'مغلقة' || t.status === 'منجزة').length
  const openOutages = tickets.filter((ticket) => ticket.is_outage && isActive(ticket.status))
  const awaitingMe = tickets.filter((ticket) => ticket.status === 'بانتظار الموظف' && ticket.user_id === userId)
  const headSummary = useMemo(() => {
    const rated = tickets.filter((ticket) => typeof ticket.rating === 'number' && ticket.rating > 0)
    const average = rated.length ? (rated.reduce((sum, ticket) => sum + (ticket.rating || 0), 0) / rated.length).toFixed(1) : '—'
    return [
      { label: 'البلاغات المفتوحة', value: tickets.filter((t) => t.status === 'مفتوحة').length },
      { label: 'قيد المعالجة', value: tickets.filter((t) => t.status === 'قيد المعالجة').length },
      { label: 'بانتظار الموظف', value: tickets.filter((t) => t.status === 'بانتظار الموظف').length },
      { label: 'العاجلة قيد المتابعة', value: tickets.filter((t) => t.priority === 'عاجل' && isActive(t.status)).length },
      { label: 'متوسط التقييم', value: average }
    ]
  }, [tickets])
  const matchedFaqs = useMemo(() => (
    outageMode || title.trim().length < 6 ? [] : rankSimilar(title, faqs, (item) => `${item.title} ${item.body}`, 2, 0.25)
  ), [title, faqs, outageMode])
  const canReply = Boolean(selectedTicket && selectedTicket.user_id === userId && selectedTicket.status !== 'مغلقة' && selectedTicket.status !== 'ملغاة')

  return (
    <main dir="rtl" className="employee-portal">
      
      {/* شريط الإشعارات المتحرك العلوي (Live Ticker Banner) */}
      {liveBanner && (
        <div style={{ background: 'linear-gradient(90deg, #8b5cf6, #6366f1)', color: '#fff', padding: '8px 16px', borderRadius: '0 0 10px 10px', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px', boxShadow: '0 4px 12px rgba(139, 92, 246, 0.2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: 8, height: 8, background: '#10b981', borderRadius: '50%', display: 'inline-block' }} className="animate-pulse" />
            <span>{liveBanner}</span>
          </div>
          <button onClick={() => setLiveBanner(null)} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer' }}><X size={16} /></button>
        </div>
      )}

      {/* رأس الصفحة */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', padding: '1.5rem 0', borderBottom: `1px solid ${'var(--border)'}`, position: 'relative', zIndex: 50 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ color: dark ? '#fff' : '#5b21b6', display: 'flex', alignItems: 'center' }}><SanadMark size={36} /></div>
          <div>
            <h1 style={{ fontSize: '18px', margin: 0, color: 'var(--text)' }}>{isHead ? `رئيس قسم ${headDepartment}` : 'بوابة الموظف'} - سند</h1>
            <p className="day-greeting" style={{ ...greetingStyle, fontSize: '15px' }}>{greeting}، {userName}</p>
            {employeeNumber && <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>رقم الموظف: <b dir="ltr" style={{ color: '#7c3aed' }}>{employeeNumber}</b></p>}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ position: 'relative' }}>
            <button onClick={() => { const next = !showNotifMenu; if (next) rememberNotices(userId, notifications.map((item) => item.id)); setShowNotifMenu(next) }} aria-label="التنبيهات" title="التنبيهات" style={{ background: 'var(--surface)', border: `1px solid ${'var(--border)'}`, borderRadius: '10px', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text)', position: 'relative' }}>
              <Bell size={18} />
              {notifications.length > 0 && <span style={{ position: 'absolute', top: 8, right: 8, width: 8, height: 8, background: '#ef4444', borderRadius: '50%' }}></span>}
            </button>
            {showNotifMenu && (
              <div style={{ position: 'absolute', left: 0, top: '48px', background: 'var(--surface)', border: `1px solid ${'var(--border)'}`, borderRadius: '12px', width: '280px', boxShadow: '0 10px 25px rgba(0,0,0,0.3)', zIndex: 1000, padding: '12px' }}>
                <strong style={{ display: 'block', fontSize: '13px', marginBottom: '8px', color: 'var(--text)' }}>الإشعارات والتنبيهات</strong>
                <DesktopNotifyStatus permission={notifyPermission} onEnable={requestNotify} />
                {notifications.length === 0 ? (
                  <div style={{ fontSize: '12px', padding: '8px', color: '#94a3b8' }}>{alertsOn ? 'لا توجد تنبيهات جديدة.' : 'تنبيهات البوابة متوقفة من إعدادات النظام.'}</div>
                ) : notifications.map(n => (
                  <div key={n.id} style={{ fontSize: '12px', padding: '8px', background: 'var(--field)', borderRadius: '6px', color: 'var(--text)', marginBottom: '6px' }}>
                    {n.message}
                  </div>
                ))}
              </div>
            )}
          </div>

          <button onClick={() => setDark(!dark)} aria-label="تبديل المظهر" title="تبديل المظهر" style={{ background: 'var(--surface)', border: `1px solid ${'var(--border)'}`, borderRadius: '10px', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text)' }}>
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          
          <button onClick={handleLogout} style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: 'none', borderRadius: '10px', padding: '10px 16px', fontSize: '13px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <LogOut size={16} /> خروج
          </button>
        </div>
      </header>

      {/* المحتوى */}
      <div style={{ padding: '2rem 0', flex: 1, display: 'flex', flexDirection: 'column', gap: '2rem' }}>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 'bold', color: 'var(--text)' }}>{isHead ? `بلاغات ${headDepartment}` : 'سجل بلاغاتي'}</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', lineHeight: 1.7, margin: '6px 0 0' }}>{isHead ? `متابعة بلاغات موظفي ${headDepartment}.` : 'تابع بلاغاتك وحالتها.'}</p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {isHead && <button onClick={() => openNewTicket(true)} style={{ background: '#b45309', color: '#fff', border: 'none', borderRadius: '10px', padding: '10px 18px', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer' }}>الإبلاغ عن تعطل القسم</button>}
            <button onClick={() => openNewTicket(false)} style={{ background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '10px', padding: '10px 18px', fontSize: '14px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <PlusCircle size={16} /> تقديم بلاغ جديد
            </button>
          </div>
        </div>

        {awaitingMe.length > 0 && (
          <div style={{ background: 'rgba(147, 51, 234, 0.1)', border: '1px solid rgba(147, 51, 234, 0.25)', borderRadius: '12px', padding: '12px 16px', fontSize: '13px', color: 'var(--text)' }}>
            <b>الفني بانتظار ردك: </b>
            {awaitingMe.map((ticket) => (
              <button key={ticket.id} type="button" onClick={() => openTicket(ticket)} style={{ background: 'transparent', border: 'none', color: '#9333ea', cursor: 'pointer', fontWeight: 700, marginInlineEnd: '10px' }}>{formatTicketNo(ticket.ticket_number)} {ticket.title}</button>
            ))}
          </div>
        )}

        {openOutages.length > 0 && (
          <div style={{ background: 'rgba(180, 83, 9, 0.12)', borderRadius: '12px', padding: '12px 16px', fontSize: '13px', color: 'var(--text)' }}>
            <b>يوجد بلاغ مفتوح عن تعطل القسم. </b>
            {isHead ? 'يعمل الفنيون عليه، ويمكنك متابعته من هنا.' : 'تابِعه بدلاً من فتح بلاغ جديد عن العطل نفسه.'}
            {openOutages.map((ticket) => (
              <button key={ticket.id} type="button" onClick={() => openTicket(ticket)} style={{ display: 'block', marginTop: '6px', background: 'transparent', border: 'none', color: '#b45309', cursor: 'pointer', fontWeight: 700, textAlign: 'right' }}>{formatTicketNo(ticket.ticket_number)} {ticket.title} · {statusLabel(ticket.status)}</button>
            ))}
          </div>
        )}

        <AiAssistant supabase={supabase} onOpenTicket={(question, fault) => openNewTicket(false, question, fault)} />

        {isHead && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px' }}>
            <b style={{ fontSize: '14px', color: 'var(--text)' }}>ملخص {headDepartment}</b>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '10px' }}>
              {headSummary.map((item) => (
                <span key={item.label} style={{ background: 'var(--field)', borderRadius: '10px', padding: '8px 12px', fontSize: '13px', color: 'var(--text)' }}>{item.label}: <b>{item.value}</b></span>
              ))}
            </div>
          </div>
        )}

        <div className="stats-grid">
          <button type="button" className="stat-card" aria-pressed={listFilter === 'الكل'} onClick={() => focusTickets('الكل')}>
            <small>إجمالي البلاغات</small>
            <strong style={{ color: 'var(--text)' }}>{statTickets.length}</strong>
            <span className="stat-caption">اضغط لعرض الكل</span>
          </button>
          <button type="button" className="stat-card" aria-pressed={listFilter === 'لم تُغلق'} onClick={() => focusTickets('لم تُغلق')}>
            <small style={{ color: '#f59e0b' }}>لم تُغلق بعد</small>
            <strong style={{ color: '#f59e0b' }}>{openTicketsCount}</strong>
            <span className="stat-caption">اضغط لعرضها</span>
          </button>
          <button type="button" className="stat-card" aria-pressed={listFilter === 'مغلقة'} onClick={() => focusTickets('مغلقة')}>
            <small style={{ color: '#10b981' }}>المنجزة والمغلقة</small>
            <strong style={{ color: '#10b981' }}>{closedTicketsCount}</strong>
            <span className="stat-caption">اضغط لعرضها</span>
          </button>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '180px', background: 'var(--surface)', border: `1px solid ${'var(--border)'}`, borderRadius: '12px', padding: '10px 14px' }}>
            <Hash size={16} color="#8b5cf6" />
            <input value={ticketNoQuery} onChange={(event) => setTicketNoQuery(event.target.value)} inputMode="numeric" placeholder="رقم البلاغ" aria-label="بحث برقم البلاغ" style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: '15px', fontWeight: 800, direction: 'ltr', textAlign: 'left' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: '220px', background: 'var(--surface)', border: `1px solid ${'var(--border)'}`, borderRadius: '12px', padding: '10px 14px' }}>
            <Search size={16} color="#8b5cf6" />
            <input aria-label="بحث في البلاغات" value={ticketQuery} onChange={(event) => setTicketQuery(event.target.value)} placeholder={isHead ? 'ابحث في بلاغات القسم: المشكلة، الموظف، الحالة، الفني...' : 'ابحث في بلاغاتك: المشكلة، الحالة، الفني...'} style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: '14px' }} />
          </div>
        </div>

        {/* الجدول */}
        <div id="employee-tickets" style={{ background: 'var(--surface)', border: `1px solid ${'var(--border)'}`, borderRadius: '16px', overflowX: 'auto' }}>
          {loading ? (
            <div className="skeleton-list" aria-label="جاري التحميل">{[0, 1, 2, 3].map((item) => <div key={item} className="skeleton-row" />)}</div>
          ) : visibleTickets.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>{ticketQuery.trim() || ticketNoQuery.trim() || listFilter !== 'الكل' ? 'لا توجد بلاغات مطابقة.' : 'لا توجد بلاغات مسجلة حالياً.'}</div>
          ) : (
            <table className="ticket-cards" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'right' }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${'var(--border)'}`, color: 'var(--text-muted)', fontSize: '13px' }}>
                  <th style={{ padding: '12px 16px' }}>رقم البلاغ</th>
                  {isHead && <th style={{ padding: '12px 16px' }}>مقدّم البلاغ</th>}
                  <th style={{ padding: '12px 16px' }}>المشكلة</th>
                  <th style={{ padding: '12px 16px' }}>نوع العطل</th>
                  <th style={{ padding: '12px 16px' }}>الفني</th>
                  <th style={{ padding: '12px 16px' }}>الحالة</th>
                  <th style={{ padding: '12px 16px' }}>التاريخ والوقت</th>
                </tr>
              </thead>
              <tbody>
                {visibleTickets.map(t => (
                  <tr key={t.id} onClick={() => openTicket(t)} style={{ borderBottom: `1px solid ${'var(--border)'}`, fontSize: '14px', color: 'var(--text)', cursor: 'pointer', transition: 'background 0.2s' }}>
                    <td className="card-no" style={{ padding: '14px 16px' }}><span className="ticket-no" style={ticketNoStyle}>{formatTicketNo(t.ticket_number)}</span></td>
                    {isHead && <td data-label="مقدّم البلاغ" style={{ padding: '14px 16px' }}>{t.user_id ? (names[t.user_id] || 'موظف') : 'غير معروف'}</td>}
                    <td className="cell-wrap card-title" style={{ padding: '14px 16px', fontWeight: 'bold', color: 'var(--text)' }}>
                      {t.title}
                      <span style={{ display: 'flex', gap: '6px', marginTop: '4px', fontSize: '11px', fontWeight: 700 }}>
                        {t.status === 'بانتظار الموظف' && t.user_id === userId && <span style={{ color: '#9333ea' }}>مطلوب ردك</span>}
                        {t.is_outage && <span style={{ color: '#b45309' }}>بلاغ قسم</span>}
                        {t.priority === 'عاجل' && <span style={{ color: '#ef4444' }}>عاجل</span>}
                        {t.is_private && <span style={{ color: '#64748b' }}>خاص</span>}
                      </span>
                    </td>
                    <td data-label="نوع العطل" style={{ padding: '14px 16px' }}>{t.fault_type || '—'}</td>
                    <td data-label="الفني" style={{ padding: '14px 16px' }}>{t.assigneeName || (t.assigned_to ? (names[t.assigned_to] || 'فني الدعم') : 'بانتظار فني')}</td>
                    <td data-label="الحالة" style={{ padding: '14px 16px' }}><StatusBadge status={t.status} /></td>
                    <td data-label="التاريخ" style={{ padding: '14px 16px', fontSize: '12px', color: 'var(--text-muted)' }}>{formatTicketWhen(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* نافذة تفاصيل التذكرة والمراسلة والتقييم */}
      {selectedTicket && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedTicket(null) }} style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}>
          <div style={{ background: 'var(--surface)', border: `1px solid ${'var(--border)'}`, borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: '600px', maxHeight: '85vh', overflowY: 'auto', color: 'var(--text)' }}>
            
            <div className="modal-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', borderBottom: `1px solid ${'var(--border)'}`, paddingBottom: '1rem' }}>
              <div>
                <span className="ticket-no" style={{ ...ticketNoStyle, display: 'block', marginBottom: '4px' }}>{formatTicketNo(selectedTicket.ticket_number)}</span>
                <h3 style={{ fontSize: '18px', fontWeight: 'bold', margin: 0 }}>{selectedTicket.title}</h3>
              </div>
              <button onClick={() => setSelectedTicket(null)} aria-label="إغلاق" title="إغلاق" style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={20} /></button>
            </div>

            {actionMsg && <p style={{ fontSize: '13px', margin: '0 0 12px', color: actionMsg.startsWith('تم') || actionMsg.startsWith('أُعيد') ? '#10b981' : '#ef4444' }}>{actionMsg}</p>}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '1rem', fontSize: '13px', flexWrap: 'wrap', alignItems: 'center' }}>
              <StatusBadge status={selectedTicket.status} />
              <span style={{ background: 'var(--field)', padding: '6px 12px', borderRadius: '8px' }}><b>الوقت:</b> {formatTicketWhen(selectedTicket.created_at)}</span>
              <span style={{ background: 'var(--field)', padding: '6px 12px', borderRadius: '8px' }}><b>مقدّم البلاغ:</b> {selectedTicket.user_id ? (names[selectedTicket.user_id] || userName) : userName}</span>
              <span style={{ background: 'var(--field)', padding: '6px 12px', borderRadius: '8px' }}><b>يعمل عليها:</b> {selectedTicket.assigneeName || (selectedTicket.assigned_to ? (names[selectedTicket.assigned_to] || 'فني الدعم') : 'بانتظار فني')}</span>
            </div>
            <TicketTools ticket={selectedTicket} actor={isHead ? 'head' : 'employee'} userId={userId} technicians={[]} events={events} notes={[]} busy={actionBusy} onRun={runAction} />
            {selectedTicket.user_id !== userId && <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 1rem' }}>{selectedTicket.is_outage ? 'بلاغ تعطل القسم، للمتابعة فقط.' : 'للمتابعة فقط.'}</p>}

            {/* الردود */}
            <div style={{ marginBottom: '1.5rem' }}>
              <h4 style={{ fontSize: '14px', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}><MessageSquare size={16} /> المحادثة</h4>
              <TicketConversation requester={selectedTicket.user_id ? (names[selectedTicket.user_id] || userName) : userName} problem={selectedTicket.title} messages={ticketReplies} />

              {replyError && <p style={{ fontSize: '12px', color: '#ef4444', margin: '0 0 8px' }}>{replyError}</p>}
              {canReply && <form onSubmit={handleSendReply} style={{ display: 'flex', gap: '8px' }}>
                <input aria-label="الرد" type="text" value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder={selectedTicket.status === 'بانتظار الموظف' ? 'الفني بانتظار ردك، اكتب المعلومة المطلوبة...' : 'اكتب رداً أو استفساراً للفني...'} style={{ flex: 1, background: 'var(--field)', border: `1px solid ${'var(--field-border)'}`, borderRadius: '8px', padding: '10px', color: 'var(--text)', outline: 'none', fontSize: '13px' }} />
                <button type="submit" style={{ background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '8px', padding: '0 16px', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer' }}>إرسال</button>
              </form>}
            </div>

            {/* التقييم */}
            {selectedTicket.user_id === userId && (selectedTicket.status === 'مغلقة' || selectedTicket.status === 'منجزة') && (
              <div style={{ background: 'var(--field)', border: `1px solid ${'var(--field-border)'}`, borderRadius: '12px', padding: '16px', textAlign: 'center' }}>
                <h4 style={{ fontSize: '14px', marginBottom: '6px', color: '#10b981' }}>{selectedTicket.rating ? `تقييمك الحالي ${selectedTicket.rating}/5` : 'قيّم الخدمة'}</h4>
                <p style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '12px' }}>اكتب سبب التقييم، ثم اختر عدد النجوم.</p>
                <input aria-label="سبب التقييم" value={ratingReason} onChange={(event) => setRatingReason(event.target.value)} placeholder="سبب التقييم" style={{ width: '100%', marginBottom: '10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '8px', color: 'var(--text)' }} />
                <div style={{ display: 'flex', justifyContent: 'center', gap: '8px' }}>
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button key={star} type="button" aria-label={`تقييم ${star} من 5`} onClick={() => handleRateTicket(star)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: (selectedTicket.rating || 0) >= star ? '#f59e0b' : '#94a3b8' }}>
                      <Star size={24} fill={(selectedTicket.rating || 0) >= star ? '#f59e0b' : 'none'} />
                    </button>
                  ))}
                </div>
                {ratingMsg && <p style={{ fontSize: '12px', margin: '10px 0 0', color: ratingMsg.startsWith('تم حفظ') ? '#10b981' : '#ef4444' }}>{ratingMsg}</p>}
              </div>
            )}

            <TicketHistory events={events} />
            <div style={{ marginTop: '1rem' }}><TicketFiles ticketId={selectedTicket.id} /></div>

          </div>
        </div>
      )}

      {/* نافذة رفع تذكرة */}
      {showNewModal && (
        <div className="modal-backdrop" style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--surface)', border: `1px solid ${'var(--border)'}`, borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: '450px', maxHeight: '92vh', overflowY: 'auto', color: 'var(--text)' }}>
            <div className="modal-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 'bold' }}>{outageMode ? 'الإبلاغ عن تعطل القسم' : 'بلاغ جديد'}</h3>
              <button onClick={() => setShowNewModal(false)} aria-label="إغلاق" title="إغلاق" style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            {errorMsg && <div style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '10px', borderRadius: '8px', fontSize: '13px', marginBottom: '1rem', textAlign: 'center' }}>{errorMsg}</div>}
            {!outageMode && openOutages.length > 0 && (
              <div style={{ background: 'rgba(180, 83, 9, 0.12)', borderRadius: '8px', padding: '10px', fontSize: '12px', marginBottom: '1rem', color: 'var(--text)' }}>
                يوجد بلاغ مفتوح عن تعطل القسم: {openOutages.map((ticket) => `${formatTicketNo(ticket.ticket_number)} ${ticket.title}`).join('، ')}. إذا كانت مشكلتك هي العطل نفسه فتابِعه بدلاً من فتح بلاغ جديد.
              </div>
            )}
            {outageMode && <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 1rem', lineHeight: 1.7 }}>يصل للدعم التقني عاجلاً، ويراه موظفو {headDepartment}.</p>}
            {!outageMode && faqs.length > 0 && matchedFaqs.length === 0 && (
              <details style={{ background: 'var(--field)', borderRadius: '8px', padding: '10px 12px', marginBottom: '1rem', fontSize: '13px' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 700 }}>حلول سريعة قبل الإرسال ({faqs.length})</summary>
                {faqs.map((item) => (
                  <p key={item.id} style={{ margin: '8px 0 0', color: 'var(--text-muted)', lineHeight: 1.7 }}><b style={{ color: 'var(--text)' }}>{item.title}: </b>{item.body}</p>
                ))}
              </details>
            )}
            <form onSubmit={handleCreateTicket} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label htmlFor="new-ticket-problem" style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>{outageMode ? 'ما العطل الذي أصاب القسم؟' : 'وصف المشكلة'}</label>
                <textarea id="new-ticket-problem" required rows={3} value={title} onChange={(e) => describeProblem(e.target.value)} placeholder={outageMode ? 'مثال: انقطاع الشبكة في الدور الثاني بالكامل' : 'اكتب تفاصيل المشكلة التقنية...'} style={{ width: '100%', background: 'var(--field)', border: `1px solid ${'var(--field-border)'}`, borderRadius: '8px', padding: '10px', color: 'var(--text)', outline: 'none', resize: 'none' }} />
                {matchedFaqs.length > 0 && (
                  <div role="status" style={{ marginTop: '8px', background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: '8px', padding: '10px 12px', fontSize: '13px' }}>
                    <b style={{ color: '#059669' }}>جرّب هذا قبل الإرسال:</b>
                    {matchedFaqs.map((item) => (
                      <p key={item.id} style={{ margin: '6px 0 0', lineHeight: 1.7 }}><b>{item.title}: </b><span style={{ color: 'var(--text-muted)' }}>{item.body}</span></p>
                    ))}
                    <small style={{ display: 'block', marginTop: '6px', color: 'var(--text-muted)' }}>إذا لم تُحل المشكلة، أكمل إرسال البلاغ.</small>
                  </div>
                )}
              </div>
              <div>
                <label htmlFor="new-ticket-fault" style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>نوع العطل</label>
                <select id="new-ticket-fault" value={faultType} onChange={(event) => { setFaultType(event.target.value as (typeof FAULT_TYPES)[number]); setFaultTouched(true) }} style={{ width: '100%', background: 'var(--field)', border: '1px solid var(--field-border)', borderRadius: '8px', padding: '10px', color: 'var(--text)' }}>
                  {FAULT_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                {autoAssign && !outageMode && <small style={{ display: 'block', marginTop: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>يُقترح من وصف المشكلة.</small>}
              </div>
              {!outageMode && <div>
                <label htmlFor="new-ticket-priority" style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>الأهمية</label>
                <select id="new-ticket-priority" value={priority} onChange={(event) => setPriority(event.target.value as 'عادي' | 'عاجل')} style={{ width: '100%', background: 'var(--field)', border: '1px solid var(--field-border)', borderRadius: '8px', padding: '10px', color: 'var(--text)' }}>
                  <option value="عادي">عادي</option>
                  <option value="عاجل">عاجل (العمل متوقف)</option>
                </select>
                <small style={{ display: 'block', marginTop: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>«عاجل» فقط إذا توقف عملك.</small>
              </div>}
              {(outageMode || priority === 'عاجل') && <input value={priorityReason} onChange={(event) => setPriorityReason(event.target.value)} aria-label={outageMode ? 'الأعمال المتوقفة' : 'سبب توقف العمل'} placeholder={outageMode ? 'ما الأعمال المتوقفة بسبب العطل؟ (اختياري)' : 'ما سبب توقف العمل؟'} style={{ width: '100%', background: 'var(--field)', border: '1px solid var(--field-border)', borderRadius: '8px', padding: '10px', color: 'var(--text)' }} />}
              {!outageMode && !isHead && (
                <label style={{ fontSize: '13px', display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input type="checkbox" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} style={{ marginTop: '3px' }} />
                  <span>إخفاء البلاغ عن رئيس القسم<small style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)' }}>للمشاكل الشخصية، مثل جهازك أو حسابك الخاص.</small></span>
                </label>
              )}
              <details className="fold" style={{ border: '1px solid var(--border)', borderRadius: '10px', padding: '10px 12px' }}>
                <summary>{outageMode ? 'المكان والمرفقات (اختياري)' : 'المكان ورقم الجهاز والمرفقات (اختياري)'}</summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: outageMode ? '1fr' : '1fr 1fr', gap: '10px' }}>
                    <input value={sitePlace} onChange={(event) => setSitePlace(event.target.value)} placeholder="المكان" aria-label="المكان" style={{ width: '100%', background: 'var(--field)', border: '1px solid var(--field-border)', borderRadius: '8px', padding: '10px', color: 'var(--text)' }} />
                    {!outageMode && <input value={deviceNumber} onChange={(event) => setDeviceNumber(event.target.value)} placeholder="رقم الجهاز" aria-label="رقم الجهاز" style={{ width: '100%', background: 'var(--field)', border: '1px solid var(--field-border)', borderRadius: '8px', padding: '10px', color: 'var(--text)' }} />}
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontSize: '13px' }}>
                    <span style={{ border: '1px solid #c4b5fd', borderRadius: '8px', padding: '8px 12px', fontWeight: 700, whiteSpace: 'nowrap' }}>إرفاق ملفات</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{ticketFiles.length ? ticketFiles.map((file) => file.name).join('، ') : 'صورة أو PDF، حتى 3 ملفات، أقل من 5 ميغابايت لكل ملف'}</span>
                    <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple onChange={(event) => setTicketFiles(Array.from(event.target.files || []).slice(0, 3))} style={{ display: 'none' }} />
                  </label>
                </div>
              </details>
              <div className="modal-foot">
                <button type="submit" disabled={submitting} style={{ background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '8px', padding: '12px', fontWeight: 'bold', cursor: 'pointer' }}>
                  {submitting ? 'جاري الإرسال...' : 'إرسال البلاغ'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  )
}
