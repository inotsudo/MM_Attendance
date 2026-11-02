import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { isSupabaseConfigured } from '@/lib/supabase/config'
import { ATTENDANCE_BUCKET, MAX_IMPORT_SIZE } from '@/lib/imports/storage'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { createImportHistoryWorkbook } from '@/lib/imports/history-workbook'
import type { ImportSourceType } from '@/lib/imports/types'

export const runtime = 'nodejs'

const MIME_TYPES: Record<ImportSourceType, string> = {
  ivms_pdf_original_records: 'application/pdf',
  organized_excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

function safeFilename(value: string) {
  const basename = value.replace(/^.*[\\/]/, '').trim()
  return basename.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 180) || 'attendance-import'
}

function csvCell(value: string | number) {
  return `"${String(value).replace(/"/g, '""')}"`
}

export async function GET(request: Request) {
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase is not configured.' }, { status: 503 })
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.from('attendance_imports')
    .select('id, original_filename, source_type, file_type, file_size_bytes, uploaded_at, processing_status, processing_error')
    .order('uploaded_at', { ascending: false })
    .limit(500)
  if (error) return NextResponse.json({ error: 'Import history could not be loaded.' }, { status: 500 })

  if (new URL(request.url).searchParams.get('format') === 'csv') {
    const columns = ['Original filename', 'Format', 'Size bytes', 'Uploaded at', 'Status']
    const rows = (data ?? []).map((item) => [item.original_filename, item.source_type, item.file_size_bytes, item.uploaded_at, item.processing_status])
    const csv = [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
    return new Response(`\uFEFF${csv}`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="attendance-import-history.csv"',
        'Cache-Control': 'private, no-store',
      },
    })
  }
  if (new URL(request.url).searchParams.get('format') === 'xlsx') {
    const generatedAt = new Date()
    const bytes = await createImportHistoryWorkbook(data ?? [], generatedAt)
    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="MMRJD-attendance-import-history-${generatedAt.toISOString().slice(0, 10)}.xlsx"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }
  return NextResponse.json({ imports: data ?? [] }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase is not configured.' }, { status: 503 })
  const administrator = await getAdministratorProfile()
  if (!administrator) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'The upload request is invalid.' }, { status: 400 }) }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'The upload request is invalid.' }, { status: 400 })
  const input = body as Record<string, unknown>
  if (typeof input.fileName !== 'string' || !input.fileName.trim() || typeof input.size !== 'number' || !Number.isInteger(input.size) || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) {
    return NextResponse.json({ error: 'Choose a supported PDF or XLSX attendance file.' }, { status: 400 })
  }
  if (input.size <= 0) return NextResponse.json({ error: 'The selected file is empty.' }, { status: 400 })
  if (input.size > MAX_IMPORT_SIZE) return NextResponse.json({ error: 'The selected file exceeds the 25 MiB limit.' }, { status: 413 })

  const originalFilename = input.fileName.trim().slice(0, 255)
  const filename = safeFilename(originalFilename)
  const extension = originalFilename.slice(originalFilename.lastIndexOf('.')).toLowerCase()
  const sourceType: ImportSourceType | null = extension === '.pdf' ? 'ivms_pdf_original_records' : extension === '.xlsx' ? 'organized_excel' : null
  if (!sourceType) return NextResponse.json({ error: 'Only PDF Original Records Reports and XLSX attendance workbooks are supported.' }, { status: 415 })

  const supabase = await createSupabaseServerClient()
  const { data: duplicate, error: duplicateError } = await supabase
    .from('attendance_imports')
    .select('id, source_type, processing_status')
    .eq('sha256_checksum', input.sha256)
    .maybeSingle()
  if (duplicateError) return NextResponse.json({ error: 'Could not check whether this file was already uploaded.' }, { status: 500 })
  if (duplicate) {
    const countQuery = duplicate.source_type === 'ivms_pdf_original_records'
      ? await supabase.from('raw_fingerprint_events').select('id', { count: 'exact', head: true }).eq('import_id', duplicate.id)
      : await supabase.from('organized_attendance_entries').select('id', { count: 'exact', head: true }).eq('import_id', duplicate.id)
    if (countQuery.error) return NextResponse.json({ error: 'The earlier import could not be checked for saved source records.' }, { status: 503 })
    if ((countQuery.count ?? 0) > 0) {
      return NextResponse.json({ error: `This file already has ${countQuery.count} persisted source records. Review that import instead of uploading duplicate evidence.`, existingImportId: duplicate.id, status: duplicate.processing_status, recordCount: countQuery.count }, { status: 409 })
    }
    if (!['failed', 'uploaded', 'parsed', 'needs_review', 'completed'].includes(duplicate.processing_status)) {
      return NextResponse.json({ error: 'This import is currently processing and cannot be retried yet.', existingImportId: duplicate.id, status: duplicate.processing_status }, { status: 409 })
    }
  }

  if (duplicate) {
    const { data: existing, error: existingError } = await supabase.from('attendance_imports')
      .select('id, storage_bucket, storage_path, original_filename')
      .eq('id', duplicate.id)
      .single()
    if (existingError || !existing) return NextResponse.json({ error: 'The earlier upload could not be resumed.' }, { status: 500 })
    const parentPath = existing.storage_path.slice(0, existing.storage_path.lastIndexOf('/'))
    const { data: storedFiles, error: listError } = await supabase.storage.from(existing.storage_bucket).list(parentPath, { search: existing.storage_path.slice(existing.storage_path.lastIndexOf('/') + 1), limit: 1 })
    if (listError) return NextResponse.json({ error: 'The earlier upload could not be checked for recovery.' }, { status: 503 })
    const { error: resetError } = await supabase.from('attendance_imports').update({ processing_status: 'uploaded', processing_error: null, processing_completed_at: null }).eq('id', duplicate.id)
    if (resetError) return NextResponse.json({ error: 'The earlier upload could not be prepared for retry.' }, { status: 500 })
    if (storedFiles?.some((file) => file.name === existing.storage_path.slice(existing.storage_path.lastIndexOf('/') + 1))) {
      return NextResponse.json({ importId: existing.id, fileName: existing.original_filename, format: sourceType === 'ivms_pdf_original_records' ? 'PDF' : 'XLSX', stored: true, resumed: true }, { status: 201 })
    }
    const { data: signedUpload, error: signError } = await supabase.storage.from(existing.storage_bucket).createSignedUploadUrl(existing.storage_path, { upsert: false })
    if (signError || !signedUpload) return NextResponse.json({ error: 'The earlier upload could not be prepared for retry.' }, { status: 503 })
    return NextResponse.json({ importId: existing.id, bucket: existing.storage_bucket, storagePath: existing.storage_path, uploadToken: signedUpload.token, fileName: existing.original_filename, format: sourceType === 'ivms_pdf_original_records' ? 'PDF' : 'XLSX', resumed: true }, { status: 201 })
  }

  const importId = crypto.randomUUID()
  const storagePath = `${administrator.id}/${importId}/${filename}`
  const { error: insertError } = await supabase.from('attendance_imports').insert({
    id: importId,
    source_type: sourceType,
    original_filename: originalFilename,
    storage_bucket: ATTENDANCE_BUCKET,
    storage_path: storagePath,
    file_type: MIME_TYPES[sourceType],
    file_size_bytes: input.size,
    sha256_checksum: input.sha256,
    uploaded_by: administrator.id,
    processing_status: 'uploaded',
  })
  if (insertError) {
    if (insertError.code === '23505') return NextResponse.json({ error: 'This exact file has already been uploaded.' }, { status: 409 })
    return NextResponse.json({ error: 'Could not create the attendance import record.' }, { status: 500 })
  }

  const { data: signedUpload, error: signError } = await supabase.storage.from(ATTENDANCE_BUCKET).createSignedUploadUrl(storagePath, { upsert: false })
  if (signError || !signedUpload) {
    await supabase.from('attendance_imports').update({ processing_status: 'failed', processing_error: 'Could not prepare a private upload.' }).eq('id', importId)
    return NextResponse.json({ error: 'Could not prepare a private upload. Check the attendance-originals Storage policy.' }, { status: 503 })
  }

  return NextResponse.json({
    importId,
    bucket: ATTENDANCE_BUCKET,
    storagePath,
    uploadToken: signedUpload.token,
    fileName: filename,
    format: sourceType === 'ivms_pdf_original_records' ? 'PDF' : 'XLSX',
  }, { status: 201 })
}
