'use client'

import { useEffect, useMemo, useState, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'
import {
  Activity, AlertTriangle, ArrowDownLeft, Bot, Check, ChevronDown, CircleHelp, FileKey2, Gauge, Hash, LayoutDashboard, LogOut, Menu, Moon, MoreHorizontal, Search, Settings2, Sun, Ticket, Trash2, Users, X, UserPlus, Info, Edit3, Lock, Send, Save, Bell, Lightbulb, Shield, Sliders, BarChart3, PieChart, RefreshCw, MessageSquare
} from 'lucide-react'
import { AdminOwnerGate } from '@/components/admin-owner-gate'
import { SanadMark } from '@/components/sanad-mark'
import { TicketFiles } from '@/components/ticket-files'
import { TicketHistory, TicketTools } from '@/components/ticket-tools'
import { StatusBadge, StatusLegend } from '@/components/status-badge'
import { TicketConversation } from '@/components/ticket-conversation'
import { AiAssistant } from '@/components/ai-assistant'
import { KnowledgeEditor } from '@/components/knowledge-editor'
import { PerformancePanel } from '@/components/performance-panel'
import { ADMIN_PERMISSIONS, hasAdminPermission, normalizeAdminPermissions, permissionSummary } from '@/lib/admin-access'
import { DEPARTMENTS, statusLabel, TECH_DEPARTMENT, asRating, departmentLabel, formatTicketNo, formatTicketWhen, greetingStyle, isTechnicianRole, normalizeDigits, passwordError, roleLabel, storedDepartment, ticketNoStyle, ticketNumberMatches } from '@/lib/display'
import { useGreeting } from '@/lib/use-greeting'
import { loadTicketThread, readTicketMeta, sendTicketReply, subscribeTicketChanges, type ThreadMessage } from '@/lib/ticket-thread'
import { closeStale, downloadText, isActive, isDelayed, monthKey, sortTickets, ticketAction, ticketsToCsv } from '@/lib/workflow'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const supabase = createClient(supabaseUrl, supabaseAnonKey)

interface UserProfile {
  id: string
  full_name: string
  email: string
  username: string
  department: string
  role: string
  is_approved: boolean
  employee_number?: string
  temp_password?: string
  must_change_password?: boolean
  admin_permissions?: string[] | null
  availability?: string | null
}

interface TicketData {
  id: string
  title: string
  department: string
  status: string
  ai_resolved: boolean
  created_at?: string
  ticket_number?: number | null
  user_id?: string
  assigned_to?: string | null
  assigneeName?: string
  rating?: number
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

export default function Page() {
  const [dark, setDark] = useState(false)
  const [menu, setMenu] = useState(false)
  const [activeTab, setActiveTab] = useState('نظرة عامة')
  const [department, setDepartment] = useState('الكل')
  const [query, setQuery] = useState('')
  const [ticketQuery, setTicketQuery] = useState('')
  const [ticketNoQuery, setTicketNoQuery] = useState('')
  const [ticketStatus, setTicketStatus] = useState<'الكل' | 'مفتوحة' | 'متأخرة' | 'قيد المعالجة' | 'بانتظار الموظف' | 'المنجزة والمغلقة' | 'ملغاة'>('الكل')
  const [exportMonth, setExportMonth] = useState('')
  const [ticketActionMsg, setTicketActionMsg] = useState('')
  const [ticketActionBusy, setTicketActionBusy] = useState(false)
  const [settingsMsg, setSettingsMsg] = useState('')
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pendingDelete, setPendingDelete] = useState<UserProfile | null>(null)
  const [deleting, setDeleting] = useState(false)
  const showToast = (text: string, tone: 'ok' | 'error' = 'ok') => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ text, tone })
    toastTimer.current = setTimeout(() => setToast(null), 6000)
  }
  const [approvedOnly, setApprovedOnly] = useState(false)

  const [users, setUsers] = useState<UserProfile[]>([])
  const [tickets, setTickets] = useState<TicketData[]>([])
  const [auditLogs, setAuditLogs] = useState<Array<{ id: string; actor_name: string; action: string; target_name: string | null; detail: string | null; created_at: string }>>([])
  const [loading, setLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null)
  const [currentEmail, setCurrentEmail] = useState('')

  const [showAddModal, setShowAddModal] = useState(false)
  const [showHelpModal, setShowHelpModal] = useState(false)
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [showAlerts, setShowAlerts] = useState(false)
  const [statusEvents, setStatusEvents] = useState<Array<{ ticket_id: string; from_status: string | null; to_status: string | null; created_at: string }>>([])
  const [showEditModal, setShowEditModal] = useState(false)

  // التعديل
  const [editUserId, setEditUserId] = useState('')
  const [editFullName, setEditFullName] = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [editEmployeeNumber, setEditEmployeeNumber] = useState('')
  const [editPassword, setEditPassword] = useState('')
  const [editRole, setEditRole] = useState('user')
  const [editDepartment, setEditDepartment] = useState('')
  const [editing, setEditing] = useState(false)
  const [editError, setEditError] = useState('')

  // الإضافة
  const [newFullName, setNewFullName] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newEmployeeNumber, setNewEmployeeNumber] = useState('')
  const [newDepartment, setNewDepartment] = useState('')
  const [newRole, setNewRole] = useState('user')
  const [newPassword, setNewPassword] = useState('')
  const [adding, setAdding] = useState(false)
  const [modalError, setModalError] = useState('')
  const [grantTarget, setGrantTarget] = useState<'add' | 'edit' | null>(null)
  const [ownerUsername, setOwnerUsername] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')
  const [ownerVerified, setOwnerVerified] = useState(false)
  const [ownerError, setOwnerError] = useState('')
  const [ownerChecking, setOwnerChecking] = useState(false)
  const [pickedPermissions, setPickedPermissions] = useState<string[]>([])
  const [editOriginalRole, setEditOriginalRole] = useState('user')
  const [myPermissions, setMyPermissions] = useState<string[] | null>([])
  const [accessReady, setAccessReady] = useState(false)
  const COMPANY_DOMAIN = '@company.com'
  const allowed = (key: string) => accessReady && hasAdminPermission(myPermissions, key)

  // الإعدادات
  const [settingTab, setSettingTab] = useState('عام')
  const [companyName, setCompanyName] = useState('')
  const [departmentList, setDepartmentList] = useState<string[]>([...DEPARTMENTS])
  const [newDepartmentName, setNewDepartmentName] = useState('')
  const [ticketEvents, setTicketEvents] = useState<Array<{ id: string; actor_name: string; from_status: string | null; to_status: string | null; note?: string | null; created_at: string }>>([])
  const [ticketNotes, setTicketNotes] = useState<Array<{ id: string; author_name: string; body: string; created_at: string }>>([])
  const [sysSettings, setSysSettings] = useState({
    ai_enabled: true,
    email_alerts: true,
    auto_assign: true,
    strict_auth: false,
    force_password_change: true
  })
  const [savingSettings, setSavingSettings] = useState(false)
  const [adminName, setAdminName] = useState('مدير النظام')
  const [adminNumber, setAdminNumber] = useState('')
  const greeting = useGreeting()
  const [selectedTicket, setSelectedTicket] = useState<TicketData | null>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedTicket(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const openTicketId = useRef('')
  const [ticketThread, setTicketThread] = useState<ThreadMessage[]>([])
  const [ticketReply, setTicketReply] = useState('')
  const [ticketReplyError, setTicketReplyError] = useState('')


  useEffect(() => {
    openTicketId.current = selectedTicket?.id || ''
  }, [selectedTicket])

  const resetGrant = () => {
    setGrantTarget(null)
    setOwnerUsername('')
    setOwnerPassword('')
    setOwnerVerified(false)
    setOwnerError('')
    setPickedPermissions([])
  }

  const verifyOwnerAccount = async () => {
    setOwnerChecking(true)
    setOwnerError('')
    const session = await supabase.auth.getSession()
    const response = await fetch('/api/auth/owner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.data.session?.access_token || ''}` },
      body: JSON.stringify({ username: ownerUsername.trim(), password: ownerPassword })
    })
    const result = await response.json().catch(() => ({}))
    setOwnerChecking(false)
    if (!response.ok) {
      setOwnerVerified(false)
      setOwnerError(result.error || 'البريد أو اسم المستخدم أو كلمة المرور غير صحيحة.')
      return
    }
    setOwnerVerified(true)
  }

  const togglePermission = (key: string) => {
    setPickedPermissions((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])
  }

  const fetchAllData = async (silent = false) => {
    if (!silent) {
      setLoading(true)
      setIsRefreshing(true)
    }

    void closeStale(supabase)
    const loadedUsers = await supabase.from('profiles').select('id, full_name, email, username, department, role, is_approved, employee_number, must_change_password, admin_permissions, availability, created_at').order('full_name', { ascending: true })
    const usersData = loadedUsers.error
      ? (await supabase.from('profiles').select('id, full_name, email, username, department, role, is_approved, employee_number, must_change_password, created_at').order('full_name', { ascending: true })).data
      : loadedUsers.data
    if (usersData) {
      setUsers(usersData as UserProfile[])
      if (!newDepartment) setNewDepartment(DEPARTMENTS[1])
    }

    const { data: ticketsData } = await supabase.from('tickets').select('*')
    if (ticketsData) {
      setTickets(sortTickets((ticketsData as TicketData[]).map((ticket) => {
        const meta = readTicketMeta(ticket.title)
        const storedAssignee = (ticket as TicketData & { assigned_technician?: string | null }).assigned_technician
        return { ...ticket, title: meta.problem, assigned_to: storedAssignee || ticket.assigned_to || meta.assigneeId, assigneeName: meta.assigneeName }
      })))
    }

    const { data: eventRows } = await supabase.from('ticket_events').select('ticket_id, from_status, to_status, created_at').in('to_status', ['قيد المعالجة', 'مفتوحة'])
    if (eventRows) setStatusEvents(eventRows)
    const { data: settingsData } = await supabase.from('system_settings').select('*').eq('id', 'main_settings').maybeSingle()
    const { data: auditData } = await supabase.from('admin_audit').select('id, actor_name, action, target_name, detail, created_at').order('created_at', { ascending: false }).limit(30)
    if (auditData) setAuditLogs(auditData)
    if (settingsData) {
      if (settingsData.company_name) setCompanyName(settingsData.company_name)
      setSysSettings({
        ai_enabled: settingsData.ai_enabled ?? true,
        email_alerts: settingsData.email_alerts ?? true,
        auto_assign: settingsData.auto_assign ?? true,
        strict_auth: settingsData.strict_auth ?? false,
        force_password_change: settingsData.force_password_change !== false
      })
      if (Array.isArray(settingsData.departments) && settingsData.departments.length > 0) setDepartmentList(settingsData.departments)
    }
    if (!silent) {
      setLoading(false)
      setIsRefreshing(false)
    }
  }

  useEffect(() => {
    async function verifyAdminAccess() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        window.location.href = '/login'
        return
      }
      setCurrentEmail(session.user.email || '')
      const { data: profile } = await supabase.from('profiles').select('role, full_name, employee_number, admin_permissions, must_change_password').eq('id', session.user.id).single()
      if (profile?.must_change_password) {
        window.location.href = '/login'
        return
      }
      if (profile?.full_name) setAdminName(profile.full_name)
      if (profile?.employee_number) setAdminNumber(profile.employee_number)
      if (profile) {
        const permissions = normalizeAdminPermissions(profile.admin_permissions)
        setMyPermissions(permissions)
        const tabs: Array<[string, string]> = [
          ['نظرة عامة', 'overview'],
          ['البلاغات', 'tickets'],
          ['المستخدمون', 'users'],
          ['الاعتمادات', 'approvals'],
          ['التحليلات', 'analytics'],
          ['الإعدادات', 'settings']
        ]
        const first = tabs.find(([, key]) => hasAdminPermission(permissions, key))
        if (first) setActiveTab(first[0])
      }
      setAccessReady(true)
      if (!profile) {
        await supabase.auth.signOut()
        window.location.href = '/login'
        return
      }
      if (profile.role !== 'admin') {
        window.location.href = profile.role === 'technician' || profile.role === 'manager' ? '/technician' : '/employee'
        return
      }
      fetchAllData()
    }
    verifyAdminAccess()
    return subscribeTicketChanges(supabase, () => {
      fetchAllData(true)
      if (openTicketId.current) {
        loadTicketThread(supabase, openTicketId.current).then((thread) => setTicketThread(thread.messages))
      }
    })
  }, [])

  const saveSettings = async () => {
    setSavingSettings(true)
    const { error } = await supabase.from('system_settings').upsert({
      id: 'main_settings',
      company_name: companyName,
      departments: departmentList,
      ai_enabled: sysSettings.ai_enabled,
      email_alerts: sysSettings.email_alerts,
      auto_assign: sysSettings.auto_assign,
      strict_auth: sysSettings.strict_auth,
      force_password_change: sysSettings.force_password_change
    })
    setSavingSettings(false)
    setSettingsMsg(error ? 'تعذّر حفظ الإعدادات: ' + error.message : 'تم حفظ الإعدادات.')
  }

  const removeDepartment = (name: string) => {
    if (name === TECH_DEPARTMENT) return
    const members = users.filter((person) => departmentLabel(person.department) === name).length
    if (members > 0) {
      setSettingsMsg(`لا يمكن حذف قسم ${name} لارتباطه بحسابات (العدد: ${members}). انقل أصحابها إلى قسم آخر أولاً.`)
      return
    }
    setDepartmentList(departmentList.filter((department) => department !== name))
    setSettingsMsg(`حُذف قسم ${name} من القائمة. اضغط «حفظ التغييرات» لاعتماد الحذف.`)
  }

  const addDepartment = () => {
    const name = newDepartmentName.trim()
    setNewDepartmentName('')
    if (!name) return
    if (departmentList.some((department) => departmentLabel(department) === departmentLabel(name))) {
      setSettingsMsg(`قسم ${name} موجود مسبقاً.`)
      return
    }
    setDepartmentList([...departmentList, name])
    setSettingsMsg(`أُضيف قسم ${name}. اضغط «حفظ التغييرات» لاعتماد الإضافة.`)
  }

  const totalTickets = tickets.length
  const openTicketsCount = tickets.filter(t => t.status === 'مفتوحة').length
  const progressTicketsCount = tickets.filter(t => t.status === 'قيد المعالجة').length
  const delayedCount = tickets.filter((ticket) => isDelayed(ticket)).length
  const urgentActive = tickets.filter((ticket) => (ticket.priority === 'عاجل' || ticket.is_outage) && isActive(ticket.status)).length
  const adminAlerts = useMemo(() => tickets
    .filter((ticket) => isDelayed(ticket) || (isActive(ticket.status) && (ticket.is_outage || ticket.priority === 'عاجل')))
    .map((ticket) => ({
      ticket,
      reason: ticket.is_outage ? `تعطل قسم ${departmentLabel(ticket.affected_department)}` : isDelayed(ticket) ? 'متأخر: أكثر من يوم بدون فني' : 'عاجل'
    }))
    .slice(0, 10), [tickets])
  const deptStats = useMemo(() => {
    const counts: Record<string, number> = {}
    tickets.forEach(t => {
      const dept = departmentLabel(t.affected_department)
      counts[dept] = (counts[dept] || 0) + 1
    })
    return Object.keys(counts).map(key => ({
      label: key,
      value: totalTickets > 0 ? Math.round((counts[key] / totalTickets) * 100) : 0
    })).sort((a, b) => b.value - a.value)
  }, [tickets, totalTickets])

  const handleAddUser = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setModalError('')
    const cleanUsername = newUsername.trim().toLowerCase().replace(/[^a-z0-9._]/g, '')
    if (!cleanUsername) { setModalError('الرجاء إدخال اسم مستخدم صحيح.'); return }
    const weakPassword = passwordError(newPassword, sysSettings.strict_auth)
    if (weakPassword) { setModalError(weakPassword); return }
    const departmentResult = storedDepartment(newRole, isTechnicianRole(newRole) ? TECH_DEPARTMENT : newDepartment)
    if ('error' in departmentResult) { setModalError(departmentResult.error); return }
    const generatedEmail = cleanUsername + COMPANY_DOMAIN
    const employeeNumber = normalizeDigits(newEmployeeNumber).replace(/\D/g, '')
    if (!/^\d{9}$/.test(employeeNumber)) { setModalError('رقم الموظف يجب أن يكون 9 أرقام.'); return }
    const [{ data: sameEmail }, { data: sameNumber }] = await Promise.all([
      supabase.from('profiles').select('id').ilike('email', generatedEmail).maybeSingle(),
      supabase.from('profiles').select('id').eq('employee_number', employeeNumber).maybeSingle()
    ])
    if (sameEmail) { setModalError('هذا البريد مستخدم لحساب آخر.'); return }
    if (sameNumber) { setModalError('رقم الموظف مستخدم لحساب آخر.'); return }
    if (newRole === 'admin' && !ownerVerified) { setGrantTarget('add'); return }
    if (newRole === 'admin' && pickedPermissions.length === 0) {
      setModalError('اختر صلاحية واحدة على الأقل.')
      setGrantTarget('add')
      return
    }

    setAdding(true)
    const session = await supabase.auth.getSession()
    const response = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.data.session?.access_token || ''}` },
      body: JSON.stringify({
        fullName: newFullName.trim(),
        email: generatedEmail,
        username: cleanUsername,
        employeeNumber,
        department: departmentResult.department,
        role: newRole,
        password: newPassword,
        ownerUsername: ownerUsername.trim(),
        ownerPassword,
        permissions: pickedPermissions
      })
    })
    const result = await response.json().catch(() => ({ error: 'تعذر إنشاء الحساب.' }))
    if (!response.ok) setModalError(result.error || 'تعذر إنشاء حساب الدخول.')
    else {
      setShowAddModal(false)
      resetGrant()
      setNewFullName('')
      setNewUsername('')
      setNewEmployeeNumber('')
      setNewPassword('')
      setNewRole('user')
      fetchAllData()
      const waiting = result.approved === false ? ' الحساب بانتظار الاعتماد.' : ' يمكن لصاحبه الدخول الآن.'
      const created = result.employeeNumber ? `تم إنشاء الحساب. رقم الموظف: ${result.employeeNumber}.${waiting}` : `تم إنشاء الحساب.${waiting}`
      showToast(result.auditWarning ? `${created} ${result.auditWarning}` : created)
    }
    setAdding(false)
  }

  const openEditModal = (person: UserProfile) => {
    const nextRole = person.role === 'manager' ? 'technician' : person.role
    setEditUserId(person.id); setEditFullName(person.full_name); setEditEmail(person.email); setEditEmployeeNumber(person.employee_number || '');
    setEditPassword(''); setEditDepartment(isTechnicianRole(nextRole) ? TECH_DEPARTMENT : (departmentLabel(person.department) === 'غير محدد' ? DEPARTMENTS[0] : departmentLabel(person.department))); setEditRole(nextRole); setEditOriginalRole(nextRole); setEditError('');
    resetGrant()
    setShowEditModal(true); setActiveDropdown(null)
  }

  const handleUpdateUser = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setEditError('')
    const promoting = editRole === 'admin' && editOriginalRole !== 'admin'
    if (promoting && !ownerVerified) { setGrantTarget('edit'); return }
    if (promoting && pickedPermissions.length === 0) {
      setEditError('اختر صلاحية واحدة على الأقل.')
      setGrantTarget('edit')
      return
    }
    const departmentResult = storedDepartment(editRole, isTechnicianRole(editRole) ? TECH_DEPARTMENT : editDepartment)
    if ('error' in departmentResult) { setEditError(departmentResult.error); return }
    const employeeNumber = normalizeDigits(editEmployeeNumber).replace(/\D/g, '')
    if (!/^\d{9}$/.test(employeeNumber)) { setEditError('رقم الموظف يجب أن يكون 9 أرقام.'); return }
    const { data: sameNumber } = await supabase.from('profiles').select('id').eq('employee_number', employeeNumber).neq('id', editUserId).maybeSingle()
    if (sameNumber) { setEditError('رقم الموظف مستخدم لحساب آخر.'); return }
    setEditing(true)
    const nextPassword = editPassword.trim()
    const passwordChanged = nextPassword.length > 0
    if (passwordChanged) {
      const weakPassword = passwordError(nextPassword, sysSettings.strict_auth)
      if (weakPassword) { setEditError(weakPassword); setEditing(false); return }
    }
    if (promoting || passwordChanged) {
      const session = await supabase.auth.getSession()
      const response = await fetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.data.session?.access_token || ''}` },
        body: JSON.stringify({
          userId: editUserId,
          password: passwordChanged ? nextPassword : undefined,
          fullName: editFullName.trim(),
          department: departmentResult.department,
          role: promoting ? 'admin' : undefined,
          permissions: pickedPermissions,
          ownerUsername: ownerUsername.trim(),
          ownerPassword
        })
      })
      const result = await response.json().catch(() => ({ error: 'تعذر تحديث الحساب.' }))
      if (!response.ok) { setEditError(result.error || 'تعذر تحديث الحساب.'); setEditing(false); return }
    }
    const profilePatch = promoting
      ? { employee_number: employeeNumber }
      : { full_name: editFullName.trim(), department: departmentResult.department, role: editRole, employee_number: employeeNumber }
    const { error: profileError } = await supabase.from('profiles').update(profilePatch).eq('id', editUserId)
    if (profileError) {
      const message = profileError.message.includes('employee_number') ? 'رقم الموظف مستخدم لحساب آخر.' : profileError.message
      setEditError(message); setEditing(false); return
    }
    resetGrant()
    setShowEditModal(false); fetchAllData(); setEditing(false)
    showToast(passwordChanged ? 'تم تحديث البيانات وكلمة الدخول.' : 'تم تحديث البيانات.')
  }

  const toggleApproval = async (id: string, currentStatus: boolean) => {
    if (!allowed('approvals')) return
    const { error } = await supabase.from('profiles').update({ is_approved: !currentStatus }).eq('id', id)
    if (error) { showToast('تعذّر تغيير حالة الاعتماد: ' + error.message, 'error'); return }
    showToast(currentStatus ? 'تم إيقاف الحساب، ولن يتمكن صاحبه من الدخول.' : 'تم اعتماد الحساب، ويمكن لصاحبه الدخول الآن.')
    fetchAllData()
  }

  const deleteUser = async (id: string) => {
    setDeleting(true)
    const session = await supabase.auth.getSession()
    const response = await fetch('/api/users', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.data.session?.access_token || ''}` },
      body: JSON.stringify({ userId: id })
    })
    const result = await response.json().catch(() => ({ error: 'تعذر حذف المستخدم.' }))
    setDeleting(false)
    setPendingDelete(null)
    if (!response.ok) { showToast(result.error || 'تعذّر حذف المستخدم.', 'error'); return }
    showToast(result.auditWarning ? `تم حذف الحساب. ${result.auditWarning}` : 'تم حذف الحساب نهائياً.')
    fetchAllData(); setActiveDropdown(null)
  }

  const openAdminTicket = async (ticket: TicketData) => {
    if (selectedTicket?.id !== ticket.id) {
      setTicketEvents([])
      setTicketNotes([])
      setTicketThread([])
      setTicketReply('')
    }
    setSelectedTicket(ticket)
    setTicketActionMsg('')
    setTicketReplyError('')
    const [history, notes, thread] = await Promise.all([
      supabase.from('ticket_events').select('id, actor_name, from_status, to_status, note, created_at').eq('ticket_id', ticket.id).order('created_at', { ascending: true }),
      supabase.from('ticket_notes').select('id, author_name, body, created_at').eq('ticket_id', ticket.id).order('created_at', { ascending: true }),
      loadTicketThread(supabase, ticket.id)
    ])
    setTicketEvents(history.data || [])
    setTicketNotes(notes.data || [])
    setTicketThread(thread.messages)
    if (thread.error) setTicketReplyError(thread.error)
  }

  const handleAdminReply = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedTicket || !ticketReply.trim()) return
    const text = ticketReply.trim()
    setTicketReply('')
    setTicketReplyError('')
    const result = await sendTicketReply(supabase, selectedTicket.id, adminName, text)
    if (result.error) {
      setTicketReplyError(result.error)
      return
    }
    const thread = await loadTicketThread(supabase, selectedTicket.id)
    setTicketThread(thread.messages)
    if (thread.error) setTicketReplyError(thread.error)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  const dynamicDepartments = useMemo(() => {
    const deptsSet = new Set<string>(departmentList.map((item) => departmentLabel(item)))
    users.forEach((person) => {
      const deptName = departmentLabel(person.department)
      if (deptName !== 'غير محدد') deptsSet.add(deptName)
    })
    return ['الكل', ...Array.from(deptsSet)]
  }, [users, departmentList])

  const availableDepartmentsForAdd = useMemo(() => departmentList.map((item) => departmentLabel(item)).filter((item) => item !== TECH_DEPARTMENT), [departmentList])
  const editDepartmentOptions = useMemo(() => {
    const list = departmentList.map((item) => departmentLabel(item))
    return editDepartment && !list.includes(editDepartment) ? [...list, editDepartment] : list
  }, [departmentList, editDepartment])

  const filtered = useMemo(() => {
    return users.filter((person) => {
      const userDept = departmentLabel(person.department)
      const matchDept = department === 'الكل' || userDept === department
      if (activeTab === 'الاعتمادات' && person.is_approved !== false) return false
      if (approvedOnly && activeTab === 'المستخدمون' && !person.is_approved) return false
      const searchQuery = query.toLowerCase().trim()
      const roleName = roleLabel(person.role)
      const matchSearch = !searchQuery || normalizeDigits([person.full_name, person.email, person.username, person.employee_number, person.department, roleName].filter(Boolean).join(' ')).toLowerCase().includes(normalizeDigits(searchQuery))
      return matchDept && matchSearch
    })
    }, [users, department, query, activeTab, approvedOnly])

  const filteredTickets = useMemo(() => {
    const term = normalizeDigits(ticketQuery).trim().toLowerCase()
    const plainTerm = term.replace(/#/g, '')
    return tickets.filter((ticket) => {
      if (ticketStatus === 'مفتوحة' && ticket.status !== 'مفتوحة') return false
      if (ticketStatus === 'متأخرة' && !isDelayed(ticket)) return false
      if (ticketStatus === 'قيد المعالجة' && ticket.status !== 'قيد المعالجة') return false
      if (ticketStatus === 'بانتظار الموظف' && ticket.status !== 'بانتظار الموظف') return false
      if (ticketStatus === 'ملغاة' && ticket.status !== 'ملغاة') return false
      if (ticketStatus === 'المنجزة والمغلقة' && ticket.status !== 'منجزة' && ticket.status !== 'مغلقة') return false
      if (!ticketNumberMatches(ticket.ticket_number, ticketNoQuery)) return false
      if (plainTerm && /^\d+$/.test(plainTerm)) return ticketNumberMatches(ticket.ticket_number, plainTerm)
      if (!term) return true
      const requester = users.find((person) => person.id === ticket.user_id)
      const worker = users.find((person) => person.id === ticket.assigned_to)
      const text = normalizeDigits([ticket.title, ticket.status, ticket.fault_type, ticket.priority, ticket.affected_department, requester?.full_name, requester?.employee_number, requester?.department, ticket.assigneeName, worker?.full_name, worker?.employee_number].filter(Boolean).join(' ')).toLowerCase()
      return text.includes(term) || (plainTerm !== term && text.includes(plainTerm))
    })
  }, [tickets, users, ticketQuery, ticketNoQuery, ticketStatus])

  const approvedCount = users.filter((u) => u.is_approved).length
  const pendingCount = users.filter((u) => u.is_approved === false).length

  return (
    <main dir="rtl" className={dark ? 'app-shell dark' : 'app-shell'}>
      {menu && <button aria-label="إغلاق القائمة" className="mobile-scrim" onClick={() => setMenu(false)} />}
      <aside className={`sidebar ${menu ? 'sidebar-open' : ''}`} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        <div>
          <div className="brand">
            <div className="brand-mark"><SanadMark size={34} /></div>
            <div><strong>سند</strong><small>منصة الدعم الفني</small></div>
            <button className="icon-btn mobile-close" aria-label="إغلاق القائمة" onClick={() => setMenu(false)}><X /></button>
          </div>
          <div className="workspace">
            <div><span className="workspace-dot" /><span>{companyName || 'سند'}</span></div>
          </div>
          <nav className="nav">
            <p>لوحة التحكم</p>
            {allowed('overview') && <Nav icon={<LayoutDashboard />} label="نظرة عامة" active={activeTab === 'نظرة عامة'} onClick={() => {setActiveTab('نظرة عامة'); setMenu(false)}} />}
            {allowed('tickets') && <Nav icon={<Ticket />} label="البلاغات" active={activeTab === 'البلاغات'} onClick={() => { setTicketStatus('الكل'); setActiveTab('البلاغات'); setMenu(false) }} />}
            {allowed('users') && <Nav icon={<Users />} label="المستخدمون" badge={users.length.toString()} active={activeTab === 'المستخدمون'} onClick={() => { setApprovedOnly(false); setActiveTab('المستخدمون'); setMenu(false) }} />}
            {allowed('approvals') && <Nav icon={<FileKey2 />} label="الاعتمادات" badge={pendingCount.toString()} active={activeTab === 'الاعتمادات'} onClick={() => {setActiveTab('الاعتمادات'); setMenu(false)}} />}
            {(allowed('analytics') || allowed('settings')) && <p className="nav-label">الإدارة</p>}
            {allowed('analytics') && <Nav icon={<Gauge />} label="التحليلات" active={activeTab === 'التحليلات'} onClick={() => {setActiveTab('التحليلات'); setMenu(false)}} />}
            {allowed('settings') && <Nav icon={<Settings2 />} label="الإعدادات" active={activeTab === 'الإعدادات'} onClick={() => {setActiveTab('الإعدادات'); setMenu(false)}} />}
          </nav>
        </div>

        {/* زر تسجيل الخروج السفلي السريع */}
        <div style={{ padding: '16px', borderTop: `1px solid ${dark ? '#1e2230' : '#e2e8f0'}` }}>
          <button onClick={handleLogout} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: 'none', borderRadius: '10px', padding: '12px', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}>
            <LogOut size={16} />
            <span>تسجيل الخروج</span>
          </button>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="فتح القائمة" onClick={() => setMenu(true)}><Menu /></button>
          <div className="breadcrumbs"><span>لوحة الإدارة</span> <b>/</b> <strong>{activeTab}</strong></div>
          <div className="top-actions" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {allowed('tickets') && (
              <div style={{ position: 'relative' }}>
                <button className="icon-btn" aria-label="التنبيهات" title="التنبيهات" aria-expanded={showAlerts} onClick={() => { setShowAlerts(!showAlerts); setShowProfileMenu(false) }} style={{ position: 'relative' }}>
                  <Bell />
                  {adminAlerts.length > 0 && <span className="bell-count">{adminAlerts.length}</span>}
                </button>
                {showAlerts && (
                  <div className="alerts-menu">
                    <strong>يحتاج متابعتك</strong>
                    {adminAlerts.length === 0 ? (
                      <p className="alerts-empty">لا توجد بلاغات متأخرة أو عاجلة.</p>
                    ) : adminAlerts.map(({ ticket, reason }) => (
                      <button key={ticket.id} type="button" onClick={() => { setShowAlerts(false); openAdminTicket(ticket) }}>
                        <span className="ticket-no" style={ticketNoStyle}>{formatTicketNo(ticket.ticket_number)}</span>
                        <span className="alerts-title">{ticket.title}</span>
                        <small style={{ color: ticket.is_outage ? '#b45309' : '#ef4444' }}>{reason}</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button className="icon-btn" aria-label="المساعدة" onClick={() => setShowHelpModal(true)} title="معلومات النظام"><CircleHelp /></button>
            <button className="theme-toggle" aria-label="تبديل المظهر" onClick={() => setDark(!dark)}>{dark ? <Sun /> : <Moon />}</button>
            <div style={{ position: 'relative' }}>
              <div className="top-avatar" onClick={() => { setShowProfileMenu(!showProfileMenu); setShowAlerts(false) }} style={{ cursor: 'pointer', userSelect: 'none' }} title="إعدادات الحساب">{adminName.slice(0, 2)}</div>
              {showProfileMenu && (
                <div style={{ position: 'absolute', left: 0, top: '45px', background: dark ? '#13151f' : '#ffffff', border: `1px solid ${dark ? '#1e2230' : '#e2e8f0'}`, borderRadius: '12px', boxShadow: '0 10px 25px rgba(0,0,0,0.15)', width: '220px', zIndex: 100, padding: '12px' }}>
                  <div style={{ paddingBottom: '10px', borderBottom: `1px solid ${dark ? '#1e2230' : '#e2e8f0'}`, marginBottom: '8px' }}>
                    <strong style={{ display: 'block', fontSize: '13px', color: dark ? '#fff' : '#0f172a' }}>{adminName}</strong>
                    {adminNumber && <small dir="ltr" style={{ display: 'block', color: '#7c3aed', fontSize: '12px', fontWeight: 800 }}>{adminNumber}</small>}
                    <small dir="ltr" style={{ color: '#94a3b8', fontSize: '11px', wordBreak: 'break-all' }}>{currentEmail}</small>
                  </div>
                  {allowed('settings') && <button onClick={() => { setShowProfileMenu(false); setActiveTab('الإعدادات'); }} style={{ width: '100%', textAlign: 'right', background: 'transparent', border: 'none', color: dark ? '#cbd5e1' : '#334155', padding: '8px', fontSize: '13px', cursor: 'pointer', borderRadius: '6px' }}><Settings2 size={14} style={{ display: 'inline', marginLeft: 6 }} /> إعدادات النظام</button>}
                  <button onClick={handleLogout} style={{ width: '100%', textAlign: 'right', background: 'transparent', border: 'none', color: '#ef4444', padding: '8px', fontSize: '13px', cursor: 'pointer', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}><LogOut size={14} /> تسجيل الخروج</button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="page-wrap">
          <div className="page-heading">
            <div>
              <p className="day-greeting" style={greetingStyle}>{greeting}، {adminName}</p>
              <div className="eyebrow">لوحة مدير النظام</div>
              <h1>
                {activeTab === 'التحليلات' ? 'تحليلات البلاغات' :
                 activeTab === 'الإعدادات' ? 'إعدادات النظام' :
                 activeTab === 'البلاغات' ? 'البلاغات' :
                 activeTab === 'المستخدمون' ? 'المستخدمون' :
                 activeTab === 'الاعتمادات' ? 'الاعتمادات' : 'نظرة عامة'}
              </h1>
              <p>{activeTab === 'التحليلات' ? 'سرعة الاستلام والحل، وأداء الفنيين، ونسب البلاغات.' : activeTab === 'الإعدادات' ? 'إعدادات النظام، والحلول السريعة، والردود الجاهزة، والأمان.' : 'متابعة البلاغات والحسابات.'}</p>
            </div>
            {(activeTab === 'نظرة عامة' || activeTab === 'المستخدمون' || activeTab === 'الاعتمادات') && (
              <div style={{ display: 'flex', gap: '10px' }}>
                {allowed('users') && <button className="primary-btn" onClick={() => { resetGrant(); setModalError(''); setShowAddModal(true) }}><UserPlus size={16} /> إضافة مستخدم</button>}
                <button className="primary-btn" onClick={() => fetchAllData()} disabled={isRefreshing} style={{ background: '#8b5cf6', color: '#fff', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <RefreshCw size={15} className={isRefreshing ? 'animate-spin' : ''} /> {isRefreshing ? 'جاري التحديث...' : 'تحديث البيانات'}
                </button>
              </div>
            )}
            {activeTab === 'الإعدادات' && allowed('settings') && settingTab !== 'الحلول' && settingTab !== 'الردود' && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
                <button className="primary-btn" onClick={saveSettings} disabled={savingSettings}>{savingSettings ? 'جاري الحفظ...' : <><Save size={16} /> حفظ التغييرات</>}</button>
                {settingsMsg && <small style={{ color: settingsMsg.startsWith('تعذر') || settingsMsg.startsWith('لا ') ? '#ef4444' : '#10b981', fontSize: '12px' }}>{settingsMsg}</small>}
              </div>
            )}
          </div>

          {/* ----- (نظرة عامة) ----- */}
          {activeTab === 'نظرة عامة' && allowed('overview') && (
            <>
              <div className="stats-grid">
                <Stat icon={<Ticket />} label="البلاغات المفتوحة" value={openTicketsCount.toString()} sub="بانتظار فني" onClick={() => { setTicketStatus('مفتوحة'); setActiveTab('البلاغات'); setMenu(false) }} />
                <Stat icon={<Activity />} label="قيد المعالجة" value={progressTicketsCount.toString()} sub="فني يعمل عليها" onClick={() => { setTicketStatus('قيد المعالجة'); setActiveTab('البلاغات'); setMenu(false) }} />
                <Stat icon={<Users />} label="المستخدمون المعتمدون" value={approvedCount.toString()} sub="يمكنهم الدخول" onClick={() => { setApprovedOnly(true); setActiveTab('المستخدمون'); setMenu(false) }} />
                <Stat icon={<Check />} label="إجمالي البلاغات" value={totalTickets.toString()} sub="كل البلاغات المسجلة" onClick={() => { setTicketStatus('الكل'); setActiveTab('البلاغات'); setMenu(false) }} />
              </div>
              <div className="dashboard-grid">
                <section className="panel copilot">
                  <PanelHeader icon={<FileKey2 />} title="حسابات بانتظار الاعتماد" action="" />
                  <div className="suggestion">
                    <div className="suggestion-icon"><AlertTriangle /></div>
                    <div><b>قبل أن يدخل الحساب</b><p>{pendingCount > 0 ? `عدد الحسابات التي لا تستطيع الدخول قبل الاعتماد: ${pendingCount}.` : 'لا توجد حسابات بانتظار الاعتماد.'}</p>{allowed('approvals') && pendingCount > 0 && <button className="text-btn" onClick={() => setActiveTab('الاعتمادات')}>مراجعة الطلبات المعلقة <ArrowDownLeft /></button>}</div>
                  </div>
                </section>
                {allowed('tickets') && (
                  <section className="panel copilot">
                    <PanelHeader icon={<AlertTriangle />} title="ما يحتاج تدخلك" action="" />
                    <div className="suggestion">
                      <div className="suggestion-icon" style={{ color: delayedCount > 0 ? '#ef4444' : undefined }}><AlertTriangle /></div>
                      <div><b>بلاغات متأخرة</b><p>{delayedCount > 0 ? `عدد البلاغات المفتوحة منذ أكثر من يوم دون فني: ${delayedCount}. عيّن لها فنيين.` : 'لا توجد بلاغات متأخرة.'}</p>{delayedCount > 0 && <button className="text-btn" onClick={() => { setTicketStatus('متأخرة'); setActiveTab('البلاغات') }}>عرض المتأخرة <ArrowDownLeft /></button>}</div>
                    </div>
                    <div className="suggestion">
                      <div className="suggestion-icon"><Ticket /></div>
                      <div><b>البلاغات العاجلة وبلاغات تعطل الأقسام</b><p>{urgentActive > 0 ? `عدد البلاغات العاجلة غير المنتهية: ${urgentActive}.` : 'لا توجد بلاغات عاجلة نشطة.'}</p>{urgentActive > 0 && <button className="text-btn" onClick={() => { setTicketStatus('الكل'); setActiveTab('البلاغات') }}>فتح البلاغات <ArrowDownLeft /></button>}</div>
                    </div>
                  </section>
                )}
              </div>
              <div style={{ marginTop: '20px' }}><AiAssistant supabase={supabase} mode="admin" /></div>
            </>
          )}

          {/* ----- (التحليلات) ----- */}
          {activeTab === 'التحليلات' && allowed('analytics') && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <PerformancePanel tickets={tickets} events={statusEvents} technicians={users.filter((person) => isTechnicianRole(person.role)).map((person) => ({ id: person.id, full_name: person.full_name }))} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '20px' }}>
                <section className="panel">
                  <PanelHeader icon={<PieChart />} title="البلاغات حسب قسم صاحبها" action="" />
                  <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {deptStats.length > 0 ? deptStats.map((stat, i) => (
                      <ProgressBar key={i} label={stat.label} value={stat.value} color={i % 2 === 0 ? '#8b5cf6' : '#10b981'} />
                    )) : (
                      <div style={{ textAlign: 'center', opacity: 0.6, padding: '20px' }}>لا توجد بلاغات بعد.</div>
                    )}
                  </div>
                </section>
                
                <section className="panel">
                  <PanelHeader icon={<BarChart3 />} title="البلاغات حسب الحالة" action="" />
                  <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <ProgressBar label="مفتوحة" value={totalTickets ? Math.round((openTicketsCount / totalTickets) * 100) : 0} color="#f59e0b" />
                    <ProgressBar label="قيد المعالجة" value={totalTickets ? Math.round((progressTicketsCount / totalTickets) * 100) : 0} color="#3b82f6" />
                    <ProgressBar label="بانتظار الموظف" value={totalTickets ? Math.round((tickets.filter(t => t.status === 'بانتظار الموظف').length / totalTickets) * 100) : 0} color="#a855f7" />
                    <ProgressBar label="منجزة" value={totalTickets ? Math.round((tickets.filter(t => t.status === 'منجزة').length / totalTickets) * 100) : 0} color="#10b981" />
                    <ProgressBar label="مغلقة" value={totalTickets ? Math.round((tickets.filter(t => t.status === 'مغلقة').length / totalTickets) * 100) : 0} color="#64748b" />
                    <ProgressBar label="ملغاة" value={totalTickets ? Math.round((tickets.filter(t => t.status === 'ملغاة').length / totalTickets) * 100) : 0} color="#94a3b8" />
                  </div>
                </section>
              </div>
            </div>
          )}

          {/* ----- (الإعدادات) ----- */}
          {activeTab === 'الإعدادات' && allowed('settings') && (
            <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start' }}>
              <div style={{ background: dark ? '#13151f' : '#ffffff', border: `1px solid ${dark ? '#1e2230' : '#e2e8f0'}`, borderRadius: '16px', width: '250px', overflow: 'hidden' }}>
                <button onClick={() => setSettingTab('عام')} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '16px', background: settingTab === 'عام' ? (dark ? '#1a1d2d' : '#f8fafc') : 'transparent', border: 'none', borderRight: settingTab === 'عام' ? '3px solid #8b5cf6' : '3px solid transparent', color: settingTab === 'عام' ? (dark ? '#fff' : '#0f172a') : '#94a3b8', cursor: 'pointer', textAlign: 'right', fontWeight: settingTab === 'عام' ? 'bold' : 'normal' }}><Sliders size={18} /> إعدادات النظام</button>
                <button onClick={() => setSettingTab('المساعد')} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '16px', background: settingTab === 'المساعد' ? (dark ? '#1a1d2d' : '#f8fafc') : 'transparent', border: 'none', borderRight: settingTab === 'المساعد' ? '3px solid #8b5cf6' : '3px solid transparent', color: settingTab === 'المساعد' ? (dark ? '#fff' : '#0f172a') : '#94a3b8', cursor: 'pointer', textAlign: 'right', fontWeight: settingTab === 'المساعد' ? 'bold' : 'normal' }}><Bot size={18} /> المساعد الذكي</button>
                <button onClick={() => setSettingTab('الحلول')} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '16px', background: settingTab === 'الحلول' ? (dark ? '#1a1d2d' : '#f8fafc') : 'transparent', border: 'none', borderRight: settingTab === 'الحلول' ? '3px solid #8b5cf6' : '3px solid transparent', color: settingTab === 'الحلول' ? (dark ? '#fff' : '#0f172a') : '#94a3b8', cursor: 'pointer', textAlign: 'right', fontWeight: settingTab === 'الحلول' ? 'bold' : 'normal' }}><Lightbulb size={18} /> الحلول السريعة</button>
                <button onClick={() => setSettingTab('الردود')} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '16px', background: settingTab === 'الردود' ? (dark ? '#1a1d2d' : '#f8fafc') : 'transparent', border: 'none', borderRight: settingTab === 'الردود' ? '3px solid #8b5cf6' : '3px solid transparent', color: settingTab === 'الردود' ? (dark ? '#fff' : '#0f172a') : '#94a3b8', cursor: 'pointer', textAlign: 'right', fontWeight: settingTab === 'الردود' ? 'bold' : 'normal' }}><MessageSquare size={18} /> الردود الجاهزة</button>
                <button onClick={() => setSettingTab('إشعارات')} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '16px', background: settingTab === 'إشعارات' ? (dark ? '#1a1d2d' : '#f8fafc') : 'transparent', border: 'none', borderRight: settingTab === 'إشعارات' ? '3px solid #8b5cf6' : '3px solid transparent', color: settingTab === 'إشعارات' ? (dark ? '#fff' : '#0f172a') : '#94a3b8', cursor: 'pointer', textAlign: 'right', fontWeight: settingTab === 'إشعارات' ? 'bold' : 'normal' }}><Bell size={18} /> الإشعارات والتنبيهات</button>
                <button onClick={() => setSettingTab('أمان')} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '16px', background: settingTab === 'أمان' ? (dark ? '#1a1d2d' : '#f8fafc') : 'transparent', border: 'none', borderRight: settingTab === 'أمان' ? '3px solid #8b5cf6' : '3px solid transparent', color: settingTab === 'أمان' ? (dark ? '#fff' : '#0f172a') : '#94a3b8', cursor: 'pointer', textAlign: 'right', fontWeight: settingTab === 'أمان' ? 'bold' : 'normal' }}><Shield size={18} /> الأمان والصلاحيات</button>
              </div>

              <div style={{ flex: 1, background: dark ? '#13151f' : '#ffffff', border: `1px solid ${dark ? '#1e2230' : '#e2e8f0'}`, borderRadius: '16px', padding: '2rem' }}>
                <h2 style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '1.5rem', borderBottom: `1px solid ${dark ? '#1e2230' : '#e2e8f0'}`, paddingBottom: '1rem', color: dark ? '#fff' : '#0f172a' }}>
                  {settingTab === 'عام' ? 'إعدادات النظام العامة' : settingTab === 'المساعد' ? 'المساعد الذكي' : settingTab === 'الحلول' ? 'الحلول السريعة' : settingTab === 'الردود' ? 'الردود الجاهزة' : settingTab === 'إشعارات' ? 'إعدادات التنبيهات' : 'الأمان والوصول'}
                </h2>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  {settingTab === 'عام' && (
                    <>
                      <div>
                        <label htmlFor="company-name" style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: dark ? '#cbd5e1' : '#334155', fontWeight: '500' }}>اسم الجهة</label>
                        <input id="company-name" type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)} style={{ width: '100%', background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '8px', padding: '10px', color: dark ? '#fff' : '#0f172a', outline: 'none' }} />
                      </div>
                      <ToggleOption label="اقتراح نوع العطل من نص البلاغ" desc="يقترح نوع العطل من وصف المشكلة، ويمكن للموظف تغييره." checked={sysSettings.auto_assign} onChange={() => setSysSettings({...sysSettings, auto_assign: !sysSettings.auto_assign})} dark={dark} />
                      <div>
                        <div style={{ fontSize: '13px', marginBottom: '6px' }}>الأقسام</div>
                                                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
                          {departmentList.map((item) => (
                            <button key={item} type="button" title={item === TECH_DEPARTMENT ? 'قسم الفنيين، لا يُحذف' : 'حذف القسم'} onClick={() => removeDepartment(item)} style={{ border: '1px solid #c4b5fd', borderRadius: '8px', background: 'transparent', color: 'inherit', padding: '6px 10px', cursor: item === TECH_DEPARTMENT ? 'default' : 'pointer' }}>{item}{item === TECH_DEPARTMENT ? '' : ' ×'}</button>
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <input aria-label="اسم القسم الجديد" value={newDepartmentName} onChange={(event) => setNewDepartmentName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addDepartment() } }} placeholder="قسم جديد" style={{ flex: 1, background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '8px', padding: '10px', color: dark ? '#fff' : '#0f172a' }} />
                          <button type="button" onClick={addDepartment} style={{ background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '8px', padding: '0 12px', cursor: 'pointer' }}>إضافة</button>
                        </div>
                        <small style={{ color: '#94a3b8' }}>لا يُحذف قسم فيه حسابات.</small>
                      </div>
                    </>
                  )}

                  {settingTab === 'المساعد' && (
                    <>
                      <ToggleOption label="تشغيل المساعد الذكي" desc="يقترح حلولاً للموظفين والفنيين قبل فتح البلاغ." checked={sysSettings.ai_enabled} onChange={() => setSysSettings({...sysSettings, ai_enabled: !sysSettings.ai_enabled})} dark={dark} />
                      <AiAssistant supabase={supabase} mode="admin" />
                    </>
                  )}

                  {settingTab === 'الحلول' && (
                    <>
                      <p style={{ margin: 0, fontSize: '13px', color: '#94a3b8', lineHeight: 1.7 }}>تظهر للموظف عند كتابة بلاغ يشبهها، ويعتمد عليها المساعد الذكي. تُحفظ مباشرة.</p>
                      <KnowledgeEditor supabase={supabase} kind="faq" />
                    </>
                  )}

                  {settingTab === 'الردود' && (
                    <>
                      <p style={{ margin: 0, fontSize: '13px', color: '#94a3b8', lineHeight: 1.7 }}>يختارها الفني عند الرد على البلاغ. تُحفظ مباشرة.</p>
                      <KnowledgeEditor supabase={supabase} kind="templates" />
                    </>
                  )}

                  {settingTab === 'إشعارات' && (
                    <>
                      <ToggleOption label="تنبيهات داخل البوابة" desc="تنبيهات الحالة والردود في الجرس، بدون بريد." checked={sysSettings.email_alerts} onChange={() => setSysSettings({...sysSettings, email_alerts: !sysSettings.email_alerts})} dark={dark} />
                    </>
                  )}

                  {settingTab === 'أمان' && (
                    <>
                      <ToggleOption label="إجبار تغيير كلمة المرور عند أول تسجيل دخول" desc="عند أول دخول للمستخدم الجديد." checked={sysSettings.force_password_change} onChange={() => setSysSettings({...sysSettings, force_password_change: !sysSettings.force_password_change})} dark={dark} />
                      <ToggleOption label="كلمة مرور أقوى" desc="8 أحرف على الأقل، فيها حرف ورقم." checked={sysSettings.strict_auth} onChange={() => setSysSettings({...sysSettings, strict_auth: !sysSettings.strict_auth})} dark={dark} />
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ----- (المستخدمون والاعتمادات) ----- */}
          {((activeTab === 'المستخدمون' && allowed('users')) || (activeTab === 'الاعتمادات' && allowed('approvals'))) && (<>
            <section className="panel users-panel">
              <div className="users-header">
                <div>
                  <PanelHeader icon={<Users />} title={activeTab === 'الاعتمادات' ? 'طلبات الاعتماد' : 'إدارة المستخدمين'} action="" />
                  <p>{activeTab === 'الاعتمادات' ? 'الحسابات التي تنتظر موافقة المدير.' : approvedOnly ? 'الحسابات المعتمدة التي تستطيع الدخول.' : 'قائمة المستخدمين المسجلين وصلاحياتهم.'}</p>
                </div>
                <div className="table-actions">
                  <div className="search-box">
                    <Search />
                    <input aria-label="بحث في المستخدمين" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="بحث: الاسم، رقم الموظف، البريد، القسم..." />
                  </div>
                </div>
              </div>
              <div className="tabs">
                {dynamicDepartments.map((item) => (
                  <button key={item} onClick={() => setDepartment(item)} className={department === item ? 'tab-active' : ''}>{item}</button>
                ))}
              </div>
              <div className="table-scroll">
                {loading ? (
                  <div className="skeleton-list" aria-label="جاري التحميل">{[0, 1, 2, 3].map((item) => <div key={item} className="skeleton-row" />)}</div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>المستخدم</th>
                        <th>القسم</th>
                        <th>الدور</th>
                        <th>الحالة</th>
                        <th>الموافقة</th>
                        <th>الإجراء</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((person) => {
                        const isAct = person.is_approved
                        const roleName = roleLabel(person.role)
                        return (
                          <tr key={person.id} style={{ position: 'relative' }}>
                            <td>
                              <div className="person">
                                <div className="avatar violet">{person.full_name ? person.full_name.slice(0, 2) : 'م'}</div>
                                <div><b>{person.full_name}</b><small dir="ltr" style={{ display: 'block', color: '#7c3aed', fontWeight: 800 }}>{person.employee_number || '—'}</small><small dir="ltr" style={{ color: 'var(--text-muted)' }}>{person.email}</small></div>
                              </div>
                            </td>
                            <td>{departmentLabel(person.department)}</td>
                            <td>{roleName}{person.role === 'admin' && <small style={{ display: 'block', color: '#64748b', fontSize: '11px', lineHeight: 1.5 }}>{permissionSummary(person.admin_permissions)}</small>}</td>
                            <td><span className={`status ${isAct ? 'active' : 'pending'}`}><i />{isAct ? 'معتمد' : 'بانتظار الاعتماد'}</span></td>
                            <td><button aria-label="تبديل" className={`switch ${isAct ? 'on' : ''}`} onClick={() => toggleApproval(person.id, isAct)} disabled={!allowed('approvals')} style={{ opacity: allowed('approvals') ? 1 : 0.4 }}><span /></button></td>
                            <td style={{ position: 'relative' }}>
                              <button className="more-btn" onClick={() => setActiveDropdown(activeDropdown === person.id ? null : person.id)}><MoreHorizontal /></button>
                              {activeDropdown === person.id && (
                                <div style={{ position: 'absolute', left: '20px', top: '40px', background: dark ? '#1e1e2d' : '#ffffff', border: `1px solid ${dark ? '#333' : '#cbd5e1'}`, borderRadius: '8px', zIndex: 50, padding: '4px', minWidth: '150px', display: 'flex', flexDirection: 'column', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
                                  {allowed('users') && <button onClick={() => openEditModal(person)} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', background: 'transparent', border: 'none', color: dark ? '#cbd5e1' : '#334155', cursor: 'pointer', fontSize: '13px', textAlign: 'right' }}>
                                    <Edit3 size={14} /> تعديل البيانات
                                  </button>}
                                  {allowed('delete_users') && <button onClick={() => { setPendingDelete(person); setActiveDropdown(null) }} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '13px', textAlign: 'right' }}>
                                    <Trash2 size={14} /> حذف الحساب
                                  </button>}
                                </div>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
            {activeTab === 'المستخدمون' && allowed('users') && (
              <section className="panel" style={{ marginTop: '16px' }}>
                <PanelHeader icon={<Shield />} title="سجل العمليات" action="" />
                <p>إنشاء الحسابات وحذفها وتعديل الصلاحيات.</p>
                {auditLogs.length === 0 ? (
                  <div style={{ padding: '12px 0', color: '#94a3b8', fontSize: '13px' }}>لا توجد عمليات مسجلة بعد.</div>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>العملية</th>
                          <th>الحساب</th>
                          <th>بواسطة</th>
                          <th>التفاصيل</th>
                          <th>الوقت</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auditLogs.map((row) => (
                          <tr key={row.id}>
                            <td>{row.action}</td>
                            <td>{row.target_name || '—'}</td>
                            <td>{row.actor_name}</td>
                            <td className="cell-wrap">{row.detail || '—'}</td>
                            <td>{formatTicketWhen(row.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}
          </>)}

          {activeTab === 'البلاغات' && allowed('tickets') && (
            <section className="panel users-panel">
              <div className="users-header">
                <div>
                  <PanelHeader icon={<Ticket />} title="البلاغات" action="" />
                  <p>{ticketStatus === 'الكل' ? 'كل بلاغات الموظفين.' : `البلاغات المعروضة: ${ticketStatus}.`}</p>
                </div>
                <div className="table-actions">
                  <div className="search-box ticket-no-search">
                    <Hash />
                    <input value={ticketNoQuery} onChange={(event) => setTicketNoQuery(event.target.value)} inputMode="numeric" placeholder="رقم البلاغ" aria-label="بحث برقم البلاغ" />
                  </div>
                  <div className="search-box">
                    <Search />
                    <input aria-label="بحث في البلاغات" value={ticketQuery} onChange={(event) => setTicketQuery(event.target.value)} placeholder="ابحث في البلاغات..." />
                  </div>
                </div>
              </div>
              <div className="tabs">
                {(['الكل', 'مفتوحة', 'متأخرة', 'قيد المعالجة', 'بانتظار الموظف', 'المنجزة والمغلقة', 'ملغاة'] as const).map((item) => (
                  <button key={item} type="button" onClick={() => setTicketStatus(item)} className={ticketStatus === item ? 'tab-active' : ''}>{item}{item === 'متأخرة' && delayedCount > 0 ? ` (${delayedCount})` : ''}</button>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', margin: '0 0 12px', fontSize: '13px' }}>
                <span>تصدير بلاغات شهر:</span>
                <input aria-label="شهر التصدير" type="month" value={exportMonth} onChange={(event) => setExportMonth(event.target.value)} style={{ background: dark ? '#1a1d2d' : '#f8fafc', color: 'inherit', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '8px', padding: '6px 8px' }} />
                <button type="button" className="secondary-btn" onClick={() => {
                  const month = exportMonth || monthKey(new Date().toISOString())
                  const rows = tickets.filter((ticket) => monthKey(ticket.created_at) === month)
                  if (rows.length === 0) { setTicketActionMsg(`لا توجد بلاغات في ${month}.`); return }
                  setTicketActionMsg(`تم تصدير بلاغات ${month}، وعددها ${rows.length}.`)
                  downloadText(`sanad-tickets-${month}.csv`, ticketsToCsv(rows.map((ticket) => {
                    const requester = users.find((person) => person.id === ticket.user_id)
                    return {
                      ...ticket,
                      requester: requester?.full_name || '',
                      requesterNumber: requester?.employee_number || '',
                      technician: users.find((person) => person.id === ticket.assigned_to)?.full_name || '',
                      created_at: formatTicketWhen(ticket.created_at)
                    }
                  })))
                }}>تصدير CSV</button>
                {!exportMonth && <small style={{ color: '#94a3b8' }}>إذا لم تختر شهراً فسيُصدَّر الشهر الحالي.</small>}
                {ticketActionMsg && !selectedTicket && <small style={{ color: '#64748b' }}>{ticketActionMsg}</small>}
              </div>
              {loading ? (
                <div className="skeleton-list" aria-label="جاري التحميل">{[0, 1, 2, 3].map((item) => <div key={item} className="skeleton-row" />)}</div>
              ) : filteredTickets.length === 0 ? (
                <div className="empty-state">{ticketQuery.trim() || ticketNoQuery.trim() ? 'لا توجد بلاغات مطابقة للبحث.' : 'لا توجد بلاغات مسجلة حالياً.'}</div>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>رقم البلاغ</th>
                        <th>المشكلة</th>
                        <th>مقدّم البلاغ</th>
                        <th>القسم</th>
                        <th>نوع العطل</th>
                        <th>الفني</th>
                        <th>الحالة</th>
                        <th>التاريخ والوقت</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTickets.map((ticket) => {
                        const requester = users.find((person) => person.id === ticket.user_id)
                        const worker = users.find((person) => person.id === ticket.assigned_to)
                        const closed = ticket.status === 'منجزة' || ticket.status === 'مغلقة'
                        const late = isDelayed(ticket)
                        return (
                          <tr key={ticket.id} onClick={() => openAdminTicket(ticket)} style={{ cursor: 'pointer', background: late ? 'rgba(239, 68, 68, 0.06)' : undefined }}>
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
                            <td><b>{requester?.full_name || 'غير معروف'}</b>{requester?.employee_number && <small dir="ltr" style={{ display: 'block', color: '#7c3aed', fontWeight: 800 }}>{requester.employee_number}</small>}</td>
                            <td>{ticket.affected_department || requester?.department || 'غير محدد'}</td>
                            <td>{ticket.fault_type || '—'}</td>
                            <td>{ticket.assigneeName || worker?.full_name || 'بانتظار فني'}</td>
                            <td><StatusBadge status={ticket.status} /></td>
                            <td>{formatTicketWhen(ticket.created_at)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>
      </section>

      {selectedTicket && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedTicket(null) }} style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}>
          <div style={{ background: dark ? '#13151f' : '#ffffff', border: `1px solid ${dark ? '#1e2230' : '#e2e8f0'}`, borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: '640px', maxHeight: '85vh', overflowY: 'auto', color: dark ? '#fff' : '#0f172a' }}>
            <div className="modal-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <div>
                <span className="ticket-no" style={{ ...ticketNoStyle, marginBottom: '4px' }}>{formatTicketNo(selectedTicket.ticket_number)}</span>
                <h3 style={{ margin: '4px 0 0', fontSize: '18px' }}>{selectedTicket.title}</h3>
              </div>
              <button onClick={() => setSelectedTicket(null)} aria-label="إغلاق" title="إغلاق" style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '1rem', fontSize: '13px', alignItems: 'center' }}>
              <StatusBadge status={selectedTicket.status} />
              <span style={{ background: dark ? '#1a1d2d' : '#f8fafc', padding: '6px 12px', borderRadius: '8px' }}><b>مقدّم البلاغ:</b> {users.find((person) => person.id === selectedTicket.user_id)?.full_name || 'غير معروف'}{users.find((person) => person.id === selectedTicket.user_id)?.employee_number ? ` · ${users.find((person) => person.id === selectedTicket.user_id)?.employee_number}` : ''}</span>
              <span style={{ background: dark ? '#1a1d2d' : '#f8fafc', padding: '6px 12px', borderRadius: '8px' }}><b>الفني:</b> {selectedTicket.assigneeName || users.find((person) => person.id === selectedTicket.assigned_to)?.full_name || 'بانتظار فني'}</span>
              <span style={{ background: dark ? '#1a1d2d' : '#f8fafc', padding: '6px 12px', borderRadius: '8px' }}><b>الوقت:</b> {formatTicketWhen(selectedTicket.created_at)}</span>
              {asRating(selectedTicket.rating) !== null && <span style={{ background: dark ? '#1a1d2d' : '#f8fafc', padding: '6px 12px', borderRadius: '8px' }}><b>التقييم:</b> {asRating(selectedTicket.rating)}/5</span>}
            </div>
            {ticketActionMsg && <p style={{ fontSize: '13px', margin: '0 0 10px', color: ticketActionMsg.startsWith('تم') ? '#10b981' : '#ef4444' }}>{ticketActionMsg}</p>}
            <TicketTools
              ticket={{ ...selectedTicket, created_at: selectedTicket.created_at || '' }}
              actor="admin"
              userId=""
              technicians={users.filter((person) => isTechnicianRole(person.role)).map((person) => ({
                id: person.id,
                name: person.full_name,
                availability: person.availability,
                openCount: tickets.filter((item) => item.assigned_to === person.id && isActive(item.status)).length
              }))}
              events={ticketEvents}
              notes={ticketNotes}
              busy={ticketActionBusy}
              onRun={async (action, payload) => {
                setTicketActionBusy(true)
                const result = await ticketAction(supabase, selectedTicket.id, action, payload)
                setTicketActionBusy(false)
                if (result.error) { setTicketActionMsg(result.error); return }
                await fetchAllData(true)
                const fresh = await supabase.from('tickets').select('*').eq('id', selectedTicket.id).maybeSingle()
                if (fresh.data) {
                  const meta = readTicketMeta(fresh.data.title)
                  await openAdminTicket({ ...(fresh.data as TicketData), title: meta.problem, assigned_to: fresh.data.assigned_technician || null })
                }
                setTicketActionMsg(action === 'assign' ? 'تم تعيين الفني.' : action === 'note' ? 'تم حفظ الملاحظة.' : 'تم حفظ الإجراء.')
              }}
            />
            <h4 style={{ fontSize: '14px', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '6px' }}><MessageSquare size={16} /> المحادثة</h4>
            <TicketConversation requester={users.find((person) => person.id === selectedTicket.user_id)?.full_name || 'غير معروف'} problem={selectedTicket.title} messages={ticketThread} />
            {ticketReplyError && <p style={{ color: '#ef4444', fontSize: '12px' }}>{ticketReplyError}</p>}
            {selectedTicket.status === 'مغلقة' || selectedTicket.status === 'ملغاة' ? (
              <p style={{ fontSize: '12px', color: '#94a3b8', margin: 0 }}>البلاغ {statusLabel(selectedTicket.status)}، ولا يمكن إضافة ردود عليه.</p>
            ) : (
              <form onSubmit={handleAdminReply} style={{ display: 'flex', gap: '8px' }}>
                <input aria-label="الرد" value={ticketReply} onChange={(event) => setTicketReply(event.target.value)} placeholder="اكتب رداً يظهر للموظف والفني..." style={{ flex: 1, background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '10px', padding: '10px 12px', color: dark ? '#fff' : '#0f172a', outline: 'none' }} />
                <button type="submit" className="primary-btn" style={{ padding: '0 14px' }}><Send size={16} style={{ transform: 'rotate(180deg)' }} /></button>
              </form>
            )}
            <TicketHistory events={ticketEvents} />
            <div style={{ marginTop: '1rem' }}><TicketFiles ticketId={selectedTicket.id} /></div>
          </div>
        </div>
      )}

      {/* النوافذ المنبثقة */}
      {showHelpModal && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowHelpModal(false) }} style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: dark ? '#13151f' : '#ffffff', border: `1px solid ${dark ? '#1e2230' : '#e2e8f0'}`, borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: '420px', boxShadow: '0 25px 50px rgba(0,0,0,0.5)', color: dark ? '#fff' : '#0f172a' }}>
            <div className="modal-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}><Info size={20} color="#8b5cf6" /> حول النظام</h3>
              <button onClick={() => setShowHelpModal(false)} aria-label="إغلاق" title="إغلاق" style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            <p style={{ color: '#94a3b8', fontSize: '14px', lineHeight: '1.6', margin: '0 0 1rem' }}>إدارة البلاغات والمستخدمين في سند.</p>
            <div style={{ marginBottom: '1.5rem' }}><StatusLegend /></div>
            <button onClick={() => setShowHelpModal(false)} style={{ width: '100%', background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '8px', padding: '10px', fontWeight: '600', cursor: 'pointer' }}>إغلاق</button>
          </div>
        </div>
      )}

      {showAddModal && (
        <div className="modal-backdrop" style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '24px' }}>
          <div style={{ background: dark ? '#13151f' : '#ffffff', border: `1px solid ${dark ? '#1e2230' : '#e2e8f0'}`, borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: grantTarget === 'add' ? '520px' : '450px', maxHeight: '90vh', overflow: 'auto', color: dark ? '#fff' : '#0f172a' }}>
            {grantTarget === 'add' ? (
              <AdminOwnerGate
                dark={dark}
                title="تحقق لإضافة مدير نظام"
                username={ownerUsername}
                password={ownerPassword}
                verified={ownerVerified}
                checking={ownerChecking}
                saving={adding}
                error={ownerError || modalError}
                permissions={pickedPermissions}
                submitLabel={adding ? 'جاري الحفظ...' : 'إنشاء مدير النظام'}
                onUsername={(value) => { setOwnerUsername(value); setOwnerVerified(false) }}
                onPassword={(value) => { setOwnerPassword(value); setOwnerVerified(false) }}
                onVerify={verifyOwnerAccount}
                onToggle={togglePermission}
                onAll={() => setPickedPermissions(ADMIN_PERMISSIONS.map((item) => item.key))}
                onSubmit={() => handleAddUser()}
                onBack={() => { setGrantTarget(null); setModalError('') }}
                onClose={() => { resetGrant(); setShowAddModal(false) }}
              />
            ) : (
            <>
            <div className="modal-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 'bold' }}>إضافة مستخدم جديد</h3>
              <button onClick={() => { resetGrant(); setShowAddModal(false) }} aria-label="إغلاق" title="إغلاق" style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            {modalError && <div style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '10px', borderRadius: '8px', fontSize: '13px', marginBottom: '1rem', textAlign: 'center' }}>{modalError}</div>}
            <form onSubmit={handleAddUser} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label htmlFor="add-name" style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>الاسم الكامل</label>
                <input id="add-name" type="text" required value={newFullName} onChange={(e) => setNewFullName(e.target.value)} style={{ width: '100%', background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '8px', padding: '10px', color: dark ? '#fff' : '#0f172a', outline: 'none' }} />
              </div>
              <div>
                <label htmlFor="add-username" style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>البريد</label>
                <div dir="ltr" style={{ display: 'flex', background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '8px', overflow: 'hidden' }}>
                  <input id="add-username" type="text" required value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="name" style={{ flex: 1, background: 'transparent', border: 'none', padding: '10px', color: dark ? '#fff' : '#0f172a', outline: 'none', direction: 'ltr', textAlign: 'left' }} dir="ltr" />
                  <span style={{ padding: '0 12px', color: '#8b5cf6', fontSize: '13px', display: 'flex', alignItems: 'center', background: 'rgba(139, 92, 246, 0.1)', direction: 'ltr' }}>{COMPANY_DOMAIN}</span>
                </div>
                <small style={{ color: '#94a3b8', fontSize: '11px', marginTop: '4px', display: 'block' }}>البريد لا يتكرر. يظهر بالشكل: الاسم ثم {COMPANY_DOMAIN}</small>
              </div>
              <div>
                <label htmlFor="add-number" style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>رقم الموظف</label>
                <input id="add-number" inputMode="numeric" required value={newEmployeeNumber} onChange={(e) => setNewEmployeeNumber(e.target.value)} placeholder="445213615" maxLength={9} style={{ width: '100%', background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '8px', padding: '10px', color: dark ? '#fff' : '#0f172a', outline: 'none', direction: 'ltr', textAlign: 'left' }} dir="ltr" />
                <small style={{ color: '#94a3b8', fontSize: '11px', marginTop: '4px', display: 'block' }}>9 أرقام، ولا يُعطى لموظف آخر.</small>
              </div>
              <div>
                <label htmlFor="add-password" style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>كلمة المرور الأولية (مؤقتة)</label>
                <input id="add-password" type="password" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="أدخل كلمة مرور أولية" style={{ width: '100%', background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '8px', padding: '10px', color: dark ? '#fff' : '#0f172a', outline: 'none' }} dir="ltr" />
                <small style={{ color: '#94a3b8', fontSize: '11px', marginTop: '4px', display: 'block' }}>يغيّرها المستخدم عند أول دخول.</small>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>القسم والدور (الصلاحية)</label>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <select aria-label="القسم" value={isTechnicianRole(newRole) ? TECH_DEPARTMENT : newDepartment} disabled={isTechnicianRole(newRole)} onChange={(e) => setNewDepartment(e.target.value)} style={{ flex: 1, background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '8px', padding: '10px', color: dark ? '#fff' : '#0f172a', outline: 'none' }}>
                    {(isTechnicianRole(newRole) ? [TECH_DEPARTMENT] : availableDepartmentsForAdd).map(dept => <option key={dept} value={dept}>{dept}</option>)}
                  </select>
                  <select aria-label="الدور" value={newRole} onChange={(e) => { const role = e.target.value; setNewRole(role); if (isTechnicianRole(role)) setNewDepartment(TECH_DEPARTMENT) }} style={{ flex: 1, background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '8px', padding: '10px', color: dark ? '#fff' : '#0f172a', outline: 'none' }}>
                    <option value="user">موظف</option>
                    <option value="department_head">رئيس قسم</option>
                    <option value="technician">فني دعم</option>
                    <option value="admin">مدير نظام</option>
                  </select>
                </div>
                <small style={{ color: '#94a3b8', fontSize: '11px', marginTop: '6px', display: 'block' }}>{newRole === 'admin' ? 'يتطلب تحقق عمار ثم اختيار الصلاحيات.' : isTechnicianRole(newRole) ? 'الفني يتبع قسم الدعم التقني.' : 'رئيس القسم يتابع بلاغات قسمه.'}</small>
              </div>
              <div className="modal-foot"><button type="submit" disabled={adding} style={{ background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '8px', padding: '12px', fontWeight: 700, cursor: 'pointer' }}>{newRole === 'admin' ? 'متابعة للتحقق' : (adding ? 'جاري الحفظ...' : 'حفظ وإضافة الحساب')}</button></div>
            </form>
            </>
            )}
          </div>
        </div>
      )}

      {showEditModal && (
        <div className="modal-backdrop" style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '24px' }}>
          <div style={{ background: dark ? '#13151f' : '#ffffff', border: `1px solid ${dark ? '#1e2230' : '#e2e8f0'}`, borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: grantTarget === 'edit' ? '520px' : '450px', maxHeight: '90vh', overflow: 'auto', color: dark ? '#fff' : '#0f172a' }}>
            {grantTarget === 'edit' ? (
              <AdminOwnerGate
                dark={dark}
                title="تحقق لتعديل صلاحية مدير نظام"
                username={ownerUsername}
                password={ownerPassword}
                verified={ownerVerified}
                checking={ownerChecking}
                saving={editing}
                error={ownerError || editError}
                permissions={pickedPermissions}
                submitLabel={editing ? 'جاري الحفظ...' : 'حفظ مدير النظام'}
                onUsername={(value) => { setOwnerUsername(value); setOwnerVerified(false) }}
                onPassword={(value) => { setOwnerPassword(value); setOwnerVerified(false) }}
                onVerify={verifyOwnerAccount}
                onToggle={togglePermission}
                onAll={() => setPickedPermissions(ADMIN_PERMISSIONS.map((item) => item.key))}
                onSubmit={() => handleUpdateUser()}
                onBack={() => { setGrantTarget(null); setEditError('') }}
                onClose={() => { resetGrant(); setShowEditModal(false) }}
              />
            ) : (
            <>
            <div className="modal-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 'bold' }}>تعديل بيانات المستخدم</h3>
              <button onClick={() => { resetGrant(); setShowEditModal(false) }} aria-label="إغلاق" title="إغلاق" style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            {editError && <div style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '10px', borderRadius: '8px', fontSize: '13px', marginBottom: '1rem', textAlign: 'center' }}>{editError}</div>}
            <form onSubmit={handleUpdateUser} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label htmlFor="edit-name" style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>الاسم الكامل</label>
                <input id="edit-name" type="text" required value={editFullName} onChange={(e) => setEditFullName(e.target.value)} style={{ width: '100%', background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '8px', padding: '10px', color: dark ? '#fff' : '#0f172a', outline: 'none' }} />
              </div>
              <div>
                <label htmlFor="edit-email" style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>البريد</label>
                <input id="edit-email" type="text" value={editEmail} readOnly dir="ltr" style={{ width: '100%', background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '8px', padding: '10px', color: '#64748b', outline: 'none', direction: 'ltr', textAlign: 'left' }} />
              </div>
              <div>
                <label htmlFor="edit-number" style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>رقم الموظف</label>
                <input id="edit-number" inputMode="numeric" required value={editEmployeeNumber} onChange={(e) => setEditEmployeeNumber(e.target.value)} maxLength={9} dir="ltr" style={{ width: '100%', background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '8px', padding: '10px', color: dark ? '#fff' : '#0f172a', outline: 'none', direction: 'ltr', textAlign: 'left' }} />
              </div>
              {allowed('reset_password') && <div>
                <label htmlFor="edit-password" style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: '#8b5cf6' }}><Lock size={14} style={{ display: 'inline', marginLeft: '6px' }} /> إعادة تعيين كلمة المرور</label>
                <input id="edit-password" type="password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} placeholder="اتركها فارغة للإبقاء على كلمة الدخول الحالية" style={{ width: '100%', background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#8b5cf6' : '#cbd5e1'}`, borderRadius: '8px', padding: '10px', color: dark ? '#fff' : '#0f172a', outline: 'none' }} dir="ltr" />
              </div>}
              <div>
                <label htmlFor="edit-department" style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>القسم</label>
                <select id="edit-department" value={isTechnicianRole(editRole) ? TECH_DEPARTMENT : editDepartment} disabled={isTechnicianRole(editRole)} onChange={(e) => setEditDepartment(e.target.value)} style={{ width: '100%', background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '8px', padding: '10px', color: dark ? '#fff' : '#0f172a', outline: 'none' }}>
                  {(isTechnicianRole(editRole) ? [TECH_DEPARTMENT] : editDepartmentOptions).map((dept) => <option key={dept} value={dept}>{dept}</option>)}
                </select>
                {isTechnicianRole(editRole) && <small style={{ color: '#94a3b8', fontSize: '11px', marginTop: '6px', display: 'block' }}>فني الدعم يتبع قسم الدعم التقني فقط.</small>}
              </div>
              <div>
                <label htmlFor="edit-role" style={{ display: 'block', fontSize: '13px', marginBottom: '6px' }}>الصلاحية (الدور)</label>
                <select id="edit-role" value={editRole} onChange={(e) => { const role = e.target.value; setEditRole(role); if (isTechnicianRole(role)) setEditDepartment(TECH_DEPARTMENT) }} style={{ width: '100%', background: dark ? '#1a1d2d' : '#f8fafc', border: `1px solid ${dark ? '#2a2e43' : '#cbd5e1'}`, borderRadius: '8px', padding: '10px', color: dark ? '#fff' : '#0f172a', outline: 'none' }}>
                  <option value="user">موظف</option>
                  <option value="department_head">رئيس قسم</option>
                  <option value="technician">فني دعم</option>
                  <option value="admin">مدير نظام</option>
                </select>
              </div>
              {editRole === 'admin' && editOriginalRole !== 'admin' && <small style={{ color: '#94a3b8', fontSize: '11px', display: 'block' }}>يتطلب تحقق عمار ثم اختيار الصلاحيات.</small>}
              <div className="modal-foot"><button type="submit" disabled={editing} style={{ background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '8px', padding: '12px', fontWeight: 700, cursor: 'pointer' }}>{editRole === 'admin' && editOriginalRole !== 'admin' ? 'متابعة للتحقق' : (editing ? 'جاري الحفظ...' : 'تحديث البيانات')}</button></div>
            </form>
            </>
            )}
          </div>
        </div>
      )}
      {pendingDelete && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) setPendingDelete(null) }} style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: '1rem' }}>
          <div style={{ background: dark ? '#13151f' : '#ffffff', border: `1px solid ${dark ? '#1e2230' : '#e2e8f0'}`, borderRadius: '16px', padding: '1.5rem', width: '100%', maxWidth: '400px', color: dark ? '#fff' : '#0f172a' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: '17px', display: 'flex', alignItems: 'center', gap: '8px' }}><Trash2 size={18} color="#ef4444" /> حذف الحساب</h3>
            <p style={{ margin: '0 0 1.25rem', fontSize: '14px', lineHeight: 1.8, color: '#64748b' }}>سيُحذف حساب «{pendingDelete.full_name}» نهائياً، ولن يتمكن صاحبه من الدخول. لا يمكن التراجع عن هذا الإجراء.</p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" disabled={deleting} onClick={() => setPendingDelete(null)} style={{ background: 'transparent', color: 'inherit', border: '1px solid #cbd5e1', borderRadius: '8px', padding: '9px 16px', cursor: 'pointer' }}>إلغاء</button>
              <button type="button" disabled={deleting} onClick={() => deleteUser(pendingDelete.id)} style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: '8px', padding: '9px 16px', fontWeight: 700, cursor: 'pointer', opacity: deleting ? 0.6 : 1 }}>{deleting ? 'جاري الحذف...' : 'حذف نهائياً'}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div role="status" className={`toast ${toast.tone === 'error' ? 'toast-error' : 'toast-ok'}`} onClick={() => setToast(null)}>{toast.text}</div>}
    </main>
  )
}

