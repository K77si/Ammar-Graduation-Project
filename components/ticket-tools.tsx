'use client'

import { useState, type CSSProperties, type ReactNode } from 'react'
import { statusLabel } from '@/lib/display'
import { OriginBadge, originOf, stripOrigin } from '@/components/origin-badge'
import { AVAILABILITY, FAULT_TYPES, canReopen, isDelayed, type WorkflowTicket } from '@/lib/workflow'

type TechnicianOption = { id: string; name: string; availability?: string | null; openCount: number }
type EventRow = { id: string; actor_name: string; from_status: string | null; to_status: string | null; note?: string | null; source?: string | null; created_at: string }
type NoteRow = { id: string; author_name: string; body: string; created_at: string }

type ToolsProps = {
  ticket: WorkflowTicket
  actor: 'employee' | 'head' | 'technician' | 'admin'
  userId: string
  technicians: TechnicianOption[]
  events: EventRow[]
  notes: NoteRow[]
  busy: boolean
  onRun: (action: string, payload?: Record<string, string>) => Promise<void>
  resolutionDraft?: string
}

export function TicketTools(props: ToolsProps) {
  const { ticket } = props
  return <Tools key={`${ticket.id}|${ticket.status}|${ticket.assigned_to || ''}|${ticket.resolution || ''}|${ticket.fault_type || ''}|${ticket.priority || ''}|${props.resolutionDraft || ''}`} {...props} />
}

