import { Hash, Search } from 'lucide-react'

export function TicketSearch({
  number,
  onNumber,
  text,
  onText,
  textLabel,
  textPlaceholder
}: {
  number: string
  onNumber: (value: string) => void
  text: string
  onText: (value: string) => void
  textLabel: string
  textPlaceholder: string
}) {
  return (
    <div className="table-actions ticket-search">
      <div className="search-box ticket-no-search">
        <Hash />
        <input value={number} onChange={(event) => onNumber(event.target.value)} inputMode="numeric" placeholder="رقم البلاغ" aria-label="بحث برقم البلاغ" />
      </div>
      <div className="search-box">
        <Search />
        <input aria-label={textLabel} value={text} onChange={(event) => onText(event.target.value)} placeholder={textPlaceholder} />
      </div>
    </div>
  )
}
