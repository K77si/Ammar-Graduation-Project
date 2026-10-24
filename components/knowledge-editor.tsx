'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ArrowDown, ArrowUp, Pencil, Trash2 } from 'lucide-react'

type Kind = 'faq' | 'templates'
type Item = { id: string; title?: string; body: string; sort_order: number }

const CONFIG: Record<Kind, { table: string; columns: string; empty: string; bodyLabel: string; bodyMin: number; bodyMax: number }> = {
  faq: {
    table: 'faq_items',
    columns: 'id, title, body, sort_order',
    empty: 'لا توجد حلول سريعة بعد.',
    bodyLabel: 'الحل',
    bodyMin: 10,
    bodyMax: 600
  },
  templates: {
    table: 'reply_templates',
    columns: 'id, body, sort_order',
    empty: 'لا توجد ردود جاهزة بعد.',
    bodyLabel: 'نص الرد',
    bodyMin: 5,
    bodyMax: 300
  }
}

export function KnowledgeEditor({ supabase, kind }: { supabase: SupabaseClient; kind: Kind }) {
  const config = CONFIG[kind]
  const faq = kind === 'faq'
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const refresh = async () => {
    const { data, error } = await supabase.from(config.table).select(config.columns).order('sort_order', { ascending: true })
    if (error) setMessage({ text: 'تعذّر تحميل القائمة.', ok: false })
    else setItems((data || []) as unknown as Item[])
    setLoading(false)
  }

  useEffect(() => {
    let alive = true
    supabase.from(config.table).select(config.columns).order('sort_order', { ascending: true }).then(({ data, error }) => {
      if (!alive) return
      if (error) setMessage({ text: 'تعذّر تحميل القائمة.', ok: false })
      else setItems((data || []) as unknown as Item[])
      setLoading(false)
    })
    return () => { alive = false }
  }, [supabase, config.table, config.columns])

  const resetForm = () => {
    setTitle('')
    setBody('')
    setEditingId(null)
  }

  const save = async () => {
    const cleanTitle = title.trim()
    const cleanBody = body.trim()
    if (faq && (cleanTitle.length < 3 || cleanTitle.length > 80)) { setMessage({ text: 'اكتب عنواناً من 3 إلى 80 حرفاً.', ok: false }); return }
    if (cleanBody.length < config.bodyMin || cleanBody.length > config.bodyMax) {
      setMessage({ text: `اكتب ${config.bodyLabel} من ${config.bodyMin} إلى ${config.bodyMax} حرف.`, ok: false })
      return
    }
    setBusy(true)
    setMessage(null)
    const values: Record<string, string | number> = { body: cleanBody }
    if (faq) values.title = cleanTitle
    const result = editingId
      ? await supabase.from(config.table).update(values).eq('id', editingId).select('id')
      : await supabase.from(config.table).insert({ ...values, sort_order: (items.at(-1)?.sort_order ?? 0) + 1 }).select('id')
    setBusy(false)
    if (result.error || !result.data?.length) {
      setMessage({ text: 'تعذّر الحفظ. هذه القائمة تحتاج صلاحية الإعدادات.', ok: false })
      return
    }
    setMessage({ text: editingId ? 'تم حفظ التعديل.' : 'تمت الإضافة.', ok: true })
    resetForm()
    await refresh()
  }

  const remove = async (id: string) => {
    setBusy(true)
    const result = await supabase.from(config.table).delete().eq('id', id).select('id')
    setBusy(false)
    setConfirmId(null)
    if (result.error || !result.data?.length) { setMessage({ text: 'تعذّر الحذف.', ok: false }); return }
    if (editingId === id) resetForm()
    setMessage({ text: 'تم الحذف.', ok: true })
    await refresh()
  }

  const move = async (index: number, step: -1 | 1) => {
    const other = items[index + step]
    const current = items[index]
    if (!other || !current) return
    setBusy(true)
    const [a, b] = await Promise.all([
      supabase.from(config.table).update({ sort_order: other.sort_order }).eq('id', current.id).select('id'),
      supabase.from(config.table).update({ sort_order: current.sort_order }).eq('id', other.id).select('id')
    ])
    setBusy(false)
    if (a.error || b.error || !a.data?.length || !b.data?.length) setMessage({ text: 'تعذّر تغيير الترتيب.', ok: false })
    await refresh()
  }

  const startEdit = (item: Item) => {
    setEditingId(item.id)
    setTitle(item.title || '')
    setBody(item.body)
    setMessage(null)
  }

  if (loading) return <p style={muted}>جاري التحميل...</p>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px' }}>
        <b style={{ fontSize: '13px' }}>{editingId ? 'تعديل' : faq ? 'حل جديد' : 'رد جديد'}</b>
        {faq && <input aria-label="عنوان المشكلة" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="المشكلة، مثل: الطابعة تطبع صفحات فارغة" maxLength={80} style={field} />}
        <textarea aria-label={config.bodyLabel} value={body} onChange={(event) => setBody(event.target.value)} rows={3} maxLength={config.bodyMax} placeholder={faq ? 'خطوات الحل التي يجربها الموظف قبل فتح البلاغ' : 'مثل: أعد تشغيل الجهاز ثم أخبرنا بالنتيجة.'} style={{ ...field, resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button type="button" onClick={save} disabled={busy} style={primaryBtn}>{editingId ? 'حفظ التعديل' : 'إضافة'}</button>
          {editingId && <button type="button" onClick={resetForm} disabled={busy} style={ghostBtn}>إلغاء</button>}
          <small style={{ ...muted, marginInlineStart: 'auto' }}>{body.trim().length}/{config.bodyMax}</small>
        </div>
      </div>

      {message && <p role="status" style={{ margin: 0, fontSize: '13px', color: message.ok ? '#10b981' : '#ef4444' }}>{message.text}</p>}

      {items.length === 0 ? <p style={muted}>{config.empty}</p> : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {items.map((item, index) => (
            <li key={item.id} style={{ border: `1px solid ${editingId === item.id ? '#8b5cf6' : 'var(--border)'}`, borderRadius: '10px', padding: '10px 12px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: '13px', lineHeight: 1.7 }}>
                {item.title && <b style={{ display: 'block' }}>{item.title}</b>}
                <span style={{ color: item.title ? 'var(--text-muted)' : 'inherit', whiteSpace: 'pre-wrap' }}>{item.body}</span>
              </div>
              <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                <button type="button" aria-label="نقل لأعلى" title="نقل لأعلى" disabled={busy || index === 0} onClick={() => move(index, -1)} style={iconBtn}><ArrowUp size={14} /></button>
                <button type="button" aria-label="نقل لأسفل" title="نقل لأسفل" disabled={busy || index === items.length - 1} onClick={() => move(index, 1)} style={iconBtn}><ArrowDown size={14} /></button>
                <button type="button" aria-label="تعديل" title="تعديل" disabled={busy} onClick={() => startEdit(item)} style={iconBtn}><Pencil size={14} /></button>
                {confirmId === item.id ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => remove(item.id)} style={{ ...ghostBtn, color: '#ef4444', borderColor: '#fca5a5', padding: '4px 8px' }}>تأكيد الحذف</button>
                    <button type="button" disabled={busy} onClick={() => setConfirmId(null)} style={{ ...ghostBtn, padding: '4px 8px' }}>تراجع</button>
                  </>
                ) : (
                  <button type="button" aria-label="حذف" title="حذف" disabled={busy} onClick={() => setConfirmId(item.id)} style={{ ...iconBtn, color: '#ef4444' }}><Trash2 size={14} /></button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

const muted: CSSProperties = { margin: 0, fontSize: '12px', color: 'var(--text-muted)' }
const field: CSSProperties = { width: '100%', background: 'var(--field)', border: '1px solid var(--field-border)', borderRadius: '8px', padding: '10px', color: 'var(--text)', fontFamily: 'inherit', fontSize: '13px' }
const primaryBtn: CSSProperties = { background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '8px', padding: '8px 16px', fontWeight: 700, cursor: 'pointer' }
const ghostBtn: CSSProperties = { background: 'transparent', color: 'inherit', border: '1px solid #c4b5fd', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer', fontSize: '12px' }
const iconBtn: CSSProperties = { width: 30, height: 30, display: 'grid', placeItems: 'center', background: 'transparent', color: 'inherit', border: '1px solid var(--border)', borderRadius: '8px', cursor: 'pointer' }