function Tools({ ticket, actor, userId, technicians, events, notes, busy, onRun, resolutionDraft }: ToolsProps) {
  const [reason, setReason] = useState('')
  const [resolution, setResolution] = useState(resolutionDraft || ticket.resolution || '')
  const [note, setNote] = useState('')
  const [assignee, setAssignee] = useState('')
  const [fault, setFault] = useState(ticket.fault_type || 'أخرى')
  const [urgentReason, setUrgentReason] = useState('')

  const owner = ticket.user_id === userId
  const staff = actor === 'technician' || actor === 'admin'
  const finished = ticket.status === 'مغلقة' || ticket.status === 'ملغاة'
  const unassigned = !ticket.assigned_to
  const mine = Boolean(ticket.assigned_to) && ticket.assigned_to === userId
  const canWork = actor === 'admin' ? !unassigned : mine
  const delayed = isDelayed(ticket)

  return (
    <div className="ticket-tools" style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '12px' }}>
        <Chip label="الأهمية" value={ticket.priority || 'عادي'} tone={ticket.priority === 'عاجل' ? 'danger' : undefined} />
        {ticket.is_outage && <Chip label="النوع" value="بلاغ قسم" tone="warn" />}
        {ticket.is_private && <Chip label="الخصوصية" value="خاص (لا يطّلع عليه رئيس القسم)" />}
        {ticket.fault_type && <Chip label="العطل" value={ticket.fault_type} />}
        {ticket.affected_department && <Chip label="القسم" value={ticket.affected_department} />}
        {ticket.site_place && <Chip label="المكان" value={ticket.site_place} />}
        {ticket.device_number && <Chip label="الجهاز" value={ticket.device_number} />}
        {delayed && <Chip label="تنبيه" value="مضى عليه أكثر من يوم دون أن يستلمه فني" tone="danger" />}
      </div>
      {ticket.priority === 'عاجل' && ticket.priority_reason && <p style={muted}>سبب الأهمية: {ticket.priority_reason}</p>}
      {ticket.resolution && <p style={{ margin: 0, fontSize: '13px' }}><b>{ticket.status === 'منجزة' || ticket.status === 'مغلقة' ? 'الحل:' : 'الحل السابق (قبل إعادة الفتح):'}</b> {ticket.resolution}</p>}
      {ticket.cancel_reason && <p style={{ margin: 0, fontSize: '13px' }}><b>سبب الإلغاء:</b> {ticket.cancel_reason}</p>}
      {ticket.rating_reason && <p style={{ margin: 0, fontSize: '13px' }}><b>سبب التقييم:</b> {ticket.rating_reason}</p>}

      {owner && ticket.status === 'مفتوحة' && unassigned && (
        <Box title="إلغاء البلاغ">
          <Row>
            <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="سبب الإلغاء" aria-label="سبب الإلغاء" style={field} />
            <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => onRun('cancel', { reason })} style={dangerBtn}>إلغاء البلاغ</button>
          </Row>
        </Box>
      )}
      {owner && ticket.status === 'منجزة' && (
        <Box title="هل حُلّت المشكلة؟">
          <p style={muted}>يُغلق تلقائياً بعد 3 أيام.</p>
          <button type="button" disabled={busy} onClick={() => onRun('confirm')} style={primaryBtn}>نعم، أغلِق البلاغ</button>
        </Box>
      )}
      {owner && canReopen(ticket) && (
        <Box title="هل عادت المشكلة؟">
          <p style={muted}>متاح خلال 7 أيام من الإنجاز.</p>
          <Row>
            <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="صِف ما عاد من المشكلة" aria-label="سبب إعادة الفتح" style={field} />
            <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => onRun('reopen', { reason })} style={ghostBtn}>إعادة فتح البلاغ</button>
          </Row>
        </Box>
      )}

      {staff && !finished && (
        <Box title="العمل على البلاغ">
          {actor === 'technician' && ticket.status === 'مفتوحة' && unassigned && (
            <button type="button" disabled={busy} onClick={() => onRun('claim')} style={primaryBtn}>استلام البلاغ</button>
          )}
          {actor === 'technician' && !unassigned && !mine && (
            <p style={muted}>البلاغ مع فني آخر.</p>
          )}
          {actor === 'admin' && unassigned && ticket.status === 'مفتوحة' && (
            <p style={muted}>في قائمة الانتظار، بدون فني.</p>
          )}
          {canWork && (
            <>
              {ticket.status !== 'منجزة' && (
                <textarea value={resolution} onChange={(event) => setResolution(event.target.value)} rows={2} placeholder="الحل (مطلوب قبل الإنجاز)" aria-label="الحل" style={{ ...field, width: '100%' }} />
              )}
              <Row>
                {ticket.status === 'بانتظار الموظف' && <button type="button" disabled={busy} onClick={() => onRun('status', { status: 'قيد المعالجة' })} style={ghostBtn}>إعادة إلى المعالجة</button>}
                {ticket.status === 'قيد المعالجة' && <button type="button" disabled={busy} onClick={() => onRun('status', { status: 'بانتظار الموظف' })} style={ghostBtn}>طلب معلومة من الموظف</button>}
                {ticket.status !== 'منجزة' && <button type="button" disabled={busy || resolution.trim().length < 3} onClick={() => onRun('status', { status: 'منجزة', resolution })} style={primaryBtn}>تم الإنجاز</button>}
                {ticket.status === 'منجزة' && <button type="button" disabled={busy} onClick={() => onRun('status', { status: 'قيد المعالجة' })} style={ghostBtn}>إعادة إلى المعالجة</button>}
                {ticket.status !== 'منجزة' && <button type="button" disabled={busy} onClick={() => onRun('status', { status: 'مفتوحة' })} style={ghostBtn}>إعادة إلى قائمة الانتظار</button>}
              </Row>
            </>
          )}
        </Box>
      )}

      {actor === 'admin' && !finished && ticket.status !== 'منجزة' && (
        <Box title={unassigned ? 'تعيين فني' : 'إعادة التعيين'}>
          <Row>
            <select aria-label="الفني" value={assignee} onChange={(event) => setAssignee(event.target.value)} style={field}>
              <option value="">اختر الفني</option>
              {technicians.map((person) => (
                <option key={person.id} value={person.id} disabled={person.availability === 'خارج الدوام' || person.id === ticket.assigned_to}>
                  {person.name} · {person.availability || AVAILABILITY[0]} · البلاغات النشطة: {person.openCount}
                </option>
              ))}
            </select>
            <button type="button" disabled={busy || !assignee} onClick={() => onRun('assign', { technician_id: assignee })} style={primaryBtn}>تعيين</button>
          </Row>
          {technicians.length === 0 && <p style={muted}>لا يوجد فنيون مسجّلون.</p>}
        </Box>
      )}

      {staff && !finished && (
        <Fold title="تعديل الأهمية أو نوع العطل">
          <Row>
            {ticket.priority === 'عاجل' ? (
              <button type="button" disabled={busy} onClick={() => onRun('priority', { priority: 'عادي' })} style={ghostBtn}>تحويله إلى عادي</button>
            ) : (
              <>
                <input aria-label="سبب الاستعجال" value={urgentReason} onChange={(event) => setUrgentReason(event.target.value)} placeholder="سبب الاستعجال، مثل: توقف العمل بسبب..." style={field} />
                <button type="button" disabled={busy || urgentReason.trim().length < 3} onClick={() => onRun('priority', { priority: 'عاجل', reason: urgentReason })} style={ghostBtn}>تحويله إلى عاجل</button>
              </>
            )}
          </Row>
          <Row>
            <select aria-label="نوع العطل" value={fault} onChange={(event) => setFault(event.target.value)} style={field}>
              {FAULT_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <button type="button" disabled={busy || fault === ticket.fault_type} onClick={() => onRun('fault', { fault_type: fault })} style={ghostBtn}>حفظ نوع العطل</button>
          </Row>
        </Fold>
      )}

      {staff && (
        <Fold title={`ملاحظات داخلية${notes.length ? ` (${notes.length})` : ''}`}>
          <p style={muted}>لا يراها الموظف.</p>
          {notes.map((item) => (
            <p key={item.id} style={{ margin: '2px 0', fontSize: '12px' }}><b>{item.author_name}:</b> {item.body}</p>
          ))}
          <Row>
            <input aria-label="ملاحظة داخلية" value={note} onChange={(event) => setNote(event.target.value)} placeholder="ملاحظة للفنيين ومدير النظام" style={field} />
            <button type="button" disabled={busy || note.trim().length < 2} onClick={async () => { await onRun('note', { body: note }); setNote('') }} style={ghostBtn}>حفظ</button>
          </Row>
        </Fold>
      )}
    </div>
  )
}

