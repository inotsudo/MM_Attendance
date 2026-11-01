import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const { id } = await context.params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'The review item ID is invalid.' }, { status: 400 })
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'The resolution request is invalid.' }, { status: 400 }) }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'The resolution request is invalid.' }, { status: 400 })
  const input = body as Record<string, unknown>
  if (typeof input.note !== 'string' || !input.note.trim()) return NextResponse.json({ error: 'Enter a resolution note before saving.' }, { status: 400 })
  if (input.employeeId !== null && input.employeeId !== undefined && (typeof input.employeeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.employeeId))) return NextResponse.json({ error: 'The selected employee is invalid.' }, { status: 400 })

  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.rpc('resolve_attendance_review_item', {
    p_review_item_id: id,
    p_resolution_note: input.note.trim(),
    p_employee_id: typeof input.employeeId === 'string' ? input.employeeId : null,
  })
  if (error) return NextResponse.json({ error: error.message || 'The review item could not be resolved.' }, { status: 422 })
  return NextResponse.json(data)
}
