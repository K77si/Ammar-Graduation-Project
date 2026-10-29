'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowDownLeft, Bell, Bot, Check, CircleHelp, Info, LayoutDashboard, LogOut, Menu, Moon, RefreshCw, Sun, Ticket, Wrench, X, MessageSquare, BarChart3, Send
} from 'lucide-react'
import { SanadMark } from '@/components/sanad-mark'
import { TicketFiles } from '@/components/ticket-files'
import { TicketHistory, TicketTools } from '@/components/ticket-tools'
import { StatusBadge, StatusLegend } from '@/components/status-badge'
import { AiAssistant } from '@/components/ai-assistant'
import { AccountLog } from '@/components/account-log'
import { TicketSearch } from '@/components/ticket-search'
import { TicketConversation } from '@/components/ticket-conversation'
import { statusLabel, asRating, departmentLabel, formatTicketNo, formatTicketWhen, greetingStyle, normalizeDigits, ticketNoStyle, ticketNumberMatches } from '@/lib/display'
import { useGreeting } from '@/lib/use-greeting'
import { AVAILABILITY, WORK_STATUSES, closeStale, isActive, isDelayed, sortTickets, ticketAction } from '@/lib/workflow'
import { rememberNotices, unseenNotices } from '@/lib/seen-notices'
import { rankSimilar } from '@/lib/similar'
import { DesktopNotifyStatus, notifyDesktop, useNotifyPermission } from '@/lib/desktop-notify'
import { loadTicketThread, readTicketMeta, sendTicketReply, subscribeTicketChanges } from '@/lib/ticket-thread'
import { loadTicketEvents } from '@/lib/ticket-events'
import { browserSupabase } from '@/lib/supabase-browser'
import { useTheme } from '@/lib/theme'

const supabase = browserSupabase()

const STATUSES = WORK_STATUSES

