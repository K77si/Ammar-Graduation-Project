function hasArabic(text: string) {
  return /[\u0600-\u06FF]/.test(text)
}

function braceEnd(text: string, start: number) {
  let depth = 0
  let quote = ''
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\') { index += 1; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function jsonChunks(text: string) {
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{') continue
    const end = braceEnd(text, index)
    if (end <= index) continue
    chunks.push(text.slice(index, end + 1))
    index = end
  }
  return chunks
}

function schemaAnswer(text: string) {
  for (const chunk of jsonChunks(text)) {
    try {
      const parsed = JSON.parse(chunk) as { answer?: unknown }
      if (typeof parsed.answer === 'string' && parsed.answer.trim()) return parsed.answer.trim()
    } catch {
      continue
    }
  }
  return ''
}

function stripJson(text: string) {
  let result = ''
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '{') {
      const end = braceEnd(text, index)
      if (end > index) { index = end; continue }
    }
    result += text[index]
  }
  return result
}

function leakLine(line: string) {
  if (/tool result|verified lookup|don't rely|would you like me|i'm sorry|i am sorry|cannot provide|can't provide/i.test(line)) return true
  if (/يتعارض مع ما ذكرته|قد أكون أخطأت/.test(line)) return true
  const arabic = (line.match(/[\u0600-\u06FF]/g) || []).length
  const latin = (line.match(/[A-Za-z]/g) || []).length
  return latin > 8 && arabic === 0
}

export function visibleAnswer(raw: string) {
  const source = schemaAnswer(raw) || raw || ''
  const lines = stripJson(source).split('\n').map((line) => line.trim()).filter(Boolean).filter((line) => !leakLine(line))
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return hasArabic(text) ? text.slice(0, 4000) : ''
}

function textOf(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

export function answerFromTools(outputs: Array<Record<string, unknown>>) {
  const lines: string[] = []
  for (const data of outputs) {
    if (data.ok === false && typeof data.error === 'string' && hasArabic(data.error)) {
      lines.push(data.error)
      continue
    }
    if (typeof data.count === 'number') {
      const department = textOf(data.department)
      const scope = department && department !== 'all' ? ` في ${department}` : ''
      lines.push(`عدد الحسابات${scope}: ${data.count}.`)
      continue
    }
    if (Array.isArray(data.employees)) {
      const names = data.employees.flatMap((row) => {
        if (!row || typeof row !== 'object') return []
        const name = textOf((row as Record<string, unknown>).full_name)
        return name ? [name] : []
      })
      lines.push(names.length ? `لقيت ${names.length}: ${names.join('، ')}.` : 'ما لقيت حساباً مطابقاً.')
      continue
    }
    if (typeof data.open === 'number' && typeof data.pending === 'number' && typeof data.closed === 'number') {
      const title = data.scope === 'department' ? 'بلاغات القسم' : data.scope === 'own' ? 'بلاغاتك' : 'البلاغات الظاهرة لك'
      lines.push(`ملخص ${title}: المفتوحة وقيد المعالجة ${data.open}، بانتظار الموظف ${data.pending}، المنجزة والمغلقة ${data.closed}.`)
      continue
    }
    if (typeof data.ticket_number === 'number' || (typeof data.ticket_number === 'string' && data.ticket_number)) {
      lines.push(`تم فتح البلاغ رقم ${data.ticket_number}.`)
      continue
    }
    if (textOf(data.full_name) && textOf(data.email)) {
      lines.push(`تم إنشاء الحساب: ${textOf(data.full_name)}.`)
      continue
    }
    if (data.updated && typeof data.updated === 'object') {
      lines.push('تم تعديل الحساب.')
      continue
    }
    if (data.claimed_self === true || textOf(data.status)) {
      const bits = [data.claimed_self === true ? 'تم استلام البلاغ' : '', textOf(data.status) ? `الحالة: ${textOf(data.status)}` : ''].filter(Boolean)
      if (bits.length) lines.push(`${bits.join('، ')}.`)
    }
  }
  return lines.filter((line, index) => lines.indexOf(line) === index).join('\n')
}
