export const ADMIN_PERMISSIONS = [
  { key: 'overview', label: 'نظرة عامة', detail: 'أرقام البلاغات والمستخدمين' },
  { key: 'tickets', label: 'البلاغات', detail: 'عرض البلاغات والرد عليها' },
  { key: 'users', label: 'المستخدمون', detail: 'إضافة وتعديل موظف أو فني أو رئيس قسم' },
  { key: 'approvals', label: 'الاعتمادات', detail: 'قبول الحسابات المعلقة أو إيقافها' },
  { key: 'analytics', label: 'التحليلات', detail: 'تقارير الأقسام وحالات البلاغات' },
  { key: 'settings', label: 'الإعدادات', detail: 'اسم الجهة والتنبيهات وسياسة كلمة المرور' },
  { key: 'delete_users', label: 'حذف الحسابات', detail: 'حذف مستخدم نهائياً' },
  { key: 'reset_password', label: 'إعادة تعيين كلمة المرور', detail: 'تغيير كلمة دخول مستخدم آخر' }
] as const

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number]['key']

const PERMISSION_KEYS = new Set<string>(ADMIN_PERMISSIONS.map((item) => item.key))

export function normalizeAdminPermissions(value: unknown): string[] | null {
  if (value == null) return null
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && PERMISSION_KEYS.has(item)))]
}

export function hasAdminPermission(permissions: string[] | null | undefined, key: string) {
  if (permissions == null) return true
  return permissions.includes(key)
}

export function permissionSummary(permissions?: string[] | null) {
  if (permissions == null) return 'كل الصلاحيات'
  const labels = ADMIN_PERMISSIONS.filter((item) => permissions.includes(item.key)).map((item) => item.label)
  return labels.length ? labels.join('، ') : 'بدون صلاحيات'
}
