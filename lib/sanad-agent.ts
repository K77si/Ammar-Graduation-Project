import Anthropic from '@anthropic-ai/sdk'
import { createGateway, generateText, stepCountIs } from 'ai'
import { anthropicTools, assistantGatewayTools, runAssistantTool } from '@/lib/assistant-tools'
import type { Actor } from '@/lib/server-auth'

export const CARD_REASON = 'AI Gateway requires a valid credit card on file'
const GATEWAY_MODEL = 'anthropic/claude-haiku-5-5'

export type AgentImage = { mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }
export type AgentPaths = {
  anthropicKey: string
  gatewayKey: string
  directModel: string
  canGateway: boolean
  canDirect: boolean
}

type ForcedTool = '' | 'get_departments' | 'get_employees_count'
type AgentRun = { text: string; tools: Array<Record<string, unknown>>; source: string }

export function errorStatus(error: unknown): number {
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

export function needsCard(error: unknown) {
  return errorText(error).includes(CARD_REASON)
}

function thinkingRejected(error: unknown) {
  if (needsCard(error)) return false
  const status = errorStatus(error)
  if (status && status !== 400 && status !== 422) return false
  return /thinking|reasoning/i.test(errorText(error))
}

function toolRecords(result: { steps?: Array<{ toolResults?: Array<{ output?: unknown; result?: unknown }> }>; toolResults?: Array<{ output?: unknown; result?: unknown }> }) {
  const fromSteps = (result.steps || []).flatMap((step) => step.toolResults || [])
  return [...fromSteps, ...(result.toolResults || [])].flatMap((item) => {
    const value = item.output ?? item.result
    return value && typeof value === 'object' ? [value as Record<string, unknown>] : []
  })
}

async function gatewayTurn(input: {
  paths: AgentPaths
  system: string
  history: { q: string; a: string }[]
  question: string
  image: AgentImage | null
  forcedTool: ForcedTool
  actor: Actor
  request: Request
}): Promise<AgentRun> {
  const model = input.paths.gatewayKey ? createGateway({ apiKey: input.paths.gatewayKey })(GATEWAY_MODEL) : GATEWAY_MODEL
  const userContent = input.image
    ? [
        { type: 'file' as const, mediaType: input.image.mediaType, data: input.image.data },
        { type: 'text' as const, text: input.question }
      ]
    : input.question
  const run = (disableThinking: boolean) => generateText({
    model,
    system: input.system,
    tools: assistantGatewayTools(input.actor, input.request),
    stopWhen: stepCountIs(4),
    prepareStep: ({ stepNumber }) => (
      stepNumber === 0 && input.forcedTool
        ? { toolChoice: { type: 'tool', toolName: input.forcedTool } }
        : { toolChoice: 'auto' }
    ),
    maxOutputTokens: 3000,
    ...(disableThinking ? { reasoning: 'none' as const } : {}),
    messages: [
      ...input.history.flatMap((turn) => [
        { role: 'user' as const, content: turn.q },
        { role: 'assistant' as const, content: turn.a }
      ]),
      { role: 'user' as const, content: userContent }
    ]
  })
  try {
    const result = await run(true)
    return { text: result.text.trim(), tools: toolRecords(result), source: 'gateway' }
  } catch (error) {
    if (!thinkingRejected(error)) throw error
    const result = await run(false)
    return { text: result.text.trim(), tools: toolRecords(result), source: 'gateway' }
  }
}

async function directTurn(input: {
  paths: AgentPaths
  system: string
  history: { q: string; a: string }[]
  question: string
  image: AgentImage | null
  forcedTool: ForcedTool
  actor: Actor
  request: Request
}): Promise<AgentRun> {
  const client = new Anthropic({ apiKey: input.paths.anthropicKey })
  const content = input.image
    ? [
        { type: 'image' as const, source: { type: 'base64' as const, media_type: input.image.mediaType, data: input.image.data } },
        { type: 'text' as const, text: input.question }
      ]
    : input.question
  const run = async (disableThinking: boolean) => {
    const messages: Anthropic.MessageParam[] = [
      ...input.history.flatMap((turn) => [
        { role: 'user' as const, content: turn.q },
        { role: 'assistant' as const, content: turn.a }
      ]),
      { role: 'user', content }
    ]
    let text = ''
    const tools: Array<Record<string, unknown>> = []
    for (let step = 0; step < 4; step += 1) {
      const message = await client.messages.create({
        model: input.paths.directModel,
        max_tokens: 3000,
        system: input.system,
        tools: anthropicTools,
        tool_choice: step === 0 && input.forcedTool ? { type: 'tool', name: input.forcedTool } : { type: 'auto' },
        ...(disableThinking ? { thinking: { type: 'disabled' as const } } : {}),
        messages
      })
      text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('').trim()
      const calls = message.content.filter((part) => part.type === 'tool_use')
      if (!calls.length) return { text, tools, source: 'anthropic' }
      const assistantContent: Anthropic.ContentBlockParam[] = []
      for (const part of message.content) {
        if (part.type === 'text') assistantContent.push({ type: 'text', text: part.text })
        else if (part.type === 'tool_use') assistantContent.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input })
        else if (part.type === 'thinking') assistantContent.push({ type: 'thinking', thinking: part.thinking, signature: part.signature })
        else if (part.type === 'redacted_thinking') assistantContent.push({ type: 'redacted_thinking', data: part.data })
      }
      const results: Anthropic.ToolResultBlockParam[] = []
      for (const part of calls) {
        const output = await runAssistantTool(part.name, part.input, input.actor, input.request)
        tools.push(output)
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
    return { text, tools, source: 'anthropic' }
  }
  try {
    return await run(true)
  } catch (error) {
    if (!thinkingRejected(error)) throw error
    return await run(false)
  }
}

export async function runSanadAgent(input: {
  request: Request
  actor: Actor
  system: string
  history: { q: string; a: string }[]
  question: string
  image: AgentImage | null
  forcedTool: ForcedTool
  paths: AgentPaths
}): Promise<AgentRun> {
  if (input.paths.canDirect) {
    try {
      return await directTurn(input)
    } catch (error) {
      if (!input.paths.canGateway || needsCard(error)) throw error
      const fallback = await gatewayTurn(input)
      return { ...fallback, source: 'gateway-fallback' }
    }
  }
  return gatewayTurn(input)
}
