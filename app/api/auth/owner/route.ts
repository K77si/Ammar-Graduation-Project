import { canManage, getActor, verifyOwner } from '@/lib/server-auth'

export async function POST(request: Request) {
  const actor = await getActor(request)
  if (!actor || !canManage(actor, 'users')) {
    return Response.json({ error: 'هذا الإجراء متاح لمدير يملك صلاحية المستخدمين.' }, { status: 403 })
  }
  const body = await request.json().catch(() => null) as { username?: string; password?: string } | null
  const result = await verifyOwner(body?.username || '', body?.password || '')
  if (!result.ok) return Response.json({ error: result.error }, { status: 401 })
  return Response.json({ ok: true })
}
