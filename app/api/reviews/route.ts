import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import type { AttendanceReviewState } from '@/lib/database.types'

function integerParam(value: string | null, fallback: number) {
  if (!value || !/^\d+$/.test(value)) return fallback
  return Number(value)
}

export async function GET(request: Request) {
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const query = new URL(request.url).searchParams
  const offset = Math.min(1_000_000, integerParam(query.get('offset'), 0))
  const limit = Math.min(100, Math.max(1, integerParam(query.get('limit'), 50)))
  const includeEmployees = query.get('includeEmployees') !== 'false'
  const state = query.get('state') ?? 'active'
  const issue = query.get('issue')
  const severity = query.get('severity')
  const supabase = await createSupabaseServerClient()
  const activeStates: AttendanceReviewState[] = ['pending', 'under_review', 'unresolved']
  const stateValues: AttendanceReviewState[] = ['pending', 'under_review', 'confirmed', 'corrected', 'unresolved', 'rejected']
  const severityValues = ['info', 'warning', 'error'] as const
  let itemsQuery = supabase.from('attendance_review_items')
    .select('id, import_id, daily_calculation_id, raw_fingerprint_event_id, organized_attendance_entry_id, issue_code, severity, description, evidence, created_at, review_state')
    .order('created_at', { ascending: false })
  if (state === 'active') itemsQuery = itemsQuery.in('review_state', activeStates)
  else if (stateValues.includes(state as AttendanceReviewState)) itemsQuery = itemsQuery.eq('review_state', state as AttendanceReviewState)
  else if (state !== 'all') return NextResponse.json({ error: 'Choose a valid review status filter.' }, { status: 400 })
  if (issue) itemsQuery = itemsQuery.eq('issue_code', issue)
  if (severity && severityValues.includes(severity as typeof severityValues[number])) itemsQuery = itemsQuery.eq('severity', severity as typeof severityValues[number])
  const { data: fetchedItems, error } = await itemsQuery.range(offset, offset + limit)
  if (error) return NextResponse.json({ error: 'Open attendance review items could not be loaded.' }, { status: 500 })

  const [pendingCount, underReviewCount, unresolvedCount, allCount] = await Promise.all([
    supabase.from('attendance_review_items').select('id', { count: 'exact', head: true }).eq('review_state', 'pending'),
    supabase.from('attendance_review_items').select('id', { count: 'exact', head: true }).eq('review_state', 'under_review'),
    supabase.from('attendance_review_items').select('id', { count: 'exact', head: true }).eq('review_state', 'unresolved'),
    supabase.from('attendance_review_items').select('id', { count: 'exact', head: true }),
  ])
  if ([pendingCount, underReviewCount, unresolvedCount, allCount].some((result) => result.error)) return NextResponse.json({ error: 'Review overview could not be loaded.' }, { status: 500 })

  const pageItems = (fetchedItems ?? []).slice(0, limit)
  const hasMore = (fetchedItems ?? []).length > limit
  const importIds = [...new Set(pageItems.map((item) => item.import_id))]
  const rawIds = [...new Set(pageItems.flatMap((item) => item.raw_fingerprint_event_id ? [item.raw_fingerprint_event_id] : []))]
  const entryIds = [...new Set(pageItems.flatMap((item) => item.organized_attendance_entry_id ? [item.organized_attendance_entry_id] : []))]
  const [imports, rawEvents, organizedEntries, employeeResult] = await Promise.all([
    importIds.length ? supabase.from('attendance_imports').select('id, original_filename').in('id', importIds) : Promise.resolve({ data: [], error: null }),
    rawIds.length ? supabase.from('raw_fingerprint_events').select('id, source_page, source_row, source_employee_number, source_employee_name, source_department, source_timestamp_text, source_status, checkpoint').in('id', rawIds) : Promise.resolve({ data: [], error: null }),
    entryIds.length ? supabase.from('organized_attendance_entries').select('id, source_sheet, source_row, source_column, source_employee_number, source_employee_name, source_work_date_text, source_in_text, source_out_text').in('id', entryIds) : Promise.resolve({ data: [], error: null }),
    includeEmployees ? supabase.from('employees').select('id, employee_number, full_name').eq('is_active', true).order('employee_number').limit(1000) : Promise.resolve({ data: [], error: null }),
  ])
  if (imports.error || rawEvents.error || organizedEntries.error || employeeResult.error) return NextResponse.json({ error: 'Review item source evidence could not be loaded.' }, { status: 500 })

  const importById = new Map((imports.data ?? []).map((row) => [row.id, row]))
  const rawById = new Map((rawEvents.data ?? []).map((row) => [row.id, row]))
  const entryById = new Map((organizedEntries.data ?? []).map((row) => [row.id, row]))
  return NextResponse.json({
    items: pageItems.map((item) => ({
      ...item,
      stateLabel: item.review_state.replaceAll('_', ' '),
      originalFilename: importById.get(item.import_id)?.original_filename ?? 'Attendance file',
      rawEvent: item.raw_fingerprint_event_id ? rawById.get(item.raw_fingerprint_event_id) ?? null : null,
      organizedEntry: item.organized_attendance_entry_id ? entryById.get(item.organized_attendance_entry_id) ?? null : null,
    })),
    employees: (employeeResult.data ?? []).map((employee) => ({ id: employee.id, employeeNumber: employee.employee_number, fullName: employee.full_name })),
    page: { offset, limit, hasMore },
    overview: { pending: pendingCount.count ?? 0, underReview: underReviewCount.count ?? 0, unresolved: unresolvedCount.count ?? 0, total: allCount.count ?? 0 },
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}