function Nav({ icon, label, active, badge, onClick }: { icon: React.ReactNode; label: string; active: boolean; badge?: string; onClick: () => void }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{badge && <em>{badge}</em>}</button>
}
function PanelHeader({ icon, title, action }: { icon: React.ReactNode; title: string; action?: string }) {
  return <div className="panel-header"><div className="panel-title"><span>{icon}</span><h2>{title}</h2></div>{action && <button className="panel-action">{action}<ChevronDown /></button>}</div>
}
function Stat({ icon, label, value, sub, onClick }: { icon: React.ReactNode; label: string; value: string; sub: string; onClick: () => void }) {
  return <button type="button" className="stat-card" onClick={onClick}><div className="stat-icon">{icon}</div><span className="stat-delta up">{sub}</span><small>{label}</small><strong>{value}</strong><span className="stat-caption">اضغط لفتح القائمة</span></button>
}

function ProgressBar({ label, value, color }: { label: string, value: number, color: string }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}><span>{label}</span><b>{value}%</b></div>
      <div style={{ width: '100%', height: '8px', background: 'rgba(139, 92, 246, 0.1)', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', background: color, borderRadius: '4px' }}></div>
      </div>
    </div>
  )
}
function ToggleOption({ label, desc, checked, onChange, dark }: { label: string, desc: string, checked: boolean, onChange: () => void, dark: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: dark ? '#1a1d2d' : '#f8fafc', padding: '16px', borderRadius: '12px', border: `1px solid ${dark ? '#2a2e43' : '#e2e8f0'}` }}>
      <div>
        <strong style={{ display: 'block', fontSize: '14px', marginBottom: '4px', color: dark ? '#fff' : '#0f172a' }}>{label}</strong>
        <p style={{ color: '#94a3b8', fontSize: '12px', margin: 0 }}>{desc}</p>
      </div>
      <div onClick={onChange} style={{ width: '44px', height: '24px', background: checked ? '#8b5cf6' : '#475569', borderRadius: '12px', position: 'relative', cursor: 'pointer', transition: '0.3s' }}>
        <div style={{ width: '18px', height: '18px', background: '#fff', borderRadius: '50%', position: 'absolute', top: '3px', right: checked ? '3px' : '23px', transition: '0.3s' }}></div>
      </div>
    </div>
  )
}
