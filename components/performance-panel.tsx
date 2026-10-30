'use client'

import { Fragment, useMemo, useState, type CSSProperties } from 'react'
import { formatTicketNo } from '@/lib/display'

type Ticket = {
  id: string
  status: string
  created_at?: string | null
  resolved_at?: string | null
  assigned_to?: string | null
  rating?: number | null
  rating_reason?: string | null
  rater_name?: string | null
  ticket_number?: number | null
  priority?: string | null
  is_outage?: boolean | null
}
type StatusEvent = { ticket_id: string; from_status: string | null; to_status: string | null; created_at: string }
type Technician = { id: string; full_name: string }

const DAY = 24 * 60 * 60 * 1000

export function formatDuration(ms: number | null) {
  if (ms === null || !Number.isFinite(ms)) return '—'
  const minutes = Math.max(1, Math.round(ms / 60000))
  if (minutes < 60) return `${minutes} د`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} س ${minutes % 60} د`
  return `${Math.floor(hours / 24)} ي ${hours % 24} س`
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function time(value?: string | null) {
  const parsed = new Date(value || '').getTime()
  return Number.isNaN(parsed) ? null : parsed
}

function validRating(value?: number | null) {
  return typeof value === 'number' && value >= 1 && value <= 5 ? value : null
}

function ratingBadge(rating: number) {
  if (rating >= 4) return { label: 'ممتاز', tone: 'high' }
  if (rating === 3) return { label: 'متوسط', tone: 'mid' }
  return { label: 'منخفض', tone: 'low' }
}

export function PerformancePanel({ tickets, events, technicians, showRaterNotes = false }: { tickets: Ticket[]; events: StatusEvent[]; technicians: Technician[]; showRaterNotes?: boolean }) {
  const [range, setRange] = useState<'30' | '7' | 'all'>('30')
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({})
  const [now] = useState(() => Date.now())

  const stats = useMemo(() => {
    const since = range === 'all' ? 0 : now - Number(range) * DAY
    const scoped = tickets.filter((ticket) => (time(ticket.created_at) ?? 0) >= since)
    const scopedIds = new Set(scoped.map((ticket) => ticket.id))

    const firstClaim = new Map<string, number>()
    let reopened = 0
    events.forEach((event) => {
      if (!scopedIds.has(event.ticket_id)) return
      const at = time(event.created_at)
      if (at === null) return
      if (event.to_status === 'قيد المعالجة' && event.from_status === 'مفتوحة') {
        const previous = firstClaim.get(event.ticket_id)
        if (previous === undefined || at < previous) firstClaim.set(event.ticket_id, at)
      }
      if (event.to_status === 'مفتوحة' && (event.from_status === 'منجزة' || event.from_status === 'مغلقة')) reopened += 1
    })

    const claimDurations: number[] = []
    scoped.forEach((ticket) => {
      const claimed = firstClaim.get(ticket.id)
      const created = time(ticket.created_at)
      if (claimed !== undefined && created !== null) claimDurations.push(claimed - created)
    })
    const resolveDurations = scoped
      .map((ticket) => { const done = time(ticket.resolved_at); const created = time(ticket.created_at); return done !== null && created !== null ? done - created : null })
      .filter((value): value is number => value !== null)
    const ratings = scoped.map((ticket) => validRating(ticket.rating)).filter((value): value is number => value !== null)
    const finished = scoped.filter((ticket) => ticket.status === 'منجزة' || ticket.status === 'مغلقة').length
    const urgent = scoped.filter((ticket) => ticket.priority === 'عاجل' || ticket.is_outage)
    const urgentClaims = urgent.map((ticket) => { const claimed = firstClaim.get(ticket.id); const created = time(ticket.created_at); return claimed !== undefined && created !== null ? claimed - created : null }).filter((value): value is number => value !== null)

    const perTech = technicians.map((tech) => {
      const mine = scoped.filter((ticket) => ticket.assigned_to === tech.id)
      const done = mine.filter((ticket) => ticket.status === 'منجزة' || ticket.status === 'مغلقة')
      const active = tickets.filter((ticket) => ticket.assigned_to === tech.id && ['قيد المعالجة', 'بانتظار الموظف'].includes(ticket.status)).length
      const durations = done.map((ticket) => { const doneAt = time(ticket.resolved_at); const created = time(ticket.created_at); return doneAt !== null && created !== null ? doneAt - created : null }).filter((value): value is number => value !== null)
      const techRatings = done.map((ticket) => validRating(ticket.rating)).filter((value): value is number => value !== null)
      const reviews = done.flatMap((ticket) => {
        const rating = validRating(ticket.rating)
        if (rating === null) return []
        return [{ id: ticket.id, rating, reason: (ticket.rating_reason || '').trim(), rater: ticket.rater_name || 'موظف', number: ticket.ticket_number }]
      }).sort((a, b) => (b.number || 0) - (a.number || 0))
      return { id: tech.id, name: tech.full_name, done: done.length, active, resolve: average(durations), rating: average(techRatings), rated: techRatings.length, reviews }
    }).sort((a, b) => b.done - a.done)

    return {
      total: scoped.length,
      finished,
      claim: average(claimDurations),
      claimedWithinDay: claimDurations.length ? Math.round((claimDurations.filter((value) => value <= DAY).length / claimDurations.length) * 100) : null,
      urgentClaim: average(urgentClaims),
      resolve: average(resolveDurations),
      rating: average(ratings),
      rated: ratings.length,
      reopenRate: finished ? Math.round((reopened / finished) * 100) : null,
      perTech
    }
  }, [tickets, events, technicians, range, now])

  const cards: Array<[string, string, string]> = [
    ['متوسط وقت الاستلام', formatDuration(stats.claim), 'من فتح البلاغ حتى استلام فني'],
    ['استلام العاجل', formatDuration(stats.urgentClaim), 'العاجلة وبلاغات تعطل الأقسام'],
    ['استُلمت خلال يوم', stats.claimedWithinDay === null ? '—' : `${stats.claimedWithinDay}%`, 'من البلاغات المستلمة'],
    ['متوسط وقت الحل', formatDuration(stats.resolve), 'من فتح البلاغ حتى إنجازه'],
    ['رضا الموظفين', stats.rating === null ? '—' : `${stats.rating.toFixed(1)} / 5`, `من ${stats.rated} تقييم`],
    ['نسبة إعادة الفتح', stats.reopenRate === null ? '—' : `${stats.reopenRate}%`, 'كلما قلّت كان الحل أدق']
  ]

  return (
    <section className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
        <div>
          <h2 style={{ fontSize: '16px', margin: 0 }}>مؤشرات الأداء</h2>
          <small style={muted}>{stats.total} بلاغ في الفترة، منها {stats.finished} منجز أو مغلق.</small>
        </div>
        <select aria-label="الفترة" value={range} onChange={(event) => setRange(event.target.value as '30' | '7' | 'all')} style={{ background: 'var(--field)', color: 'inherit', border: '1px solid var(--field-border)', borderRadius: '8px', padding: '6px 10px' }}>
          <option value="7">آخر 7 أيام</option>
          <option value="30">آخر 30 يوماً</option>
          <option value="all">كل الفترات</option>
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(max(200px, calc((100% - 24px) / 3)), 1fr))', gap: '12px' }}>
        {cards.map(([label, value, note]) => (
          <div key={label} style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 14px' }}>
            <small style={{ ...muted, fontWeight: 700 }}>{label}</small>
            <strong style={{ display: 'block', fontSize: '22px', margin: '4px 0', direction: 'rtl' }}>{value}</strong>
            <small style={muted}>{note}</small>
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: '14px', margin: '20px 0 8px' }}>أداء الفنيين</h3>
      {stats.perTech.length === 0 ? <p style={muted}>لا يوجد فنيون مسجّلون.</p> : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>الفني</th><th>أنجز في الفترة</th><th>يعمل عليها الآن</th><th>متوسط وقت الحل</th><th>متوسط التقييم</th></tr>
            </thead>
            <tbody>
              {stats.perTech.map((tech) => (
                <Fragment key={tech.id}>
                  <tr>
                    <td>
                      <div>{tech.name}</div>
                      {showRaterNotes && tech.reviews.length > 0 && (
                        <button type="button" className="tech-notes-toggle" aria-expanded={Boolean(openNotes[tech.id])} onClick={() => setOpenNotes((current) => ({ ...current, [tech.id]: !current[tech.id] }))}>
                          {openNotes[tech.id] ? 'إخفاء التعليقات' : `إظهار التعليقات (${tech.reviews.length})`}
                        </button>
                      )}
                    </td>
                    <td>{tech.done}</td>
                    <td>{tech.active}</td>
                    <td>{formatDuration(tech.resolve)}</td>
                    <td>{tech.rating === null ? '—' : `${tech.rating.toFixed(1)} / 5 (${tech.rated})`}</td>
                  </tr>
                  {showRaterNotes && openNotes[tech.id] && tech.reviews.length > 0 && (
                    <tr>
                      <td colSpan={5} className="tech-reviews-cell">
                        <div className="tech-reviews">
                          <div className="tech-review-list">
                            {tech.reviews.map((review) => {
                              const badge = ratingBadge(review.rating)
                              return (
                                <div key={review.id} className="tech-review">
                                  <div className="tech-review-head">
                                    <b>{review.rater}</b>
                                    {review.number ? <span className="ticket-no">{formatTicketNo(review.number)}</span> : null}
                                    <span className={`tech-review-stars tech-review-stars-${badge.tone}`}>التقييم: {badge.label} {review.rating}/5</span>
                                  </div>
                                  {review.reason ? <p>{review.reason}</p> : null}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <small style={{ ...muted, display: 'block', marginTop: '10px' }}>د = دقيقة، س = ساعة، ي = يوم. الأوقات محسوبة من سجل البلاغات الفعلي.</small>
    </section>
  )
}

const muted: CSSProperties = { color: 'var(--text-muted)', fontSize: '12px' }