export function TicketHistory({ events }: { events: EventRow[] }) {
  const rows: Array<EventRow & { extra?: string }> = []
  for (const event of events) {
    const previous = rows[rows.length - 1]
    const sameMoment = previous && previous.actor_name === event.actor_name && Math.abs(+new Date(previous.created_at) - +new Date(event.created_at)) < 5000
    if (sameMoment && event.from_status === event.to_status && event.note) {
      previous.extra = event.note
      continue
    }
    rows.push({ ...event })
  }
  if (rows.length === 0) return null
  return (
    <div style={{ marginTop: '1rem' }}>
      <Fold title={`سجل البلاغ (${rows.length})`}>
        {rows.map((event) => (
          <p key={event.id} style={{ margin: '2px 0', fontSize: '12px', color: '#64748b', lineHeight: 1.8 }}>
            <b>{event.actor_name}</b>
            <OriginBadge source={originOf(event.source, event.note)} />
            {event.from_status !== event.to_status ? `: من «${statusLabel(event.from_status)}» إلى «${statusLabel(event.to_status)}»` : ''}
            {stripOrigin(event.note) ? ` · ${stripOrigin(event.note)}` : ''}
            {event.extra ? ` · ${event.extra}` : ''}
            <span style={{ marginInlineStart: '6px', opacity: 0.7 }}>{new Date(event.created_at).toLocaleString('ar-SA-u-nu-latn', { dateStyle: 'short', timeStyle: 'short' })}</span>
          </p>
        ))}
      </Fold>
    </div>
  )
}

function Chip({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'warn' }) {
  const color = tone === 'danger' ? '#ef4444' : tone === 'warn' ? '#b45309' : 'inherit'
  const background = tone === 'danger' ? 'rgba(239, 68, 68, 0.1)' : tone === 'warn' ? 'rgba(180, 83, 9, 0.12)' : 'var(--field, #f8fafc)'
  return <span style={{ background, color, borderRadius: '8px', padding: '4px 8px' }}><b>{label}:</b> {value}</span>
}

function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="fold" style={{ border: '1px solid var(--border, #e2e8f0)', borderRadius: '10px', padding: '10px 12px' }}>
      <summary>{title}</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>{children}</div>
    </details>
  )
}

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--border, #e2e8f0)', borderRadius: '10px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <b style={{ fontSize: '13px' }}>{title}</b>
      {children}
    </div>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>{children}</div>
}

const muted: CSSProperties = { margin: 0, fontSize: '12px', color: 'var(--text-muted, #64748b)' }
const field: CSSProperties = { flex: 1, minWidth: '140px', background: 'var(--field, #f8fafc)', border: '1px solid var(--field-border, #cbd5e1)', borderRadius: '8px', padding: '8px', color: 'inherit' }
const primaryBtn: CSSProperties = { background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer', fontWeight: 700 }
const ghostBtn: CSSProperties = { background: 'transparent', color: 'inherit', border: '1px solid #c4b5fd', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer' }
const dangerBtn: CSSProperties = { background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444', border: 'none', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer', fontWeight: 700 }
