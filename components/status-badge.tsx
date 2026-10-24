import { statusLabel } from '@/lib/display'

const TONES: Record<string, { color: string; background: string }> = {
  'مفتوحة': { color: '#d97706', background: 'rgba(245, 158, 11, 0.12)' },
  'قيد المعالجة': { color: '#2563eb', background: 'rgba(59, 130, 246, 0.12)' },
  'بانتظار الموظف': { color: '#9333ea', background: 'rgba(168, 85, 247, 0.12)' },
  'منجزة': { color: '#059669', background: 'rgba(16, 185, 129, 0.12)' },
  'مغلقة': { color: '#475569', background: 'rgba(100, 116, 139, 0.14)' },
  'ملغاة': { color: '#94a3b8', background: 'rgba(148, 163, 184, 0.14)' }
}

const LEGEND: Array<[string, string]> = [
  ['مفتوحة', 'بانتظار فني'],
  ['قيد المعالجة', 'فني يعمل عليه'],
  ['بانتظار الموظف', 'ينتظر رد الموظف'],
  ['منجزة', 'ينتظر التأكيد'],
  ['مغلقة', 'انتهى'],
  ['ملغاة', 'ألغاه صاحبه']
]

export function StatusLegend() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
      {LEGEND.map(([status, meaning]) => (
        <div key={status} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ minWidth: '130px' }}><StatusBadge status={status} /></span>
          <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{meaning}</span>
        </div>
      ))}
    </div>
  )
}

export function StatusBadge({ status }: { status?: string | null }) {
  const tone = TONES[status || ''] || TONES['مفتوحة']
  return (
    <span className="status-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap', color: tone.color, background: tone.background }}>
      <i style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', display: 'inline-block' }} />
      {statusLabel(status)}
    </span>
  )
}
