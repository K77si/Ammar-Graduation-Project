export function unseenNotices<T extends { id: string }>(userId: string, items: T[]) {
  if (!userId || typeof window === 'undefined') return items
  const key = `sanad-seen:${userId}`
  const raw = localStorage.getItem(key)
  if (raw === null) {
    localStorage.setItem(key, JSON.stringify(items.map((item) => item.id)))
    return []
  }
  let seen: string[] = []
  try {
    const parsed = JSON.parse(raw)
    seen = Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    seen = []
  }
  const known = new Set(seen)
  return items.filter((item) => !known.has(item.id))
}

export function rememberNotices(userId: string, ids: string[]) {
  if (!userId || typeof window === 'undefined') return
  const key = `sanad-seen:${userId}`
  let seen: string[] = []
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]')
    seen = Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    seen = []
  }
  localStorage.setItem(key, JSON.stringify([...new Set([...seen, ...ids])].slice(-300)))
}
