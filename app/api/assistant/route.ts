import Anthropic from '@anthropic-ai/sdk'
import { getActor, serviceClient } from '@/lib/server-auth'
import { FAULT_TYPES } from '@/lib/workflow'
import { rankSimilar } from '@/lib/similar'
import { readTicketMeta } from '@/lib/ticket-thread'

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5'
const WINDOW_MS = 10 * 60 * 1000
const MAX_QUESTIONS = 15
const usage = new Map<string, number[]>()

function apiKey() {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim()
  return key.startsWith('sk-ant-') && key.length > 40 ? key : ''
}

async function assistantEnabled() {
  const { data } = await serviceClient().from('system_settings').select('ai_enabled').eq('id', 'main_settings').maybeSingle()
  return data?.ai_enabled !== false
}

function allowRequest(userId: string) {
  const now = Date.now()
  const recent = (usage.get(userId) || []).filter((time) => now - time < WINDOW_MS)
  if (recent.length >= MAX_QUESTIONS) {
    usage.set(userId, recent)
    return false
  }
  recent.push(now)
  usage.set(userId, recent)
  return true
}

function readJson(text: string) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function GET(request: Request) {
  const actor = await getActor(request)
  if (!actor) return Response.json({ error: 'يلزم تسجيل الدخول.' }, { status: 401 })
  return Response.json({ configured: Boolean(apiKey()), enabled: await assistantEnabled() })
}

