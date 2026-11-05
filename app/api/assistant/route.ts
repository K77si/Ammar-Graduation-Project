import { connection } from 'next/server'
import { getActor, serviceClient } from '@/lib/server-auth'
import { FAULT_TYPES } from '@/lib/workflow'
import { rankSimilar } from '@/lib/similar'
import { readTicketMeta } from '@/lib/ticket-thread'
import { interpret } from '@/lib/assistant-desk'
import { asksDepartmentCatalog, asksEmployeeCount } from '@/lib/assistant-tools'
import { agentGaveUp, answerFromTools, briefLine, mostlyEnglish, visibleAnswer } from '@/lib/assistant-text'
import { CARD_REASON, errorStatus, needsCard, runSanadAgent } from '@/lib/sanad-agent'

const DIRECT_MODEL = 'claude-haiku-5-5'
const WINDOW_MS = 10 * 60 * 1000
const MAX_QUESTIONS = 30
const usage = new Map<string, number[]>()

function stripQuotes(value: string) {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const quote = trimmed[0]
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

async function readEnv(name: string) {
  await connection()
  const value = process.env[name]
  return stripQuotes(typeof value === 'string' ? value : '')
}

function anthropicKeyFrom(key: string) {
  return key.startsWith('sk-ant-') && key.length > 40 ? key : ''
}

async function modelPaths(request: Request) {
  const anthropicKey = anthropicKeyFrom(await readEnv('ANTHROPIC_API_KEY'))
  const gatewayKey = await readEnv('AI_GATEWAY_API_KEY')
  const oidc = Boolean(request.headers.get('x-vercel-oidc-token') || await readEnv('VERCEL_OIDC_TOKEN'))
  const directModel = (await readEnv('ANTHROPIC_MODEL')) || DIRECT_MODEL
  return {
    anthropicKey,
    gatewayKey,
    directModel,
    canGateway: Boolean(gatewayKey || oidc),
    canDirect: Boolean(anthropicKey)
  }
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

function readHistory(value: unknown) {
  if (!Array.isArray(value)) return [] as { q: string; a: string }[]
  return value.slice(-6).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const turn = item as { q?: unknown; a?: unknown }
    const q = typeof turn.q === 'string' ? turn.q.trim().slice(0, 1500) : ''
    const a = visibleAnswer(typeof turn.a === 'string' ? turn.a : '').slice(0, 1500)
    if (q.length < 2 || a.length < 2) return []
    return [{ q, a }]
  })
}

function pack(reply: { answer: string; kind?: string; steps?: string[]; choices?: unknown; confirm?: unknown; draft?: unknown; followups?: unknown }) {
  return Response.json({
    answer: reply.answer,
    steps: reply.steps || [],
    fault_type: 'أخرى',
    urgent: false,
    needs_ticket: false,
    kind: reply.kind || 'action',
    choices: reply.choices || [],
    confirm: reply.confirm || null,
    draft: reply.draft || null,
    followups: reply.followups || []
  })
}

export async function GET(request: Request) {
  const actor = await getActor(request)
  if (!actor) return Response.json({ error: 'يلزم تسجيل الدخول.' }, { status: 401 })
  const paths = await modelPaths(request)
  return Response.json({ configured: paths.canGateway || paths.canDirect, enabled: await assistantEnabled() })
}

