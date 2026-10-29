export function timeGreeting(now = new Date()) {
  const hour = now.getHours()
  if (hour >= 5 && hour < 12) return 'صباح الخير'
  if (hour >= 18 || hour < 5) return 'مساء الخير'
  return 'مرحباً'
}

export function formatTicketNo(value?: number | null) {
  if (!value) return '—'
  return `#${value}`
}

export function formatTicketWhen(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('ar-SA-u-nu-latn', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export const TECH_DEPARTMENT = 'الدعم التقني'

export const DEPARTMENTS = [TECH_DEPARTMENT, 'الموارد البشرية', 'المالية', 'الإدارة', 'العمليات', 'التسويق']

const TECH_ALIASES = new Set([
  TECH_DEPARTMENT,
  'الدعم التقني (it)',
  'تقنية المعلومات',
  'it',
  'information technology'
])

const DEPARTMENT_LABELS: Record<string, string> = {
  hr: 'الموارد البشرية',
  'human resources': 'الموارد البشرية',
  finance: 'المالية',
  it: TECH_DEPARTMENT,
  'information technology': TECH_DEPARTMENT,
  operations: 'العمليات',
  marketing: 'التسويق',
  'تقنية المعلومات': TECH_DEPARTMENT,
  'الدعم التقني (it)': TECH_DEPARTMENT
}

export function departmentLabel(value?: string | null) {
  const raw = (value || '').trim()
  if (!raw) return 'غير محدد'
  return DEPARTMENT_LABELS[raw.toLowerCase()] || raw
}

export function isTechDepartment(value?: string | null) {
  return TECH_ALIASES.has((value || '').trim().toLowerCase())
}

export function isTechnicianRole(role?: string | null) {
  return role === 'technician' || role === 'manager'
}

export function storedDepartment(role: string | null | undefined, department: string): { error: string } | { department: string } {
  const clean = department.trim()
  if (isTechnicianRole(role)) {
    if (!isTechDepartment(clean)) return { error: 'فني الدعم يتبع قسم الدعم التقني فقط.' }
    return { department: TECH_DEPARTMENT }
  }
  if (isTechDepartment(clean)) return { department: TECH_DEPARTMENT }
  if (!clean) return { error: 'القسم مطلوب.' }
  return { department: departmentLabel(clean) }
}

export function asRating(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const rating = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(rating) || rating < 1) return null
  return rating
}

export function roleLabel(role?: string | null) {
  if (role === 'admin') return 'مدير نظام'
  if (role === 'technician' || role === 'manager') return 'فني دعم'
  if (role === 'department_head') return 'رئيس قسم'
  return 'موظف'
}

const STATUS_LABELS: Record<string, string> = {
  'مفتوحة': 'مفتوح',
  'قيد المعالجة': 'قيد المعالجة',
  'بانتظار الموظف': 'بانتظار رد الموظف',
  'منجزة': 'منجز',
  'مغلقة': 'مغلق',
  'ملغاة': 'ملغاة'
}

export function statusLabel(status?: string | null) {
  return STATUS_LABELS[status || ''] || status || '—'
}

export const STATUS_NOTE = 'مفتوح: في قائمة الانتظار حتى يستلمه فني. قيد المعالجة: استلمه فني ويعمل عليه. بانتظار رد الموظف: طلب الفني معلومة، ويعود إلى المعالجة عند رد صاحب البلاغ. منجز: كتب الفني الحل، وينتظر تأكيد صاحب البلاغ، ويُغلق تلقائياً بعد 3 أيام. مغلق: انتهى البلاغ، ويمكن إعادة فتحه خلال 7 أيام إذا عادت المشكلة. ملغاة: أُلغي البلاغ ولن يُعالَج.'

export function randomEmployeeNumber() {
  return String(100000000 + Math.floor(Math.random() * 900000000))
}

export function passwordError(password: string, strict = false) {
  if (password.length < 6) return 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.'
  if (password === '123456') return 'كلمة المرور 123456 غير مسموحة. اختر كلمة أخرى.'
  if (strict && (password.length < 8 || !/[A-Za-z\u0600-\u06FF]/.test(password) || !/\d/.test(password))) {
    return 'المصادقة الصارمة تتطلب 8 أحرف على الأقل، وفيها حرف ورقم.'
  }
  return ''
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

export function normalizeDigits(value: string) {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabic = ARABIC_DIGITS.indexOf(digit)
    if (arabic >= 0) return String(arabic)
    return String(PERSIAN_DIGITS.indexOf(digit))
  })
}

export function ticketNumberMatches(value: number | null | undefined, raw: string) {
  if (!raw.trim()) return true
  const term = normalizeDigits(raw).replace(/\D/g, '')
  if (!term || !value) return false
  return String(value) === term
}

export const ticketNoStyle = {
  fontFamily: 'var(--font-cairo), "Segoe UI", Tahoma, sans-serif',
  fontWeight: 800,
  fontSize: '16px',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: '0.04em',
  color: '#7c3aed',
  direction: 'ltr' as const,
  unicodeBidi: 'isolate' as const,
  display: 'inline-block',
}

export const greetingStyle = {
  margin: 0,
  fontSize: '1.2rem',
  fontWeight: 800,
  color: '#7c3aed',
  lineHeight: 1.5,
}
