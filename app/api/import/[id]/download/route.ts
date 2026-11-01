import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const { id } = await context.params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'The import ID is invalid.' }, { status: 400 })
  const supabase = await createSupabaseServerClient()
  const { data: record, error: recordError } = await supabase.from('attendance_imports')
    .select('storage_bucket, storage_path, original_filename')
    .eq('id', id)
    .maybeSingle()
  if (recordError || !record) return NextResponse.json({ error: 'The original attendance file was not found.' }, { status: 404 })

  const parentPath = record.storage_path.slice(0, record.storage_path.lastIndexOf('/'))
  const filename = record.storage_path.slice(record.storage_path.lastIndexOf('/') + 1)
  const { data: storedFiles, error: listError } = await supabase.storage.from(record.storage_bucket)
    .list(parentPath, { search: filename, limit: 1 })
  if (listError) return NextResponse.json({ error: 'The original file could not be checked in private storage.' }, { status: 503 })
  if (!storedFiles?.some((file) => file.name === filename)) return NextResponse.json({ error: 'The original file is not present in storage. Re-select the same file to retry its upload.' }, { status: 404 })

  const { data, error } = await supabase.storage.from(record.storage_bucket)
    .createSignedUrl(record.storage_path, 60, { download: record.original_filename })
  if (error || !data?.signedUrl) return NextResponse.json({ error: 'The original file could not be prepared for download.' }, { status: 503 })
  const response = NextResponse.redirect(data.signedUrl, { status: 302 })
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
