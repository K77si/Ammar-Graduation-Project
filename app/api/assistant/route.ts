import Anthropic from '@anthropic-ai/sdk'
import { createGateway, generateText, stepCountIs } from 'ai'
import { connection } from 'next/server'
import { getActor, serviceClient } from '@/lib/server-auth'
import { FAULT_TYPES } from '@/lib/workflow'
import { rankSimilar } from '@/lib/similar'
import { readTicketMeta } from '@/lib/ticket-thread'
import { interpret } from '@/lib/assistant-desk'
import { anthropicTools, asksEmployeeCount, assistantGatewayTools, runAssistantTool } from '@/lib/assistant-tools'

const GATEWAY_MODEL = 'anthropic/claude-haiku-5-5'
const DIRECT_MODEL = 'claude-haiku-5-5'
const CARD_REASON = 'AI Gateway requires a valid credit card on file'
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

function errorStatus(error: unknown): number {
  if (!error || typeof error !== 'object') return 0
  const record = error as { status?: unknown; statusCode?: unknown; cause?: unknown }
  const status = Number(record.statusCode ?? record.status ?? 0)
  if (status) return status
  return errorStatus(record.cause)
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const record = error as { message?: unknown; responseBody?: unknown; data?: unknown; cause?: unknown }
  const data = record.data == null ? '' : typeof record.data === 'string' ? record.data : JSON.stringify(record.data)
  return [
    typeof record.message === 'string' ? record.message : '',
    typeof record.responseBody === 'string' ? record.responseBody : '',
    data,
    errorText(record.cause)
  ].filter(Boolean).join('\n')
}

function needsCard(error: unknown) {
  return errorText(error).includes(CARD_REASON)
}

