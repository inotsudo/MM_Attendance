import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { ATTENDANCE_BUCKET, downloadImport } from '@/lib/imports/storage'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const administrator = await getAdministratorProfile()
  if (!administrator) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const { id: parentId } = await context.params
  if (!/^[0-9a-f-]{36}$/i.test(parentId)) return NextResponse.json({ error: 'The import ID is invalid.' }, { status: 400 })

  try {
    const { supabase, record, bytes } = await downloadImport(parentId)
    if (!['completed', 'needs_review'].includes(record.processing_status)) {
      return NextResponse.json({ error: 'Only a processed import can be reparsed.' }, { status: 409 })
    }
    const sourceRows = record.source_type === 'ivms_pdf_original_records'
      ? await supabase.from('raw_fingerprint_events').select('id', { count: 'exact', head: true }).eq('import_id', parentId)
      : await supabase.from('organized_attendance_entries').select('id', { count: 'exact', head: true }).eq('import_id', parentId)
    if (sourceRows.error) return NextResponse.json({ error: 'The existing source evidence could not be verified.' }, { status: 503 })
    if (!sourceRows.count) return NextResponse.json({ error: 'This import has no persisted source evidence. Use Resume / check to retry its original processing.' }, { status: 409 })

    const { data: child, error: childError } = await supabase.from('attendance_imports')
      .select('id, processing_status')
      .eq('reprocessed_from_import_id', parentId)
      .in('processing_status', ['uploaded', 'queued', 'processing', 'parsed', 'failed'])
      .order('uploaded_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (childError) return NextResponse.json({ error: 'Check the reprocessing migration is applied before creating a new parser revision.' }, { status: 503 })
    if (child) return NextResponse.json({ importId: child.id, parentImportId: parentId, status: child.processing_status, reusedRevision: true }, { status: 200 })

    const revisionId = crypto.randomUUID()
    const filename = record.original_filename.replace(/^.*[\\/]/, '').slice(0, 180)
    const storagePath = `${administrator.id}/${revisionId}/${filename}`
    const { error: insertError } = await supabase.from('attendance_imports').insert({
      id: revisionId,
      source_type: record.source_type,
      original_filename: record.original_filename,
      storage_bucket: ATTENDANCE_BUCKET,
      storage_path: storagePath,
      file_type: record.source_type === 'ivms_pdf_original_records' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      file_size_bytes: bytes.length,
      sha256_checksum: record.sha256_checksum,
      uploaded_by: administrator.id,
      processing_status: 'uploaded',
      reprocessed_from_import_id: parentId,
    })
    if (insertError) return NextResponse.json({ error: insertError.message.includes('reprocessed_from_import_id') ? 'Apply the import reprocessing migration before reparsing.' : 'A new parser revision could not be created.' }, { status: insertError.message.includes('reprocessed_from_import_id') ? 503 : 500 })

    const { error: uploadError } = await supabase.storage.from(ATTENDANCE_BUCKET).upload(storagePath, bytes, {
      contentType: record.source_type === 'ivms_pdf_original_records' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      upsert: false,
    })
    if (uploadError) {
      await supabase.from('attendance_imports').update({ processing_status: 'failed', processing_error: 'Could not make a private source copy for reprocessing.' }).eq('id', revisionId)
      return NextResponse.json({ error: 'The new private file copy failed. The original import and its source file are unchanged.' }, { status: 503 })
    }
    return NextResponse.json({ importId: revisionId, parentImportId: parentId, fileName: record.original_filename, status: 'uploaded' }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The original file could not be prepared for reprocessing.'
    return NextResponse.json({ error: message }, { status: 422 })
  }
}
