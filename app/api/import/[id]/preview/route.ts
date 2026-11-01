import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { downloadImport, parseStoredImport } from '@/lib/imports/storage'
import { annotateDuplicates, buildPreviewSummary, findIdentityMatches } from '@/lib/imports/preview'
import type { EmployeeOption } from '@/lib/imports/types'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const { id } = await context.params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'The import ID is invalid.' }, { status: 400 })

  try {
    const { supabase, record, bytes } = await downloadImport(id)
    const parsed = await parseStoredImport(record.source_type, bytes)
    if (parsed.records.length > 10_000) throw new Error('This file contains more than 10,000 attendance rows. Split it into smaller source files and upload each part.')
    const duplicateCount = annotateDuplicates(parsed)
    const { data: employeeRows, error: employeeError } = await supabase
      .from('employees')
      .select('id, employee_number, full_name')
      .eq('is_active', true)
      .order('employee_number')
      .limit(1000)
    if (employeeError) throw new Error('Employee records could not be loaded for identity matching.')
    const employees: EmployeeOption[] = (employeeRows ?? []).map((employee) => ({ id: employee.id, employeeNumber: employee.employee_number, fullName: employee.full_name }))
    const matches = findIdentityMatches(parsed, employees)
    const hasWarnings = parsed.warnings.length > 0 || parsed.records.some((recordItem) => recordItem.warnings.length > 0) || matches.some((match) => match.matchStatus !== 'matched')
    const status = hasWarnings ? 'needs_review' : 'parsed'
    const { error: statusError } = await supabase.from('attendance_imports').update({ processing_status: status, processing_error: null }).eq('id', id)
    if (statusError) throw new Error('The preview was extracted but its status could not be saved.')
    return NextResponse.json({
      importId: id,
      fileName: record.original_filename,
      sourceType: record.source_type,
      status,
      summary: buildPreviewSummary(parsed, matches, duplicateCount),
      warnings: parsed.warnings,
      matches,
      employees,
      records: parsed.records,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The file could not be parsed.'
    try {
      const { supabase } = await downloadImport(id)
      await supabase.from('attendance_imports').update({ processing_status: 'failed', processing_error: message }).eq('id', id)
    } catch { /* The user-facing parse error remains useful when status cleanup fails. */ }
    return NextResponse.json({ error: message }, { status: 422 })
  }
}
