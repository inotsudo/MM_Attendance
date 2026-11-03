import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'

function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function timeInKigali(value: string | null) {
  return value ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : null
}

export async function GET(request: Request) {
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const query = new URL(request.url).searchParams
  const from = query.get('from')
  const to = query.get('to')
  const offset = /^\d+$/.test(query.get('offset') ?? '') ? Number(query.get('offset')) : 0
  const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 50))
  const search = query.get('search')?.trim() ?? ''
  if (!validDate(from) || !validDate(to) || from > to || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 31 * 86_400_000) {
    return NextResponse.json({ error: 'Choose a valid date range of 32 days or less.' }, { status: 400 })
  }
  const supabase = await createSupabaseServerClient()
  const employeesResult = await supabase.from('employees').select('id, employee_number, full_name, department_id').order('full_name').limit(2000)
  if (employeesResult.error) return NextResponse.json({ error: 'Employee names could not be loaded for attendance records.' }, { status: 503 })
  const employeeRows = (employeesResult.data ?? []).filter((employee) => !search || `${employee.employee_number} ${employee.full_name}`.toLowerCase().includes(search.toLowerCase()))
  if (search && !employeeRows.length) return NextResponse.json({ records: [], total: 0, page: { offset, limit } }, { headers: { 'Cache-Control': 'private, no-store' } })
  const allRows: Array<{ id: string; employee_id: string | null; attendance_date: string; calculation_version: number; first_recorded_at: string | null; last_recorded_at: string | null; recorded_event_count: number; arrival_classification: string; overtime_evidence: boolean; completeness: string; calculated_at: string }> = []
  for (let start = 0; start < 20_000; start += 1_000) {
    let rowsQuery = supabase.from('daily_attendance_calculations')
      .select('id, employee_id, attendance_date, calculation_version, first_recorded_at, last_recorded_at, recorded_event_count, arrival_classification, overtime_evidence, completeness, calculated_at')
      .gte('attendance_date', from).lte('attendance_date', to).order('attendance_date', { ascending: false }).order('calculation_version', { ascending: false })
    if (search) rowsQuery = rowsQuery.in('employee_id', employeeRows.map((employee) => employee.id))
    const result = await rowsQuery.range(start, start + 999)
    if (result.error) return NextResponse.json({ error: 'Attendance records could not be loaded.' }, { status: 503 })
    allRows.push(...(result.data ?? []))
    if ((result.data ?? []).length < 1_000) break
    if (start === 19_000) return NextResponse.json({ error: 'There are too many saved records in that period. Choose a shorter date range.' }, { status: 413 })
  }
  const latestByDay = new Map<string, (typeof allRows)[number]>()
  for (const row of allRows) {
    if (!row.employee_id) continue
    const key = `${row.employee_id}|${row.attendance_date}`
    if (row.calculation_version > (latestByDay.get(key)?.calculation_version ?? 0)) latestByDay.set(key, row)
  }
  const matchingEmployees = new Map(employeeRows.map((employee) => [employee.id, employee]))
  const currentRows = [...latestByDay.values()].filter((row) => row.employee_id && matchingEmployees.has(row.employee_id)).sort((a, b) => b.attendance_date.localeCompare(a.attendance_date) || (matchingEmployees.get(a.employee_id!)?.full_name ?? '').localeCompare(matchingEmployees.get(b.employee_id!)?.full_name ?? ''))
  const total = currentRows.length
  const pageRows = currentRows.slice(offset, offset + limit)
  const departmentIds = [...new Set(employeeRows.flatMap((employee) => employee.department_id ? [employee.department_id] : []))]
  const departmentsResult = departmentIds.length ? await supabase.from('departments').select('id, name').in('id', departmentIds) : { data: [], error: null }
  if (departmentsResult.error) return NextResponse.json({ error: 'Employee departments could not be loaded.' }, { status: 503 })
  const departmentNames = new Map((departmentsResult.data ?? []).map((department) => [department.id, department.name]))
  const employees = employeeRows.map((employee) => ({ ...employee, departmentName: employee.department_id ? departmentNames.get(employee.department_id) ?? null : null }))
  const employeesById = new Map(employees.map((employee) => [employee.id, employee]))
  const calculationIds = pageRows.map((row) => row.id)
  const evidenceResult = calculationIds.length
    ? await supabase.from('daily_attendance_evidence').select('daily_calculation_id, raw_fingerprint_event_id, organized_attendance_entry_id').in('daily_calculation_id', calculationIds)
    : { data: [], error: null }
  if (evidenceResult.error) return NextResponse.json({ error: 'Attendance record source links could not be loaded.' }, { status: 503 })
  const evidenceLinks = evidenceResult.data ?? []
  const rawIds = evidenceLinks.flatMap((link) => link.raw_fingerprint_event_id ? [link.raw_fingerprint_event_id] : [])
  const entryIds = evidenceLinks.flatMap((link) => link.organized_attendance_entry_id ? [link.organized_attendance_entry_id] : [])
  const [rawResult, entryResult] = await Promise.all([
    rawIds.length ? supabase.from('raw_fingerprint_events').select('id, import_id').in('id', rawIds) : Promise.resolve({ data: [], error: null }),
    entryIds.length ? supabase.from('organized_attendance_entries').select('id, import_id').in('id', entryIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (rawResult.error || entryResult.error) return NextResponse.json({ error: 'Attendance source files could not be identified.' }, { status: 503 })
  const sourceById = new Map([...(rawResult.data ?? []), ...(entryResult.data ?? [])].map((source) => [source.id, source.import_id]))
  const importIds = [...new Set([...sourceById.values()])]
  const importsResult = importIds.length ? await supabase.from('attendance_imports').select('id, original_filename').in('id', importIds) : { data: [], error: null }
  if (importsResult.error) return NextResponse.json({ error: 'Attendance source file names could not be loaded.' }, { status: 503 })
  const filenames = new Map((importsResult.data ?? []).map((item) => [item.id, item.original_filename]))
  const linksByCalculation = new Map<string, string[]>()
  for (const link of evidenceLinks) {
    const sourceId = link.raw_fingerprint_event_id ?? link.organized_attendance_entry_id
    const importId = sourceId ? sourceById.get(sourceId) : null
    const filename = importId ? filenames.get(importId) : null
    if (filename) linksByCalculation.set(link.daily_calculation_id, [...(linksByCalculation.get(link.daily_calculation_id) ?? []), filename])
  }
  return NextResponse.json({
    records: pageRows.map((row) => {
      const employee = employeesById.get(row.employee_id!)!
      return {
        id: row.id,
        employeeNumber: employee.employee_number,
        employeeName: employee.full_name,
        department: employee.departmentName,
        date: row.attendance_date,
        firstEvent: timeInKigali(row.first_recorded_at),
        lastEvent: timeInKigali(row.last_recorded_at),
        eventCount: row.recorded_event_count,
        arrival: row.arrival_classification.replaceAll('_', ' '),
        completeness: row.completeness === 'complete_evidence' ? 'Complete' : row.completeness === 'no_events' ? 'No events' : 'Incomplete',
        overtime: row.overtime_evidence,
        sources: [...new Set(linksByCalculation.get(row.id) ?? [])],
      }
    }),
    total,
    page: { offset, limit },
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}