function thinkingRejected(error: unknown) {
  if (needsCard(error)) return false
  const status = errorStatus(error)
  if (status && status !== 400 && status !== 422) return false
  return /thinking|reasoning/i.test(errorText(error))
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
  } | null
  const question = (body?.question || '').trim()
  const image = body?.image?.data && /^image\/(jpeg|png|gif|webp)$/.test(body.image.mediaType || '') && body.image.data.length < 1_800_000
    ? { mediaType: body.image.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: body.image.data }
    : null
  const continuing = Boolean(body?.confirm?.action || body?.draft?.intent || body?.choice)
  const enabled = await assistantEnabled()
  const turningOn = /شغّ?ل المساعد/.test(question) || body?.confirm?.action === 'toggle_ai'
  if (!enabled && !turningOn) return Response.json({ error: 'المساعد الذكي متوقف من إعدادات النظام.' }, { status: 403 })
  if (!continuing && question.length < 5 && !image) return Response.json({ error: 'صِف مشكلتك في 5 أحرف على الأقل.' }, { status: 400 })
  if (question.length > 600) return Response.json({ error: 'اختصر وصف المشكلة إلى 600 حرف أو أقل.' }, { status: 400 })
  if (!allowRequest(actor.id)) return Response.json({ error: 'وصلت إلى الحد المسموح من الأسئلة. حاول بعد عشر دقائق.' }, { status: 429 })

  const outcome = await interpret(actor, request, { question, choice: body?.choice, draft: body?.draft, confirm: body?.confirm, ticketId: body?.ticketId || '' })
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
  const audienceRules = forTechnician
    ? [
        'تساعد فني الدعم التقني على تشخيص البلاغ وحله.',
        'حوّل الوصف العامي إلى تشخيص فصيح في أول سطر، ثم خطوات إصلاح.',
        'اكتب بالعربية الفصحى الواضحة، بجمل قصيرة، ويجوز ذكر اسم الجهاز بالإنجليزية.',
        'إذا كان نوع العطل غير واضح فاختر الأقرب من الأنواع المعتمدة ولا تتركه «أخرى» إلا إذا استحال ذلك.',
        'اختم steps بنص رد قصير يمكن إرساله للموظف، ونبّه قبل أي خطوة قد تمسح بيانات.',
        'إذا تكررت نفس الأعراض عند عدة أشخاص فاذكر احتمال عطل جماعي.',
        'اجعل needs_ticket صحيحاً إذا كانت المشكلة تحتاج قطعة غيار أو جهة خارجية أو تصعيداً.'
      ]
    : [
        'تساعد الموظف على حل مشكلته التقنية بنفسه قبل فتح بلاغ.',
        'إذا كان الوصف أقصر من عرض واضح، اسأل سؤالاً واحداً فقط: منذ متى، وهل الجهاز واحد، وهل الشبكة تعمل. واترك steps فارغة.',
        'إذا الوصف كافٍ فابدأ answer بسطر: العنوان المقترح: ثم عنوان قصير للبلاغ.',
        'اقترح خطوات آمنة بحد أقصى خمس، واطلب رقم الجهاز أو المكان إذا كان العطل يحتاجه.',
        'إذا كانت المشكلة عند أكثر من شخص فقل ذلك واطلب بلاغاً أو بلاغ تعطل قسم.',
        'لا تطلب كلمة مرور ولا أي بيانات سرية.',
        'إذا كان السؤال خارج الدعم التقني وليس عن بلاغات هذا الحساب، فاعتذر ووجّه الموظف للجهة المختصة.',
        'إذا كانت المشكلة تحتاج فنياً أو صلاحيات أو قطعة غيار، فاطلب فتح بلاغ.'
      ]
  const system = [
    'أنت المساعد الذكي في «سند»، منصة الدعم الفني الداخلية.',
    ...audienceRules,
    'لا تذكر تفاصيل بلاغ خاص إلا إذا كان السياق لفني أو مدير. لا تخترع أرقاماً.',
    'هوية المتصل تُؤخذ من جلسة الدخول. لا تطلب رقمه أو اسمه أو بريده لتحديد من هو، ولا تعامل اسماً في السؤال على أنه هوية الجلسة.',
    'لعدد الحسابات أو البحث أو إنشاء حساب أو تعديله أو ملخص البلاغات أو فتح بلاغ أو تغيير حالته، استدعِ الأداة ثم انقل JSON الناتج حرفياً.',
    'إذا رفضت الأداة الإجراء فانقل نص الخطأ كما هو. لا تخترع عدداً ولا تدّعي أن حساباً أو بلاغاً تغيّر.',
    'عدد الموظفين والبحث في الدليل وإنشاء الحسابات وتعديلها لمدير النظام الذي يملك صلاحية المستخدمين فقط.',
    'في سؤال العدد اجعل steps فارغة وneeds_ticket خطأ حتى لو رُفض الطلب.',
    'فتح البلاغ لصاحب الجلسة. ملخص الموظف لبلاغاته. تغيير الحالة للفني أو لمدير يملك صلاحية البلاغات، والفني يستلم البلاغ لنفسه فقط.',
    'إذا وُجدت صورة، صف ما يظهر فيها ثم اربطه بخطوات الحل.',
    `أنواع الأعطال المعتمدة: ${FAULT_TYPES.join('، ')}.`,
    outcome.preface ? `تنبيهات من النظام، اذكرها إن كانت مهمة:\n${outcome.preface}` : '',
    outcome.facts ? `أرقام هذا الحساب. استخدمها حرفياً إذا سأل عن العدد:\n${outcome.facts}` : '',
    knowledge ? `حلول معتمدة لدى الجهة:\n${knowledge}` : '',
    pastFixes ? `حلول سابقة مشابهة. استفد منها ولا تذكر أسماء أشخاص أو أرقام بلاغات:\n${pastFixes}` : '',
    'أعد JSON فقط بهذا الشكل دون أي نص خارجه:',
    '{"answer": "خلاصة", "steps": ["خطوة"], "fault_type": "أحد أنواع الأعطال", "urgent": false, "needs_ticket": false}',
    'اجعل urgent صحيحاً فقط إذا كان العمل متوقفاً تماماً.'
  ].filter(Boolean).join('\n')

  const asked = question || 'ما الذي يظهر في الصورة؟'
  const userContent = image
    ? [
        { type: 'file' as const, mediaType: image.mediaType, data: image.data },
        { type: 'text' as const, text: asked }
      ]
    : asked

  const countQuestion = asksEmployeeCount(question)
  const gatewayTools = assistantGatewayTools(actor, request)

  const gatewayText = async () => {
    const model = paths.gatewayKey ? createGateway({ apiKey: paths.gatewayKey })(GATEWAY_MODEL) : GATEWAY_MODEL
    const run = (disableThinking: boolean) => generateText({
      model,
      system,
      tools: gatewayTools,
      stopWhen: stepCountIs(4),
      prepareStep: ({ stepNumber }) => (
        stepNumber === 0 && countQuestion
          ? { toolChoice: { type: 'tool', toolName: 'get_employees_count' } }
          : { toolChoice: 'auto' }
      ),
      maxOutputTokens: 2000,
      ...(disableThinking ? { reasoning: 'none' as const } : {}),
      ...(image ? { messages: [{ role: 'user' as const, content: userContent }] } : { prompt: asked })
    })
    try {
      return (await run(true)).text.trim()
    } catch (error) {
      if (!thinkingRejected(error)) throw error
      return (await run(false)).text.trim()
    }
  }

  const directText = async () => {
    const client = new Anthropic({ apiKey: paths.anthropicKey })
    const content = image
      ? [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType, data: image.data } },
          { type: 'text' as const, text: asked }
        ]
      : asked
    const run = async (disableThinking: boolean) => {
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content }]
      let text = ''
      for (let step = 0; step < 3; step += 1) {
        const message = await client.messages.create({
          model: paths.directModel,
          max_tokens: 2000,
          system,
          tools: anthropicTools,
          tool_choice: step === 0 && countQuestion ? { type: 'tool', name: 'get_employees_count' } : { type: 'auto' },
          ...(disableThinking ? { thinking: { type: 'disabled' as const } } : {}),
          messages
        })
        text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('').trim()
        const calls = message.content.filter((part) => part.type === 'tool_use')
        if (!calls.length) return text
        const assistantContent: Anthropic.ContentBlockParam[] = []
        for (const part of message.content) {
          if (part.type === 'text') assistantContent.push({ type: 'text', text: part.text })
          else if (part.type === 'tool_use') assistantContent.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input })
          else if (part.type === 'thinking') assistantContent.push({ type: 'thinking', thinking: part.thinking, signature: part.signature })
          else if (part.type === 'redacted_thinking') assistantContent.push({ type: 'redacted_thinking', data: part.data })
        }
        const results: Anthropic.ToolResultBlockParam[] = []
        for (const part of calls) {
          const output = await runAssistantTool(part.name, part.input, actor, request)
          results.push({
            type: 'tool_result',
            tool_use_id: part.id,
            content: JSON.stringify(output),
            is_error: output.ok === false
          })
        }
        messages.push({ role: 'assistant', content: assistantContent })
        messages.push({ role: 'user', content: results })
      }
      return text
    }
    try {
      return await run(true)
    } catch (error) {
      if (!thinkingRejected(error)) throw error
      return await run(false)
    }
  }

  try {
    let text = ''
    let source = ''
    if (paths.canGateway) {
      try {
        text = await gatewayText()
        source = 'gateway'
      } catch (error) {
        if (!needsCard(error) || !paths.canDirect) {
          if (needsCard(error)) return Response.json({ error: `${CARD_REASON}.` }, { status: 502 })
          throw error
        }
        text = await directText()
        source = 'anthropic-fallback'
      }
    } else {
      text = await directText()
      source = 'anthropic'
    }
    console.info(`assistant help source=${source}`)
    const parsed = readJson(text)
    const preface = outcome.preface ? `${outcome.preface}\n` : ''
    const headers = { 'x-sanad-help-source': source }
    if (!parsed) {
      return Response.json({ answer: `${preface}${text || 'لم أستطع اقتراح حل. افتح بلاغاً وسيتابعه الدعم التقني.'}`, steps: [], fault_type: 'أخرى', urgent: false, needs_ticket: !countQuestion, kind: 'help', choices: [], confirm: null, draft: null, followups: [] }, { headers })
    }
    const fault = String(parsed.fault_type || '')
    const answer = `${preface}${String(parsed.answer || '')}`.trim()
    return Response.json({
      answer: (answer || text || 'لم أستطع اقتراح حل. افتح بلاغاً وسيتابعه الدعم التقني.').slice(0, 1200),
      steps: countQuestion ? [] : (Array.isArray(parsed.steps) ? parsed.steps.map((step) => String(step).slice(0, 300)).slice(0, 5) : []),
      fault_type: (FAULT_TYPES as readonly string[]).includes(fault) ? fault : 'أخرى',
      urgent: parsed.urgent === true,
      needs_ticket: countQuestion ? false : parsed.needs_ticket !== false,
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
