import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const administrator = await getAdministratorProfile()
  if (!administrator) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const { id } = await context.params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'The import ID is invalid.' }, { status: 400 })
  let body: { error?: unknown }
  try { body = await request.json() as { error?: unknown } } catch { body = {} }
  const message = typeof body.error === 'string' ? body.error.slice(0, 1000) : 'Upload or parsing was interrupted.'
  const supabase = await createSupabaseServerClient()
  const { data: record, error: recordError } = await supabase.from('attendance_imports').select('source_type, processing_status').eq('id', id).eq('uploaded_by', administrator.id).maybeSingle()
  if (recordError || !record) return NextResponse.json({ error: 'The import could not be found for this administrator.' }, { status: 404 })
  const persisted = record.source_type === 'ivms_pdf_original_records'
    ? await supabase.from('raw_fingerprint_events').select('id', { count: 'exact', head: true }).eq('import_id', id)
    : await supabase.from('organized_attendance_entries').select('id', { count: 'exact', head: true }).eq('import_id', id)
  if (persisted.error) return NextResponse.json({ error: 'Saved source records could not be checked; the import status was left unchanged.' }, { status: 503 })
  if ((persisted.count ?? 0) > 0) return NextResponse.json({ error: 'Source records are already persisted, so this import was not marked failed.', status: record.processing_status, recordCount: persisted.count }, { status: 409 })
  const { error } = await supabase.from('attendance_imports').update({ processing_status: 'failed', processing_error: message }).eq('id', id).eq('uploaded_by', administrator.id)
  if (error) return NextResponse.json({ error: 'The interrupted import could not be marked for recovery.' }, { status: 500 })
  return NextResponse.json({ status: 'failed' })
}
