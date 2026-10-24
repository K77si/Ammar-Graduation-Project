const STOP_WORDS = new Set([
  'في', 'من', 'على', 'عن', 'إلى', 'مع', 'أو', 'ثم', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'إذا', 'أنا', 'كله', 'كلها',
  'كان', 'كانت', 'يكون', 'لا', 'لم', 'لن', 'ما', 'ماذا', 'هل', 'قد', 'كل', 'بعد', 'قبل', 'عند', 'عندي', 'لدي', 'أبد', 'أبدا',
  'جدا', 'شي', 'شيء', 'اليوم', 'منذ', 'وقت', 'مشكلة', 'المشكلة', 'يوجد', 'فيه', 'فيها', 'the', 'and'
].map((word) => normalizeArabic(word)))

export function normalizeArabic(text: string) {
  return text
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
}

function stem(word: string) {
  let next = word
  if (next.length > 4 && next.startsWith('ال')) next = next.slice(2)
  else if (next.length > 5 && (next.startsWith('بال') || next.startsWith('وال') || next.startsWith('فال') || next.startsWith('كال'))) next = next.slice(3)
  if (next.length > 4 && (next.endsWith('ات') || next.endsWith('ون') || next.endsWith('ين') || next.endsWith('ها'))) next = next.slice(0, -2)
  else if (next.length > 3 && next.endsWith('ه')) next = next.slice(0, -1)
  return next
}

export function keywords(text: string) {
  const words = normalizeArabic(text).split(/[^a-z0-9\u0621-\u064A]+/)
  return new Set(words.filter((word) => word.length >= 3 && !STOP_WORDS.has(word)).map(stem).filter((word) => word.length >= 3))
}

export function similarity(query: string, candidate: string) {
  const wanted = keywords(query)
  if (wanted.size === 0) return 0
  const have = keywords(candidate)
  let hits = 0
  wanted.forEach((word) => { if (have.has(word)) hits += 1 })
  return hits / Math.min(wanted.size, 4)
}

export function rankSimilar<T>(query: string, items: T[], text: (item: T) => string, limit = 3, minimum = 0.2) {
  return items
    .map((item) => ({ item, score: similarity(query, text(item)) }))
    .filter((entry) => entry.score >= minimum)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item)
}
