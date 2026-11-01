import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export async function GET() {
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const supabase = await createSupabaseServerClient()
  const { data: items, error } = await supabase.from('attendance_review_items')
    .select('id, import_id, raw_fingerprint_event_id, organized_attendance_entry_id, issue_code, severity, description, evidence, created_at')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) return NextResponse.json({ error: 'Open attendance review items could not be loaded.' }, { status: 500 })

  const importIds = [...new Set((items ?? []).map((item) => item.import_id))]
  const rawIds = [...new Set((items ?? []).flatMap((item) => item.raw_fingerprint_event_id ? [item.raw_fingerprint_event_id] : []))]
  const entryIds = [...new Set((items ?? []).flatMap((item) => item.organized_attendance_entry_id ? [item.organized_attendance_entry_id] : []))]
  const [imports, rawEvents, organizedEntries, employeeResult] = await Promise.all([
    importIds.length ? supabase.from('attendance_imports').select('id, original_filename').in('id', importIds) : Promise.resolve({ data: [], error: null }),
    rawIds.length ? supabase.from('raw_fingerprint_events').select('id, source_page, source_row, source_employee_number, source_employee_name, source_department, source_timestamp_text, source_status, checkpoint, raw_evidence').in('id', rawIds) : Promise.resolve({ data: [], error: null }),
    entryIds.length ? supabase.from('organized_attendance_entries').select('id, source_sheet, source_row, source_column, source_employee_number, source_employee_name, source_work_date_text, source_in_text, source_out_text, raw_evidence').in('id', entryIds) : Promise.resolve({ data: [], error: null }),
    supabase.from('employees').select('id, employee_number, full_name').eq('is_active', true).order('employee_number').limit(1000),
  ])
  if (imports.error || rawEvents.error || organizedEntries.error || employeeResult.error) return NextResponse.json({ error: 'Review item source evidence could not be loaded.' }, { status: 500 })

  const importById = new Map((imports.data ?? []).map((row) => [row.id, row]))
  const rawById = new Map((rawEvents.data ?? []).map((row) => [row.id, row]))
  const entryById = new Map((organizedEntries.data ?? []).map((row) => [row.id, row]))
  return NextResponse.json({
    items: (items ?? []).map((item) => ({
      ...item,
      originalFilename: importById.get(item.import_id)?.original_filename ?? 'Attendance file',
      rawEvent: item.raw_fingerprint_event_id ? rawById.get(item.raw_fingerprint_event_id) ?? null : null,
      organizedEntry: item.organized_attendance_entry_id ? entryById.get(item.organized_attendance_entry_id) ?? null : null,
    })),
    employees: (employeeResult.data ?? []).map((employee) => ({ id: employee.id, employeeNumber: employee.employee_number, fullName: employee.full_name })),
  })
}