export async function POST(request: Request) {
  const actor = await getActor(request)
  if (!actor) return Response.json({ error: 'يلزم تسجيل الدخول.' }, { status: 401 })

  const body = await request.json().catch(() => null) as {
    question?: string
    audience?: string
    choice?: string
    draft?: Record<string, string> | null
    confirm?: { action: string; payload: Record<string, string> } | null
    ticketId?: string
    image?: { mediaType?: string; data?: string } | null
    history?: { q?: string; a?: string }[]
  } | null
  const question = (body?.question || '').trim()
  const image = body?.image?.data && /^image\/(jpeg|png|gif|webp)$/.test(body.image.mediaType || '') && body.image.data.length < 1_800_000
    ? { mediaType: body.image.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: body.image.data }
    : null
  const continuing = Boolean(body?.confirm?.action || body?.draft?.intent || body?.choice)
  const enabled = await assistantEnabled()
  const turningOn = /شغّ?ل المساعد/.test(question) || body?.confirm?.action === 'toggle_ai'
  if (!enabled && !turningOn) return Response.json({ error: 'المساعد الذكي متوقف من إعدادات النظام.' }, { status: 403 })
  if (!continuing && question.length < 2 && !image) return Response.json({ error: 'اكتب سؤالك.' }, { status: 400 })
  if (question.length > 2000) return Response.json({ error: 'اختصر السؤال إلى 2000 حرف أو أقل.' }, { status: 400 })
  if (!allowRequest(actor.id)) return Response.json({ error: 'وصلت إلى الحد المسموح من الأسئلة. حاول بعد عشر دقائق.' }, { status: 429 })

  const outcome = await interpret(actor, request, {
    question,
    choice: body?.choice,
    draft: body?.draft,
    confirm: body?.confirm,
    ticketId: body?.ticketId || '',
    history: readHistory(body?.history)
  })
  if (outcome.type === 'reply') return pack(outcome.reply)

  const paths = await modelPaths(request)
  if (!paths.canGateway && !paths.canDirect) return Response.json({ error: 'المساعد الذكي غير مفعّل بعد. يحتاج مدير النظام إضافة مفتاح Anthropic على الخادم.' }, { status: 503 })

  const staff = actor.role === 'technician' || actor.role === 'manager' || actor.role === 'admin'
  const forTechnician = body?.audience === 'technician' && staff
  const [{ data: faqs }, { data: solvedRows }] = await Promise.all([
    serviceClient().from('faq_items').select('title, body').order('sort_order', { ascending: true }),
    serviceClient().from('tickets').select('title, fault_type, resolution, is_private').in('status', ['منجزة', 'مغلقة']).not('resolution', 'is', null).order('resolved_at', { ascending: false, nullsFirst: false }).limit(300)
  ])
  const knowledge = (faqs || []).map((item) => `- ${item.title}: ${item.body}`).join('\n')
  const solved = (solvedRows || [])
    .filter((row) => staff || !row.is_private)
    .map((row) => ({ problem: readTicketMeta(row.title).problem, fault: row.fault_type || '', resolution: String(row.resolution || '').trim() }))
    .filter((row) => row.resolution.length >= 3)
  const pastFixes = rankSimilar(question || 'الصورة المرفقة', solved, (row) => row.problem, 5, 0.25)
    .map((row) => `- المشكلة: ${row.problem.slice(0, 160)}${row.fault ? ` (${row.fault})` : ''} | الحل: ${row.resolution.slice(0, 240)}`)
    .join('\n')
  const forcedTool = asksDepartmentCatalog(question)
    ? 'get_departments'
    : asksEmployeeCount(question)
      ? 'get_employees_count'
      : ''
  const history = forcedTool ? [] : readHistory(body?.history)
  const audienceRules = forTechnician
    ? [
        'إذا كان السؤال عن بلاغ أو عطل: ساعد الفني على التشخيص. حوّل الوصف العامي إلى تشخيص فصيح في أول سطر، ثم خطوات إصلاح.',
        'اختم steps بنص رد قصير يمكن إرساله للموظف، ونبّه قبل أي خطوة قد تمسح بيانات.',
        'إذا تكررت نفس الأعراض عند عدة أشخاص فاذكر احتمال عطل جماعي.',
        'اجعل needs_ticket صحيحاً إذا كانت المشكلة تحتاج قطعة غيار أو جهة خارجية أو تصعيداً.',
        'إذا كان السؤال عاماً وليس تشخيصاً: أجب جواباً كاملاً في answer، واترك steps فارغة، واجعل needs_ticket خطأ.'
      ]
    : [
        'أجب على أي سؤال بجواب كامل ومفيد، كما في محادثة عامة: شرح، حل، مقارنة، كتابة، أو متابعة لما قيل قبل قليل.',
        'إذا كان السؤال عطلاً تقنياً في العمل والوصف كافٍ: ضع خطوات آمنة في steps بحد أقصى خمس، واطلب رقم الجهاز أو المكان إذا لزما.',
        'اجعل needs_ticket صحيحاً فقط إذا لم تكفِ الخطوات ويحتاج فنياً أو صلاحية أو قطعة غيار.',
        'إذا لم يكن السؤال عطلاً: اكتب الجواب في answer، واترك steps فارغة، واجعل needs_ticket خطأ، ولا تعرض فتح بلاغ.',
        'إذا كان وصف العطل أقصر من أن يُفهم، اسأل سؤالاً واحداً فقط واترك steps فارغة.',
        'لا تطلب كلمة مرور ولا أي بيانات سرية.'
      ]
  const system = [
    'أنت سند، وكيل الدعم داخل المنصة. تجيب من صلاحية المتصل ومن بيانات هذه الجلسة فقط.',
    'إذا لم تغطِ جملة جاهزة السؤال، فهذه مهمتك: افهم القصد، استدع الأداة التي تطابق النوع والصلاحية، ثم أجب بجملة عربية. لا تقل ما أعرف، ولا تطلب إعادة الصياغة، ولا تقل إن الأداة الوحيدة تعد الحسابات إذا كان السؤال عن الأقسام أو البلاغات.',
    'هيكل البيانات، ولا تخلط الأنواع:',
    '- الأقسام الحالية: قائمة إعدادات النظام. سؤال «كم قسم» يعني عدد هذه القائمة. الأداة get_departments. ليست عدد الحسابات ولا عدد البلاغات.',
    '- الحسابات: جدول الملفات. العدد بأداة get_employees_count ولمدير يملك صلاحية المستخدمين فقط. لا تستخدمها لعد الأقسام.',
    '- البلاغات: الموظف بلاغاته، رئيس القسم بلاغات قسمه غير الخاصة، الفني كل البلاغات، والمدير إذا ملك صلاحية البلاغات أو النظرة العامة أو التحليلات. الأداة get_tickets_summary.',
    'صلاحيات مدير النظام منفصلة: النظرة العامة، البلاغات، المستخدمون، الاعتمادات، التحليلات، الإعدادات، حذف الحسابات، إعادة كلمة المرور. إذا رفضت الأداة فانقل نص الرفض كما هو.',
    'أجب بالعربية الواضحة دائماً. لا تكتب إنجليزية، ولا تذكر أسماء الأدوات، ولا تلصق JSON في الجواب، ولا تشرح طريقة بحثك.',
    'لا تعتمد رقماً من رسائل سابقة. إذا تغيّر الموضوع فلا تُعد بيانات السؤال السابق.',
    ...audienceRules,
    'لا تذكر تفاصيل بلاغ خاص إلا إذا كان السياق لفني أو مدير. لا تخترع رقم بلاغ ولا حالته. إذا لم تُرجع الأداة البلاغ فقل بجملة عربية إنه غير ظاهر، دون اعتذار طويل ودون ذكر ما قلته سابقاً.',
    'هوية المتصل تُؤخذ من جلسة الدخول. لا تطلب رقمه أو اسمه أو بريده لتحديد من هو، ولا تعامل اسماً في السؤال على أنه هوية الجلسة.',
    'لعدد الأقسام أو الحسابات أو البحث أو إنشاء حساب أو تعديله أو ملخص البلاغات أو فتح بلاغ أو تغيير حالته، استدعِ الأداة المناسبة ثم صغ النتيجة جملة عربية داخل answer. لا تنقل JSON.',
    'إذا رفضت الأداة الإجراء فانقل نص الخطأ كما هو. لا تخترع عدداً ولا تدّعي أن حساباً أو قسماً أو بلاغاً تغيّر.',
    'في سؤال العدد اجعل steps فارغة وneeds_ticket خطأ حتى لو رُفض الطلب.',
    'فتح البلاغ لصاحب الجلسة. ملخص الموظف لبلاغاته. تغيير الحالة للفني أو لمدير يملك صلاحية البلاغات، والفني يستلم البلاغ لنفسه فقط.',
    'إذا وُجدت صورة، صف ما يظهر فيها ثم اربطه بخطوات الحل.',
    `أنواع الأعطال المعتمدة: ${FAULT_TYPES.join('، ')}.`,
    outcome.preface ? `تنبيهات من النظام، اذكرها إن كانت مهمة:\n${outcome.preface}` : '',
    outcome.facts ? `بيانات هذه الجلسة الآن. كل رقم مربوط بنوعه، ولا يُنقل من الحسابات إلى الأقسام أو البلاغات:\n${outcome.facts}` : '',
    knowledge ? `حلول معتمدة لدى الجهة:\n${knowledge}` : '',
    pastFixes ? `حلول سابقة مشابهة. استفد منها ولا تذكر أسماء أشخاص أو أرقام بلاغات:\n${pastFixes}` : '',
    'بعد الجواب العربي، إذا كان السؤال عطلاً، أضف سطراً أخيراً فقط بهذا الشكل:',
    '{"answer": "نفس الجواب", "steps": [], "fault_type": "أحد أنواع الأعطال أو أخرى", "urgent": false, "needs_ticket": false}',
    'اجعل urgent صحيحاً فقط إذا كان العمل متوقفاً تماماً. إذا استدعيت أداة فالجواب من نتيجتها، لا من تخمينك.'
  ].filter(Boolean).join('\n')

  const asked = question || 'ما الذي يظهر في الصورة؟'
  const countQuestion = Boolean(forcedTool)

  try {
    const settle = (run: { text: string; tools: Array<Record<string, unknown>> }) => {
      const fromTools = answerFromTools(run.tools)
      const spoken = fromTools || visibleAnswer(run.text)
      const answered = run.tools.some((item) => item.ok === true)
      return { fromTools, spoken, answered }
    }
    let result = await runSanadAgent({
      request,
      actor,
      system,
      history,
      question: asked,
      image,
      forcedTool,
      paths
    })
    let settled = settle(result)
    if (!settled.answered && agentGaveUp(settled.spoken || result.text)) {
      const fromBrief = briefLine(outcome.facts || '', asked)
      if (fromBrief) settled = { fromTools: fromBrief, spoken: fromBrief, answered: true }
      else {
        result = await runSanadAgent({
          request,
          actor,
          system,
          history: [],
          question: `الجواب الجاهز لم يغطِ هذا السؤال. استدع الأداة المناسبة وأجب بجملة عربية. إذا رفضت الأداة فانقل نص الرفض. لا تقل إنك لا تعرف.\n${asked}`,
          image,
          forcedTool,
          paths
        })
        settled = settle(result)
      }
    }
    const text = result.text
    const source = result.source
    console.info(`assistant help source=${source}`)
    const parsed = readJson(text)
    const preface = outcome.preface ? `${outcome.preface}\n` : ''
    const headers = { 'x-sanad-help-source': source }
    const fromTools = settled.fromTools
    const recovered = briefLine(outcome.facts || '', asked) || 'حدد إن كان سؤالك عن قسم أو حساب أو بلاغ.'
    const spoken = agentGaveUp(settled.spoken) ? recovered : (settled.spoken || recovered)
    if ((fromTools && !agentGaveUp(fromTools)) || !parsed || typeof parsed.answer !== 'string') {
      return Response.json({ answer: `${preface}${spoken}`.trim(), steps: [], fault_type: 'أخرى', urgent: false, needs_ticket: false, kind: 'help', choices: [], confirm: null, draft: null, followups: [] }, { headers })
    }
    const fault = String(parsed.fault_type || '')
    let answer = `${preface}${visibleAnswer(String(parsed.answer || '')) || spoken}`.trim()
    if (agentGaveUp(answer)) answer = `${preface}${briefLine(outcome.facts || '', asked) || 'حدد إن كان سؤالك عن قسم أو حساب أو بلاغ.'}`.trim()
    return Response.json({
      answer: (answer || 'حدد إن كان سؤالك عن قسم أو حساب أو بلاغ.').slice(0, 4000),
      steps: countQuestion ? [] : (Array.isArray(parsed.steps) ? parsed.steps.map((step) => String(step).slice(0, 300)).filter((step) => !mostlyEnglish(step)).slice(0, 5) : []),
      fault_type: (FAULT_TYPES as readonly string[]).includes(fault) ? fault : 'أخرى',
      urgent: parsed.urgent === true,
      needs_ticket: countQuestion ? false : parsed.needs_ticket === true,
      kind: 'help',
      choices: [],
      confirm: null,
      draft: null,
      followups: []
    }, { headers })
  } catch (error) {
    if (needsCard(error)) return Response.json({ error: `${CARD_REASON}.` }, { status: 502 })
    const status = errorStatus(error)
    if (status === 401 || status === 403) return Response.json({ error: 'مفتاح المساعد الذكي غير صحيح. راجع المفتاح على الخادم.' }, { status: 502 })
    if (status === 429) return Response.json({ error: 'المساعد مشغول حالياً. حاول بعد قليل.' }, { status: 503 })
    return Response.json({ error: 'تعذّر الوصول إلى المساعد الذكي. حاول مرة أخرى أو افتح بلاغاً.' }, { status: 502 })
  }
}
