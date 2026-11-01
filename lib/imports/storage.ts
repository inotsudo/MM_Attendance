import 'server-only'

import { createHash } from 'node:crypto'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { parseIvmsPdf } from './pdf-parser'
import { parseOrganizedExcel } from './excel-parser'
import type { ImportSourceType, ParsedAttendanceImport } from './types'

export const ATTENDANCE_BUCKET = 'attendance-originals'
export const MAX_IMPORT_SIZE = 25 * 1024 * 1024

export function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function fileSignatureMatches(sourceType: ImportSourceType, bytes: Uint8Array) {
  if (sourceType === 'ivms_pdf_original_records') return new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-'
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2])
}

export async function downloadImport(importId: string) {
  const supabase = await createSupabaseServerClient()
  const { data: record, error: recordError } = await supabase
    .from('attendance_imports')
    .select('id, source_type, original_filename, storage_bucket, storage_path, file_size_bytes, sha256_checksum, processing_status')
    .eq('id', importId)
    .maybeSingle()
  if (recordError || !record) throw new Error('The attendance import could not be found.')

  const { data: file, error: fileError } = await supabase.storage.from(record.storage_bucket).download(record.storage_path)
  if (fileError || !file) throw new Error('The original file is not available in private storage. Upload the file again.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length !== record.file_size_bytes || sha256(bytes) !== record.sha256_checksum) {
    throw new Error('The stored file does not match its original size and checksum. Processing was stopped.')
  }
  if (bytes.length === 0 || bytes.length > MAX_IMPORT_SIZE || !fileSignatureMatches(record.source_type, bytes)) {
    throw new Error('The uploaded file signature does not match its declared source format.')
  }
  return { supabase, record, bytes }
}

export async function parseStoredImport(sourceType: ImportSourceType, bytes: Uint8Array): Promise<ParsedAttendanceImport> {
  if (sourceType === 'ivms_pdf_original_records') return parseIvmsPdf(bytes)
  return parseOrganizedExcel(bytes)
}
