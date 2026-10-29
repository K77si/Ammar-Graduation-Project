export function originOf(source?: string | null, text?: string | null) {
  return source === 'سند' || (text || '').startsWith('سند · ') ? 'سند' : 'يدوي'
}

export function stripOrigin(text?: string | null) {
  return (text || '').replace(/^سند · /, '')
}

export function OriginBadge({ source }: { source?: string | null }) {
  const sanad = source === 'سند'
  return <span className={sanad ? 'origin-badge origin-sanad' : 'origin-badge origin-manual'}>{sanad ? 'سند' : 'يدوي'}</span>
}

export function OriginFilter({ value, onChange }: { value: 'الكل' | 'يدوي' | 'سند'; onChange: (value: 'الكل' | 'يدوي' | 'سند') => void }) {
  return (
    <div className="origin-filter" role="group" aria-label="طريقة التنفيذ">
      {(['الكل', 'يدوي', 'سند'] as const).map((item) => (
        <button key={item} type="button" className={value === item ? 'active' : ''} aria-pressed={value === item} onClick={() => onChange(item)}>{item}</button>
      ))}
    </div>
  )
}