export async function POST(request: Request) {
  const actor = await getActor(request)
  if (!actor) return Response.json({ error: 'يلزم تسجيل الدخول.' }, { status: 401 })

  const key = apiKey()
  if (!key) return Response.json({ error: 'المساعد الذكي غير مفعّل بعد. يحتاج مدير النظام إضافة مفتاح Anthropic على الخادم.' }, { status: 503 })
  if (!(await assistantEnabled())) return Response.json({ error: 'المساعد الذكي متوقف من إعدادات النظام.' }, { status: 403 })

  const body = await request.json().catch(() => null) as { question?: string; audience?: string } | null
  const question = (body?.question || '').trim()
  const staff = actor.role === 'technician' || actor.role === 'manager' || actor.role === 'admin'
  const forTechnician = body?.audience === 'technician' && staff
  if (question.length < 5) return Response.json({ error: 'صِف مشكلتك في 5 أحرف على الأقل.' }, { status: 400 })
  if (question.length > 600) return Response.json({ error: 'اختصر وصف المشكلة إلى 600 حرف أو أقل.' }, { status: 400 })
  if (!allowRequest(actor.id)) return Response.json({ error: 'وصلت إلى الحد المسموح من الأسئلة. حاول بعد عشر دقائق.' }, { status: 429 })

  const [{ data: faqs }, { data: solvedRows }] = await Promise.all([
    serviceClient().from('faq_items').select('title, body').order('sort_order', { ascending: true }),
    serviceClient().from('tickets').select('title, fault_type, resolution').in('status', ['منجزة', 'مغلقة']).not('resolution', 'is', null).order('resolved_at', { ascending: false, nullsFirst: false }).limit(300)
  ])
  const knowledge = (faqs || []).map((item) => `- ${item.title}: ${item.body}`).join('\n')
  const solved = (solvedRows || [])
    .map((row) => ({ problem: readTicketMeta(row.title).problem, fault: row.fault_type || '', resolution: String(row.resolution || '').trim() }))
    .filter((row) => row.resolution.length >= 3)
  const pastFixes = rankSimilar(question, solved, (row) => row.problem, 5, 0.25)
    .map((row) => `- المشكلة: ${row.problem.slice(0, 160)}${row.fault ? ` (${row.fault})` : ''} | الحل: ${row.resolution.slice(0, 240)}`)
    .join('\n')

  const audienceRules = forTechnician
    ? [
        'تساعد فني الدعم التقني على تشخيص البلاغ وحله.',
        'اكتب بالعربية الفصحى الواضحة، بجمل قصيرة ودقيقة، ويجوز ذكر المصطلحات التقنية بالإنجليزية بين قوسين.',
        'اقترح خطوات تشخيص وإصلاح مرتبة من الأسرع إلى الأعمق، بحد أقصى خمس خطوات، ويجوز أن تتطلب صلاحيات فني.',
        'لا تطلب كلمة مرور ولا أي بيانات سرية، ونبّه قبل أي خطوة قد تمسح بيانات.',
        'اجعل needs_ticket صحيحاً إذا كانت المشكلة تحتاج قطعة غيار أو جهة خارجية أو تصعيداً.'
      ]
    : [
        'تساعد الموظف على حل مشكلته التقنية بنفسه قبل فتح بلاغ للدعم التقني.',
        'اكتب بالعربية الفصحى الواضحة، بجمل قصيرة ومهذبة.',
        'اقترح خطوات آمنة يستطيع الموظف تنفيذها دون صلاحيات مدير، بحد أقصى خمس خطوات.',
        'لا تطلب كلمة مرور ولا أي بيانات سرية، ولا تقترح تعطيل برامج الحماية أو تعديل إعدادات الشبكة أو النظام.',
        'إذا كانت المشكلة تحتاج فنياً أو صلاحيات أو قطعة غيار أو تؤثر على أكثر من شخص، فاطلب فتح بلاغ.'
      ]
  const system = [
    'أنت المساعد الذكي في «سند»، منصة الدعم الفني الداخلية لجهة عمل.',
    ...audienceRules,
    'إذا كان السؤال خارج الدعم التقني فاعتذر باختصار ووجّه الموظف إلى الجهة المختصة.',
    `أنواع الأعطال المعتمدة: ${FAULT_TYPES.join('، ')}.`,
    knowledge ? `حلول معتمدة لدى الجهة:\n${knowledge}` : '',
    pastFixes ? `حلول نجحت سابقاً لدى الدعم التقني في مشاكل مشابهة، استفد منها إن ناسبت المشكلة، ولا تذكر أسماء أشخاص أو أرقام بلاغات أو أجهزة منها:\n${pastFixes}` : '',
    'أعد JSON فقط بهذا الشكل دون أي نص خارجه:',
    '{"answer": "خلاصة من جملة أو جملتين", "steps": ["خطوة"], "fault_type": "أحد أنواع الأعطال", "urgent": false, "needs_ticket": false}',
    'اجعل urgent صحيحاً فقط إذا كان العمل متوقفاً تماماً.'
  ].filter(Boolean).join('\n')

  try {
    const client = new Anthropic({ apiKey: key })
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      system,
      messages: [{ role: 'user', content: question }]
    })
    const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('').trim()
    const parsed = readJson(text)
    if (!parsed) {
      return Response.json({ answer: text || 'لم أستطع اقتراح حل. افتح بلاغاً وسيتابعه الدعم التقني.', steps: [], fault_type: 'أخرى', urgent: false, needs_ticket: true })
    }
    const fault = String(parsed.fault_type || '')
    return Response.json({
      answer: String(parsed.answer || '').slice(0, 800),
      steps: Array.isArray(parsed.steps) ? parsed.steps.map((step) => String(step).slice(0, 300)).slice(0, 5) : [],
      fault_type: (FAULT_TYPES as readonly string[]).includes(fault) ? fault : 'أخرى',
      urgent: parsed.urgent === true,
      needs_ticket: parsed.needs_ticket !== false
    })
  } catch (error) {
    const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status?: number }).status) : 0
    if (status === 401 || status === 403) return Response.json({ error: 'مفتاح المساعد الذكي غير صحيح. راجع المفتاح على الخادم.' }, { status: 502 })
    if (status === 429) return Response.json({ error: 'المساعد مشغول حالياً. حاول بعد قليل.' }, { status: 503 })
    return Response.json({ error: 'تعذّر الوصول إلى المساعد الذكي. حاول مرة أخرى أو افتح بلاغاً.' }, { status: 502 })
  }
}