interface TicketItem {
  id: string
  title: string
  department: string
  status: string
  ai_resolved: boolean
  created_at: string
  ticket_number?: number | null
  rating?: number
  user_id?: string
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

interface ReplyItem {
  sender: string
  text: string
  time: string
}

export default function TechnicianPage() {
  const { dark, toggle } = useTheme()
  const [menu, setMenu] = useState(false)
  const [loading, setLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [ready, setReady] = useState(false)
  const [activeTab, setActiveTab] = useState('نظرة عامة')
  const [userName, setUserName] = useState('فني الدعم')
  const greeting = useGreeting()
  const [userEmail, setUserEmail] = useState('')
  const [userId, setUserId] = useState('')
  const userIdRef = useRef('')
  const [notices, setNotices] = useState<Array<{ id: string; message: string }>>([])
  const [showNotices, setShowNotices] = useState(false)
  const [alertsOn, setAlertsOn] = useState(true)
  const openTicketId = useRef('')
  const seenTickets = useRef<Map<string, { status: string; assigned: string }> | null>(null)
  const { permission: notifyPermission, request: requestNotify } = useNotifyPermission()
  const [tickets, setTickets] = useState<TicketItem[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [staffNumbers, setStaffNumbers] = useState<Record<string, string>>({})
  const [departments, setDepartments] = useState<Record<string, string>>({})
  const [workerNumber, setWorkerNumber] = useState('')
  const [refreshNotice, setRefreshNotice] = useState('')
  const [filter, setFilter] = useState<'الكل' | 'المنجزة والمغلقة' | (typeof STATUSES)[number]>('الكل')
  const [query, setQuery] = useState('')
  const [ticketNoQuery, setTicketNoQuery] = useState('')
  const [selectedTicket, setSelectedTicket] = useState<TicketItem | null>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedTicket(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const [ticketReplies, setTicketReplies] = useState<ReplyItem[]>([])
  const [replyText, setReplyText] = useState('')
  const [resolutionDraft, setResolutionDraft] = useState('')
  const [savingStatus, setSavingStatus] = useState(false)
  const [actionMsg, setActionMsg] = useState('')
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [showHelpModal, setShowHelpModal] = useState(false)
  const [availability, setAvailability] = useState<(typeof AVAILABILITY)[number]>('متاح')
  const [templates, setTemplates] = useState<Array<{ id: string; body: string }>>([])
  const [events, setEvents] = useState<Array<{ id: string; actor_name: string; from_status: string | null; to_status: string | null; note?: string | null; source?: string | null; created_at: string }>>([])
  const [notes, setNotes] = useState<Array<{ id: string; author_name: string; body: string; created_at: string }>>([])


  const fetchQueue = async (silent = false) => {
    if (!silent) {
      setLoading(true)
      setIsRefreshing(true)
    }
    setRefreshNotice('')
    void closeStale(supabase)

    const [{ data: ticketsData }, { data: profiles }, { data: settings }, { data: templateRows }] = await Promise.all([
      supabase.from('tickets').select('*').order('created_at', { ascending: false }),
      supabase.from('profiles').select('id, full_name, department, employee_number'),
      supabase.from('system_settings').select('email_alerts').eq('id', 'main_settings').maybeSingle(),
      supabase.from('reply_templates').select('id, body').order('sort_order', { ascending: true })
    ])
    if (templateRows) setTemplates(templateRows)
    const showAlerts = settings?.email_alerts !== false
    setAlertsOn(showAlerts)
    if (ticketsData) {
      const mapped = (ticketsData as TicketItem[]).map((ticket) => {
        const meta = readTicketMeta(ticket.title)
        const storedAssignee = (ticket as TicketItem & { assigned_technician?: string | null }).assigned_technician
        return { ...ticket, title: meta.problem, assigned_to: storedAssignee || ticket.assigned_to || meta.assigneeId, assigneeName: meta.assigneeName }
      })
      setTickets(sortTickets(mapped))
      const uid = userIdRef.current
      const previous = seenTickets.current
      if (previous && showAlerts) {
        mapped.forEach((ticket) => {
          const before = previous.get(ticket.id)
          const no = formatTicketNo(ticket.ticket_number)
          if (!before && ticket.status === 'مفتوحة' && (ticket.priority === 'عاجل' || ticket.is_outage)) {
            notifyDesktop(ticket.is_outage ? `بلاغ تعطل قسم ${no}` : `بلاغ عاجل جديد ${no}`, ticket.title, `${ticket.id}-new`)
          } else if (before && ticket.assigned_to === uid && before.assigned !== uid) {
            notifyDesktop(`أُسند إليك البلاغ ${no}`, ticket.title, `${ticket.id}-assigned`)
          } else if (before && ticket.assigned_to === uid && before.status === 'بانتظار الموظف' && ticket.status === 'قيد المعالجة') {
            notifyDesktop(`ردّ الموظف على البلاغ ${no}`, ticket.title, `${ticket.id}-reply`)
          }
        })
      }
      seenTickets.current = new Map(mapped.map((ticket) => [ticket.id, { status: ticket.status, assigned: ticket.assigned_to || '' }]))
      const urgentQueue = mapped
        .filter((ticket) => ticket.status === 'مفتوحة' && !ticket.assigned_to && (ticket.priority === 'عاجل' || ticket.is_outage))
        .map((ticket) => ({
          id: `${ticket.id}-urgent`,
          message: `${ticket.is_outage ? 'بلاغ تعطل قسم' : 'بلاغ عاجل'} ${formatTicketNo(ticket.ticket_number)} بانتظار الاستلام.`
        }))
      const assigned = mapped.filter((ticket) => ticket.assigned_to === uid && isActive(ticket.status)).map((ticket) => ({
        id: `${ticket.id}-${ticket.status}`,
        message: `البلاغ ${formatTicketNo(ticket.ticket_number)} مُسند إليك، وحالته «${statusLabel(ticket.status)}».`
      }))
      setNotices(showAlerts ? unseenNotices(uid, [...urgentQueue, ...assigned].slice(0, 10)) : [])
    }
    if (profiles) {
      const map: Record<string, string> = {}
      const numberMap: Record<string, string> = {}
      const deptMap: Record<string, string> = {}
      profiles.forEach((person) => {
        map[person.id] = person.full_name || 'موظف'
        if (person.employee_number) numberMap[person.id] = person.employee_number
        deptMap[person.id] = departmentLabel(person.department)
      })
      setNames(map)
      setStaffNumbers(numberMap)
      setDepartments(deptMap)
    }
    if (!silent) {
      setLoading(false)
      setIsRefreshing(false)
    }
  }

  useEffect(() => {
    async function initTechnician() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        window.location.href = '/login'
        return
      }
      userIdRef.current = session.user.id
      setUserId(session.user.id)
      setUserEmail(session.user.email || '')
      const { data: profile } = await supabase.from('profiles').select('*').eq('id', session.user.id).single()
      if (!profile) {
        await supabase.auth.signOut()
        window.location.href = '/login'
        return
      }
      if (profile.must_change_password) {
        window.location.href = '/login'
        return
      }
      if (profile.role !== 'technician' && profile.role !== 'manager') {
        window.location.href = profile.role === 'admin' ? '/' : '/employee'
        return
      }
      setUserName(profile.full_name || 'فني الدعم')
      setWorkerNumber(profile.employee_number || '')
      setAvailability(profile.availability || 'متاح')
      setReady(true)
      fetchQueue()
    }
    initTechnician()
    const stop = subscribeTicketChanges(supabase, () => {
      fetchQueue(true)
      if (openTicketId.current) {
        loadTicketThread(supabase, openTicketId.current).then((thread) => setTicketReplies(thread.messages))
      }
    })
    return stop
  }, [])

  useEffect(() => {
    openTicketId.current = selectedTicket?.id || ''
  }, [selectedTicket])

  const openTicket = async (ticket: TicketItem) => {
    if (selectedTicket?.id !== ticket.id) {
      setEvents([])
      setNotes([])
      setTicketReplies([])
      setReplyText('')
      setResolutionDraft('')
    }
    setSelectedTicket(ticket)
    setActionMsg('')
    const [history, privateNotes, thread] = await Promise.all([
      loadTicketEvents(supabase, ticket.id),
      supabase.from('ticket_notes').select('id, author_name, body, created_at').eq('ticket_id', ticket.id).order('created_at', { ascending: true }),
      loadTicketThread(supabase, ticket.id)
    ])
    setEvents(history)
    setNotes(privateNotes.data || [])
    setTicketReplies(thread.messages)
    if (thread.error) setActionMsg(thread.error)
  }

  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!replyText.trim() || !selectedTicket) return
    const text = replyText.trim()
    setReplyText('')
    setActionMsg('')

    const result = await sendTicketReply(supabase, selectedTicket.id, userName, text)
    if (result.error) {
      setActionMsg(result.error)
      return
    }
    const thread = await loadTicketThread(supabase, selectedTicket.id)
    setTicketReplies(thread.messages)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  const ticketMatchesQuery = (ticket: TicketItem) => {
    if (!ticketNumberMatches(ticket.ticket_number, ticketNoQuery)) return false
    const term = normalizeDigits(query).trim().toLowerCase()
    const plainTerm = term.replace(/#/g, '')
    if (plainTerm && /^\d+$/.test(plainTerm)) return ticketNumberMatches(ticket.ticket_number, plainTerm)
    if (!term) return true
    const requester = (ticket.user_id && names[ticket.user_id]) || ''
    const requesterNo = (ticket.user_id && staffNumbers[ticket.user_id]) || ''
    const requesterDept = (ticket.user_id && departments[ticket.user_id]) || ''
    const worker = ticket.assigneeName || (ticket.assigned_to ? (names[ticket.assigned_to] || '') : '')
    const workerNo = ticket.assigned_to ? (staffNumbers[ticket.assigned_to] || '') : ''
    const text = normalizeDigits([ticket.title, ticket.status, requester, requesterNo, requesterDept, worker, workerNo].join(' ')).toLowerCase()
    return text.includes(term) || (plainTerm !== term && text.includes(plainTerm))
  }

  const visibleTickets = useMemo(() => {
    return tickets.filter((ticket) => {
      const statusOk = filter === 'الكل' || (filter === 'المنجزة والمغلقة' ? (ticket.status === 'منجزة' || ticket.status === 'مغلقة') : ticket.status === filter)
      return statusOk && ticketMatchesQuery(ticket)
    })
  }, [tickets, filter, query, ticketNoQuery, names, staffNumbers, departments])

  const myTickets = useMemo(() => {
    return tickets.filter((ticket) => ticket.assigned_to === userId && isActive(ticket.status) && ticketMatchesQuery(ticket))
  }, [tickets, userId, query, ticketNoQuery, names, staffNumbers, departments])

  const openCount = tickets.filter((ticket) => ticket.status === 'مفتوحة').length
  const progressCount = tickets.filter((ticket) => ticket.status === 'قيد المعالجة').length
  const myCount = tickets.filter((ticket) => ticket.assigned_to === userId && isActive(ticket.status)).length
  const delayedCount = tickets.filter((ticket) => isDelayed(ticket)).length
  const urgentOpen = tickets.filter((ticket) => ticket.status === 'مفتوحة' && !ticket.assigned_to && (ticket.priority === 'عاجل' || ticket.is_outage)).length
  const doneCount = tickets.filter((ticket) => ticket.status === 'منجزة' || ticket.status === 'مغلقة').length
  const totalTickets = tickets.length

  const statusStats = useMemo(() => {
    return STATUSES.map((status) => ({
      label: status,
      value: totalTickets > 0 ? Math.round((tickets.filter((ticket) => ticket.status === status).length / totalTickets) * 100) : 0
    }))
  }, [tickets, totalTickets])

  const initials = userName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('') || 'ف'

  const workerName = (ticket: TicketItem) => {
    if (ticket.assigneeName) return ticket.assigneeName
    if (!ticket.assigned_to) return 'بانتظار فني'
    if (ticket.assigned_to === userId) return userName
    return names[ticket.assigned_to] || 'فني الدعم'
  }

  const similarSolved = useMemo(() => {
    if (!selectedTicket || !isActive(selectedTicket.status)) return []
    const solved = tickets.filter((ticket) => ticket.id !== selectedTicket.id && (ticket.status === 'منجزة' || ticket.status === 'مغلقة') && (ticket.resolution || '').trim().length >= 3)
    return rankSimilar(selectedTicket.title, solved, (ticket) => ticket.title, 3, 0.25)
  }, [selectedTicket, tickets])
  const raiserName = (ticket: TicketItem) => ticket.user_id ? (names[ticket.user_id] || 'موظف') : 'غير معروف'
  const raiserDept = (ticket: TicketItem) => ticket.user_id ? (departments[ticket.user_id] || 'غير محدد') : 'غير محدد'

  const goTickets = (nextFilter: 'الكل' | 'المنجزة والمغلقة' | (typeof STATUSES)[number] = 'الكل') => {
    setFilter(nextFilter)
    setActiveTab('البلاغات')
    setMenu(false)
  }

  if (!ready) return <main className="app-shell" style={{ minHeight: '100vh' }} aria-busy="true" />

  return (
    <main dir="rtl" className="app-shell">
      {menu && <button aria-label="إغلاق القائمة" className="mobile-scrim" onClick={() => setMenu(false)} />}
      <aside className={`sidebar ${menu ? 'sidebar-open' : ''}`} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        <div>
          <div className="brand">
            <div className="brand-mark"><SanadMark size={34} /></div>
            <div><strong>سند</strong><small>منصة الدعم الفني</small></div>
            <button className="icon-btn mobile-close" aria-label="إغلاق القائمة" onClick={() => setMenu(false)}><X /></button>
          </div>
          <div className="workspace">
            <div><span className="workspace-dot" /><span>بوابة فني الدعم</span></div>
          </div>
          <nav className="nav">
            <p>لوحة التحكم</p>
            <Nav icon={<LayoutDashboard />} label="نظرة عامة" active={activeTab === 'نظرة عامة'} onClick={() => { setActiveTab('نظرة عامة'); setMenu(false) }} />
            <Nav icon={<Bot />} label="اسأل سند" active={activeTab === 'اسأل سند'} onClick={() => { setActiveTab('اسأل سند'); setMenu(false) }} />
            <Nav icon={<Ticket />} label="البلاغات" badge={openCount.toString()} active={activeTab === 'البلاغات'} onClick={() => goTickets('الكل')} />
            <p className="nav-label">المتابعة</p>
            <Nav icon={<Wrench />} label="بلاغاتي" badge={myCount.toString()} active={activeTab === 'بلاغاتي'} onClick={() => { setActiveTab('بلاغاتي'); setMenu(false) }} />
            <Nav icon={<BarChart3 />} label="التحليلات" active={activeTab === 'التحليلات'} onClick={() => { setActiveTab('التحليلات'); setMenu(false) }} />
          </nav>
        </div>
        <div style={{ padding: '16px', borderTop: '1px solid var(--border)' }}>
          <button onClick={handleLogout} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: 'none', borderRadius: '10px', padding: '12px', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer' }}>
            <LogOut size={16} />
            <span>تسجيل الخروج</span>
          </button>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="فتح القائمة" onClick={() => setMenu(true)}><Menu /></button>
          <div className="breadcrumbs"><span>لوحة الفني</span> <b>/</b> <strong>{activeTab}</strong></div>
          <div className="top-actions">
            <div style={{ position: 'relative' }}>
              <button className="icon-btn" aria-label="التنبيهات" onClick={() => { const next = !showNotices; if (next) rememberNotices(userId, notices.map((item) => item.id)); setShowNotices(next) }} title="التنبيهات"><Bell /></button>
              {notices.length > 0 && <span style={{ position: 'absolute', top: 6, right: 6, width: 8, height: 8, background: '#ef4444', borderRadius: '50%' }} />}
              {showNotices && (
                <div style={{ position: 'absolute', left: 0, top: '46px', background: 'var(--surface)', border: `1px solid ${'var(--border)'}`, borderRadius: '12px', width: '280px', boxShadow: '0 10px 25px rgba(0,0,0,0.15)', zIndex: 100, padding: '12px' }}>
                  <strong style={{ display: 'block', fontSize: '13px', marginBottom: '8px' }}>البلاغات التي أعمل عليها</strong>
                  <DesktopNotifyStatus permission={notifyPermission} onEnable={requestNotify} />
                  {notices.length === 0 ? (
                    <div style={{ fontSize: '12px', color: '#94a3b8' }}>{alertsOn ? 'لا توجد بلاغات تعمل عليها حالياً.' : 'تنبيهات البوابة متوقفة من إعدادات النظام.'}</div>
                  ) : notices.map((notice) => (
                    <div key={notice.id} style={{ fontSize: '12px', padding: '8px', background: 'var(--field)', borderRadius: '6px', marginBottom: '6px' }}>{notice.message}</div>
                  ))}
                </div>
              )}
            </div>
            <button className="icon-btn" aria-label="المساعدة" onClick={() => setShowHelpModal(true)} title="معلومات النظام"><CircleHelp /></button>
            <button className="theme-toggle" aria-label="تبديل المظهر" onClick={toggle}>{dark ? <Sun /> : <Moon />}</button>
            <div style={{ position: 'relative' }}>
              <div className="top-avatar" onClick={() => setShowProfileMenu(!showProfileMenu)} style={{ cursor: 'pointer', userSelect: 'none' }} title="الحساب">{initials}</div>
              {showProfileMenu && (
                <div style={{ position: 'absolute', left: 0, top: '45px', background: 'var(--surface)', border: `1px solid ${'var(--border)'}`, borderRadius: '12px', boxShadow: '0 10px 25px rgba(0,0,0,0.15)', width: '220px', zIndex: 100, padding: '12px' }}>
                  <div style={{ paddingBottom: '10px', borderBottom: `1px solid ${'var(--border)'}`, marginBottom: '8px' }}>
                    <strong style={{ display: 'block', fontSize: '13px', color: 'var(--text)' }}>{userName}</strong>
                    {workerNumber && <small style={{ display: 'block', fontSize: '12px', color: '#94a3b8' }}>رقم الموظف: <b dir="ltr" style={{ color: '#7c3aed', fontWeight: 800 }}>{workerNumber}</b></small>}
                    <small dir="ltr" style={{ color: '#94a3b8', fontSize: '11px', wordBreak: 'break-all' }}>{userEmail}</small>
                  </div>
                  <button onClick={handleLogout} style={{ width: '100%', textAlign: 'right', background: 'transparent', border: 'none', color: '#ef4444', padding: '8px', fontSize: '13px', cursor: 'pointer', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}><LogOut size={14} /> تسجيل الخروج</button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="page-wrap">
          <div className="page-heading">
            <div>
              <p className="day-greeting" style={greetingStyle}>{greeting}، {userName}</p>
              <div className="eyebrow">بوابة فني الدعم</div>
              <h1>
                {activeTab === 'اسأل سند' ? 'اسأل سند' :
                  activeTab === 'البلاغات' ? 'البلاغات' :
                  activeTab === 'بلاغاتي' ? 'بلاغاتي' :
                  activeTab === 'التحليلات' ? 'تحليلات البلاغات' : 'نظرة عامة'}
              </h1>
              
            </div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
                حالتي
                <select aria-label="حالة الفني" value={availability} onChange={async (event) => {
                  const next = event.target.value as (typeof AVAILABILITY)[number]
                  const previous = availability
                  setAvailability(next)
                  const saved = await supabase.from('profiles').update({ availability: next }).eq('id', userId)
                  if (saved.error) { setAvailability(previous); setRefreshNotice('تعذّر حفظ حالتك: ' + saved.error.message) }
                  else setRefreshNotice(next === 'خارج الدوام' ? 'حالتك: خارج الدوام.' : `تم تحديث حالتك إلى: ${next}.`)
                }} style={{ background: availability === 'خارج الدوام' ? 'rgba(239, 68, 68, 0.1)' : 'transparent', color: 'inherit', border: '1px solid #c4b5fd', borderRadius: '8px', padding: '8px 10px' }}>
                  {AVAILABILITY.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <button className="primary-btn" onClick={() => fetchQueue()} disabled={isRefreshing} style={{ background: '#8b5cf6', color: '#fff' }}>
                <RefreshCw size={15} className={isRefreshing ? 'animate-spin' : ''} /> {isRefreshing ? 'جاري التحديث...' : 'تحديث البيانات'}
              </button>
              {refreshNotice && <p style={{ margin: '8px 0 0', fontSize: '12px', color: '#94a3b8' }}>{refreshNotice}</p>}
            </div>
          </div>

          {activeTab === 'اسأل سند' && (
            <>
              <div className="ask-sanad">
                <AiAssistant supabase={supabase} mode="technician" onTicketsChanged={() => { void fetchQueue(true) }} />
              </div>
              {userId && <AccountLog supabase={supabase} userId={userId} />}
            </>
          )}

          {activeTab === 'نظرة عامة' && (
            <>
              <div className="stats-grid">
                <Stat icon={<Ticket />} label="البلاغات المفتوحة" value={openCount.toString()} sub="بانتظار فني" onClick={() => goTickets('مفتوحة')} />
                <Stat icon={<Wrench />} label="بلاغاتي" value={myCount.toString()} sub="مُسندة إليك" onClick={() => { setActiveTab('بلاغاتي'); setMenu(false) }} />
                <Stat icon={<Check />} label="المنجزة والمغلقة" value={doneCount.toString()} sub="انتهى العمل عليها" onClick={() => goTickets('المنجزة والمغلقة')} />
                <Stat icon={<Activity />} label="إجمالي البلاغات" value={totalTickets.toString()} sub="كل البلاغات المسجلة" onClick={() => goTickets('الكل')} />
              </div>
              <div className="dashboard-grid">
                <section className="panel copilot">
                  <PanelHeader icon={<Wrench />} title="من أين تبدأ" action="" />
                  <div className="copilot-status">
                    <div className="ai-orb"><Ticket /></div>
                    <div>
                      <strong>{openCount > 0 ? 'توجد بلاغات في قائمة الانتظار' : 'لا توجد بلاغات في قائمة الانتظار'}</strong>
                      <p>{`البلاغات المفتوحة: ${openCount} (العاجلة منها: ${urgentOpen}). قيد المعالجة: ${progressCount}.`}</p>
                    </div>
                  </div>
                  {delayedCount > 0 && (
                    <div className="suggestion">
                      <div className="suggestion-icon" style={{ color: '#ef4444' }}><Info /></div>
                      <div>
                        <b style={{ color: '#ef4444' }}>البلاغات المتأخرة: {delayedCount}</b>
                        <p>مضى عليها أكثر من يوم دون أن يستلمها فني.</p>
                        <button className="text-btn" onClick={() => goTickets('مفتوحة')}>فتح البلاغات المفتوحة <ArrowDownLeft /></button>
                      </div>
                    </div>
                  )}
                  <div className="suggestion">
                    <div className="suggestion-icon"><Ticket /></div>
                    <div>
                      <b>ترتيب العمل</b>
                      <p>تعطل الأقسام أولاً، ثم العاجل، ثم الأقدم.</p>
                      <button className="text-btn" onClick={() => goTickets('مفتوحة')}>فتح قائمة الانتظار <ArrowDownLeft /></button>
                    </div>
                  </div>
                </section>
              </div>
            </>
          )}

          {activeTab === 'التحليلات' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <section className="panel">
                <PanelHeader icon={<BarChart3 />} title="نسبة كل حالة من البلاغات" action="" />
                <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {totalTickets > 0 ? statusStats.map((stat, index) => (
                    <ProgressBar key={stat.label} label={stat.label} value={stat.value} color={index % 2 === 0 ? '#8b5cf6' : '#10b981'} />
                  )) : (
                    <div style={{ textAlign: 'center', opacity: 0.6, padding: '20px' }}>لا توجد بلاغات بعد.</div>
                  )}
                </div>
              </section>
            </div>
          )}

          {activeTab === 'بلاغاتي' && (
            <section className="panel users-panel">
              <div className="users-header">
                <div>
                  <PanelHeader icon={<Wrench />} title="بلاغاتي" action="" />
                  <p>المُسندة إليك ولم تنتهِ.</p>
                </div>
                <TicketSearch number={ticketNoQuery} onNumber={setTicketNoQuery} text={query} onText={setQuery} textLabel="بحث في بلاغاتي" textPlaceholder="ابحث ضمن بلاغاتي" />
              </div>
              <TicketTable
                loading={loading}
                tickets={myTickets}
                names={names}
                numbers={staffNumbers}
                departments={departments}
                workerName={workerName}
                onOpen={openTicket}
                emptyText={query.trim() || ticketNoQuery.trim() ? 'لا توجد بلاغات مطابقة.' : 'لا توجد بلاغات مُسندة إليك حالياً.'}
              />
            </section>
          )}

          {activeTab === 'البلاغات' && (
            <section className="panel users-panel">
              <div className="users-header">
                <div>
                  <PanelHeader icon={<Ticket />} title="البلاغات" action="" />
                </div>
                <TicketSearch number={ticketNoQuery} onNumber={setTicketNoQuery} text={query} onText={setQuery} textLabel="بحث في البلاغات" textPlaceholder="ابحث في البلاغات..." />
              </div>
              <div className="tabs">
                {(['الكل', 'مفتوحة', 'قيد المعالجة', 'بانتظار الموظف', 'المنجزة والمغلقة'] as const).map((item) => (
                  <button key={item} type="button" onClick={() => setFilter(item)} className={filter === item ? 'tab-active' : ''}>{item}</button>
                ))}
              </div>
              <TicketTable loading={loading} tickets={visibleTickets} names={names} numbers={staffNumbers} departments={departments} workerName={workerName} onOpen={openTicket} emptyText={query.trim() || ticketNoQuery.trim() || filter !== 'الكل' ? 'لا توجد بلاغات مطابقة.' : 'لا توجد بلاغات مسجلة حالياً.'} />
            </section>
          )}
        </div>
      </section>

      {showHelpModal && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowHelpModal(false) }} style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--surface)', border: `1px solid ${'var(--border)'}`, borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: '420px', boxShadow: '0 25px 50px rgba(0,0,0,0.5)', color: 'var(--text)' }}>
            <div className="modal-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}><Info size={20} color="#8b5cf6" /> حول لوحة الفني</h3>
              <button onClick={() => setShowHelpModal(false)} aria-label="إغلاق" title="إغلاق" style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            <p style={{ color: '#94a3b8', fontSize: '14px', lineHeight: '1.6', margin: '0 0 1rem' }}>استلم البلاغ ليُسند إليك، واكتب الحل قبل إنجازه.</p>
            <div style={{ marginBottom: '1.5rem' }}><StatusLegend /></div>
            <button onClick={() => setShowHelpModal(false)} style={{ width: '100%', background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '8px', padding: '10px', fontWeight: '600', cursor: 'pointer' }}>إغلاق</button>
          </div>
        </div>
      )}

      {selectedTicket && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedTicket(null) }} style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}>
          <div style={{ background: 'var(--surface)', border: `1px solid ${'var(--border)'}`, borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: '640px', maxHeight: '85vh', overflowY: 'auto', color: 'var(--text)' }}>
            <div className="modal-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <div>
                <span className="ticket-no" style={{ ...ticketNoStyle, display: 'block', marginBottom: '4px' }}>{formatTicketNo(selectedTicket.ticket_number)}</span>
                <h3 style={{ fontSize: '18px', fontWeight: 'bold', margin: 0 }}>{selectedTicket.title}</h3>
              </div>
              <button onClick={() => setSelectedTicket(null)} aria-label="إغلاق" title="إغلاق" style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            <div style={{ display: 'flex', gap: '12px', marginBottom: '1rem', fontSize: '13px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ background: 'var(--field)', padding: '6px 12px', borderRadius: '8px' }}><b>مقدّم البلاغ:</b> {raiserName(selectedTicket)}</span>
              <span style={{ background: 'var(--field)', padding: '6px 12px', borderRadius: '8px' }}><b>رقم الموظف:</b> <span dir="ltr">{selectedTicket.user_id ? (staffNumbers[selectedTicket.user_id] || '—') : '—'}</span></span>
              <StatusBadge status={selectedTicket.status} />
              <span style={{ background: 'var(--field)', padding: '6px 12px', borderRadius: '8px' }}><b>يعمل عليها:</b> {workerName(selectedTicket)}</span>
              <span style={{ background: 'var(--field)', padding: '6px 12px', borderRadius: '8px' }}><b>الوقت:</b> {formatTicketWhen(selectedTicket.created_at)}</span>
              {asRating(selectedTicket.rating) !== null && <span style={{ background: 'var(--field)', padding: '6px 12px', borderRadius: '8px' }}><b>التقييم:</b> {asRating(selectedTicket.rating)}/5</span>}
            </div>
            {actionMsg && <p style={{ fontSize: '13px', margin: '0 0 10px', color: actionMsg.startsWith('تم') ? '#10b981' : '#ef4444' }}>{actionMsg}</p>}
            <TicketTools ticket={selectedTicket} actor="technician" userId={userId} technicians={[]} events={events} notes={notes} busy={savingStatus} resolutionDraft={resolutionDraft} onRun={async (action, payload) => {
              setSavingStatus(true)
              const result = await ticketAction(supabase, selectedTicket.id, action, payload)
              setSavingStatus(false)
              if (result.error) { setActionMsg(result.error); return }
              const { data: fresh } = await supabase.from('tickets').select('*').eq('id', selectedTicket.id).maybeSingle()
              if (fresh) {
                const meta = readTicketMeta(fresh.title)
                await openTicket({ ...(fresh as TicketItem), title: meta.problem, assigned_to: fresh.assigned_technician || null })
              }
              setActionMsg(action === 'claim' ? 'تم استلام البلاغ وإسناده إليك.' : action === 'note' ? 'تم حفظ الملاحظة.' : 'تم حفظ الإجراء.')
              fetchQueue(true)
            }} />
            {similarSolved.length > 0 && (
              <details className="fold" open style={{ border: '1px solid rgba(16, 185, 129, 0.35)', borderRadius: '10px', padding: '10px 12px', margin: '12px 0' }}>
                <summary>حلول بلاغات مشابهة ({similarSolved.length})</summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
                  {similarSolved.map((ticket) => (
                    <div key={ticket.id} style={{ background: 'var(--field)', borderRadius: '8px', padding: '8px 10px', fontSize: '12px', lineHeight: 1.7 }}>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span className="ticket-no" style={ticketNoStyle}>{formatTicketNo(ticket.ticket_number)}</span>
                        <b>{ticket.title}</b>
                        <span style={{ color: '#94a3b8' }}>{ticket.fault_type || ''} · {workerName(ticket)}</span>
                      </div>
                      <p style={{ margin: '4px 0 6px' }}><b style={{ color: '#059669' }}>الحل: </b>{ticket.resolution}</p>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {selectedTicket.assigned_to === userId && (
                          <button type="button" onClick={() => setResolutionDraft(ticket.resolution || '')} style={{ background: 'transparent', color: 'inherit', border: '1px solid #c4b5fd', borderRadius: '8px', padding: '4px 10px', cursor: 'pointer', fontSize: '12px' }}>نسخه إلى خانة الحل</button>
                        )}
                        <button type="button" onClick={() => setReplyText(ticket.resolution || '')} style={{ background: 'transparent', color: 'inherit', border: '1px solid #c4b5fd', borderRadius: '8px', padding: '4px 10px', cursor: 'pointer', fontSize: '12px' }}>استخدامه في الرد</button>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
            {selectedTicket.status !== 'مغلقة' && selectedTicket.status !== 'ملغاة' && (
              <AiAssistant key={selectedTicket.id} supabase={supabase} mode="technician" compact ticketId={selectedTicket.id} onTicketsChanged={() => { void fetchQueue(true); void openTicket(selectedTicket) }} />
            )}
            <div>
              <h4 style={{ fontSize: '14px', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '6px' }}><MessageSquare size={16} /> المحادثة</h4>
              <TicketConversation requester={raiserName(selectedTicket)} problem={selectedTicket.title} messages={ticketReplies} />
              {(selectedTicket.status === 'مغلقة' || selectedTicket.status === 'ملغاة') ? (
                <p style={{ fontSize: '12px', color: '#94a3b8', margin: 0 }}>البلاغ {statusLabel(selectedTicket.status)}، ولا يمكن إضافة ردود عليه.</p>
              ) : <>
              {templates.length > 0 && (
                <select aria-label="رد جاهز" value="" onChange={(event) => { if (event.target.value) setReplyText(event.target.value) }} style={{ marginBottom: '8px', background: 'var(--field)', color: 'inherit', width: '100%', border: '1px solid #c4b5fd', borderRadius: '8px', padding: '8px' }}>
                  <option value="">اختر رداً جاهزاً</option>
                  {templates.map((item) => <option key={item.id} value={item.body}>{item.body}</option>)}
                </select>
              )}
              <form onSubmit={handleSendReply} style={{ display: 'flex', gap: '8px' }}>
                <input aria-label="الرد" type="text" value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="اكتب ردك على الموظف..." style={{ flex: 1, background: 'var(--field)', border: `1px solid ${'var(--field-border)'}`, borderRadius: '10px', padding: '10px 12px', color: 'var(--text)', outline: 'none', fontSize: '13px' }} />
                <button type="submit" className="primary-btn" style={{ padding: '0 14px' }}><Send size={16} style={{ transform: 'rotate(180deg)' }} /></button>
              </form>
              </>}
            </div>
            <TicketHistory events={events} />
            <div style={{ marginTop: '1rem' }}><TicketFiles ticketId={selectedTicket.id} canUpload={selectedTicket.status !== 'ملغاة'} /></div>
          </div>
        </div>
      )}
    </main>
  )
}

function TicketTable({ loading, tickets, names, numbers, departments, workerName, onOpen, emptyText }: { loading: boolean; tickets: TicketItem[]; names: Record<string, string>; numbers?: Record<string, string>; departments?: Record<string, string>; workerName: (ticket: TicketItem) => string; onOpen: (ticket: TicketItem) => void; emptyText?: string }) {
  if (loading) return <div className="skeleton-list" aria-label="جاري التحميل">{[0, 1, 2, 3].map((item) => <div key={item} className="skeleton-row" />)}</div>
  if (tickets.length === 0) return <div className="empty-state">{emptyText || 'لا توجد بلاغات مسجلة حالياً.'}</div>
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>رقم البلاغ</th>
            <th>المشكلة</th>
            <th>مقدّم البلاغ</th>
            <th>نوع العطل</th>
            <th>يعمل عليها</th>
            <th>الحالة</th>
            <th>التاريخ والوقت</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => {
            const requester = ticket.user_id ? (names[ticket.user_id] || 'موظف') : 'غير معروف'
            const requesterDept = ticket.affected_department || (ticket.user_id ? (departments?.[ticket.user_id] || 'غير محدد') : 'غير محدد')
            const closed = ticket.status === 'منجزة' || ticket.status === 'مغلقة'
            const late = isDelayed(ticket)
            return (
              <tr key={ticket.id} onClick={() => onOpen(ticket)} style={{ cursor: 'pointer', background: late ? 'rgba(239, 68, 68, 0.06)' : undefined }}>
                <td><span className="ticket-no" style={ticketNoStyle}>{formatTicketNo(ticket.ticket_number)}</span></td>
                <td className="cell-wrap">
                  <b>{ticket.title}</b>
                  <span style={{ display: 'flex', gap: '6px', marginTop: '4px', fontSize: '11px', fontWeight: 700 }}>
                    {ticket.is_outage && <span style={{ color: '#b45309' }}>بلاغ قسم</span>}
                    {ticket.priority === 'عاجل' && <span style={{ color: '#ef4444' }}>عاجل</span>}
                    {ticket.is_private && <span style={{ color: '#64748b' }}>خاص</span>}
                    {late && <span style={{ color: '#ef4444' }}>متأخر</span>}
                  </span>
                </td>
                <td>
                  <div className="person">
                    <div className="avatar violet">{requester.slice(0, 2)}</div>
                    <div><b>{requester}</b>{ticket.user_id && numbers?.[ticket.user_id] && <small style={{ display: 'block', color: '#64748b', fontWeight: 600 }}>رقم الموظف: <b dir="ltr" style={{ color: '#7c3aed', fontWeight: 800 }}>{numbers[ticket.user_id]}</b></small>}<small>{requesterDept}</small></div>
                  </div>
                </td>
                <td>{ticket.fault_type || '—'}</td>
                <td>{workerName(ticket)}</td>
                <td><StatusBadge status={ticket.status} /></td>
                <td>{formatTicketWhen(ticket.created_at)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Nav({ icon, label, active, badge, onClick }: { icon: React.ReactNode; label: string; active?: boolean; badge?: string; onClick: () => void }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{badge && <em>{badge}</em>}</button>
}

function PanelHeader({ icon, title }: { icon: React.ReactNode; title: string; action?: string }) {
  return <div className="panel-header"><div className="panel-title"><span>{icon}</span><h2>{title}</h2></div></div>
}

function Stat({ icon, label, value, sub, onClick }: { icon: React.ReactNode; label: string; value: string; sub: string; onClick: () => void }) {
  return <button type="button" className="stat-card" onClick={onClick}><div className="stat-icon">{icon}</div><span className="stat-delta up">{sub}</span><small>{label}</small><strong>{value}</strong><span className="stat-caption">اضغط لفتح القائمة</span></button>
}

function ProgressBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}><span>{label}</span><b>{value}%</b></div>
      <div style={{ width: '100%', height: '8px', background: 'rgba(139, 92, 246, 0.1)', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', background: color, borderRadius: '4px' }} />
      </div>
    </div>
  )
}
