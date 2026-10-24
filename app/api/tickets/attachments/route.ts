import { loadVisibleTicket } from '@/lib/ticket-access'
import { serviceClient } from '@/lib/server-auth'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_FILES = 3
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
const BUCKET = 'ticket-files'

function cleanName(name: string) {
  const base = name.split(/[/\\]/).pop() || 'file'
  return base.replace(/[^\w.\u0600-\u06FF-]+/g, '_').slice(0, 80) || 'file'
}

export async function GET(request: Request) {
  const ticketId = new URL(request.url).searchParams.get('ticketId') || ''
  const { actor, ticket } = await loadVisibleTicket(request, ticketId)
  if (!actor) return Response.json({ error: 'يلزم تسجيل الدخول.' }, { status: 401 })
  if (!ticket) return Response.json({ error: 'البلاغ غير متاح.' }, { status: 404 })

  const admin = serviceClient()
  const { data, error } = await admin.from('ticket_attachments').select('id, file_name, storage_path, content_type, size_bytes, created_at').eq('ticket_id', ticketId).order('created_at', { ascending: true })
  if (error) return Response.json({ error: error.message }, { status: 400 })
  const files = []
  for (const row of data || []) {
    const signed = await admin.storage.from(BUCKET).createSignedUrl(row.storage_path, 600)
    files.push({
      id: row.id,
      name: row.file_name,
      type: row.content_type,
      size: row.size_bytes,
      url: signed.data?.signedUrl || ''
    })
  }
  return Response.json({ files })
}

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null)
  const ticketId = String(form?.get('ticketId') || '')
  const file = form?.get('file')
  if (!(file instanceof File) || !ticketId) return Response.json({ error: 'المرفق أو البلاغ غير محدد.' }, { status: 400 })
  const { actor, ticket } = await loadVisibleTicket(request, ticketId)
  if (!actor) return Response.json({ error: 'يلزم تسجيل الدخول.' }, { status: 401 })
  if (!ticket) return Response.json({ error: 'البلاغ غير متاح.' }, { status: 404 })
  const admin = serviceClient()
  const { data: gate } = await admin.from('profiles').select('must_change_password').eq('id', actor.id).maybeSingle()
  if (gate?.must_change_password) return Response.json({ error: 'يجب تغيير كلمة المرور قبل استخدام سند.' }, { status: 403 })
  const staff = actor.role === 'admin' || actor.role === 'technician' || actor.role === 'manager'
  if (ticket.user_id !== actor.id && !staff) return Response.json({ error: 'رفع المرفقات متاح لصاحب البلاغ والفني فقط.' }, { status: 403 })
  if (!TYPES.has(file.type)) return Response.json({ error: 'يُسمح بالصور وملفات PDF فقط.' }, { status: 400 })
  if (file.size <= 0 || file.size > MAX_BYTES) return Response.json({ error: 'حجم المرفق يجب أن يكون أقل من 5 ميغابايت.' }, { status: 400 })

  const existing = await admin.from('ticket_attachments').select('id', { count: 'exact', head: true }).eq('ticket_id', ticketId)
  if ((existing.count || 0) >= MAX_FILES) return Response.json({ error: 'الحد الأقصى ثلاثة مرفقات لكل بلاغ.' }, { status: 400 })

  const path = `${ticketId}/${crypto.randomUUID()}`
  const uploaded = await admin.storage.from(BUCKET).upload(path, Buffer.from(await file.arrayBuffer()), {
    contentType: file.type,
    upsert: false
  })
  if (uploaded.error) return Response.json({ error: uploaded.error.message }, { status: 400 })

  const saved = await admin.from('ticket_attachments').insert({
    ticket_id: ticketId,
    file_name: cleanName(file.name),
    storage_path: path,
    content_type: file.type,
    size_bytes: file.size,
    uploaded_by: actor.id
  }).select('id').single()
  if (saved.error) {
    await admin.storage.from(BUCKET).remove([path])
    return Response.json({ error: saved.error.message }, { status: 400 })
  }
  return Response.json({ id: saved.data.id })
}
