import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

function pageParams(request: Request, defaultLimit: number) {
  const query = new URL(request.url).searchParams
  const rawOffset = query.get('offset') ?? '0'
  const rawLimit = query.get('limit') ?? String(defaultLimit)
  const offset = Math.min(1_000_000, /^\d+$/.test(rawOffset) ? Number(rawOffset) : 0)
  const requestedLimit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : defaultLimit
  return { query, offset, limit: Math.min(50, Math.max(1, requestedLimit)) }
}

export async function GET(request: Request) {
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const { query, offset, limit } = pageParams(request, 25)
  const view = query.get('view') === 'history' ? 'history' : 'calculations'
  const supabase = await createSupabaseServerClient()

  if (view === 'calculations') {
    const { data: fetchedRows, error } = await supabase.from('daily_attendance_calculations')
      .select('id, employee_id, attendance_date, calculation_version, first_recorded_at, last_recorded_at, arrival_classification, overtime_evidence, completeness')
      .not('employee_id', 'is', null)
      .order('attendance_date', { ascending: false })
      .order('calculation_version', { ascending: false })
      .range(offset, offset + limit)
    if (error) return NextResponse.json({ error: 'Calculated attendance records could not be loaded.' }, { status: 500 })
    const rows = (fetchedRows ?? []).slice(0, limit)
    const hasMore = (fetchedRows ?? []).length > limit
    const calculationIds = rows.map((row) => row.id)
    const employeeIds = [...new Set(rows.flatMap((row) => row.employee_id ? [row.employee_id] : []))]
    const [correctionResult, employeeResult] = await Promise.all([
      calculationIds.length ? supabase.from('attendance_corrections').select('daily_calculation_id, corrected_values, corrected_at').in('daily_calculation_id', calculationIds).order('corrected_at', { ascending: false }).limit(1000) : Promise.resolve({ data: [], error: null }),
      employeeIds.length ? supabase.from('employees').select('id, employee_number, full_name').in('id', employeeIds) : Promise.resolve({ data: [], error: null }),
    ])
    if (correctionResult.error || employeeResult.error) return NextResponse.json({ error: 'Correction context could not be loaded.' }, { status: 500 })
    const latestByCalculation = new Map<string, NonNullable<typeof correctionResult.data>[number]>()
    for (const correction of correctionResult.data ?? []) if (!latestByCalculation.has(correction.daily_calculation_id)) latestByCalculation.set(correction.daily_calculation_id, correction)
    const employeesById = new Map((employeeResult.data ?? []).map((employee) => [employee.id, employee]))
    return NextResponse.json({
      calculations: rows.map((row) => {
        const employee = row.employee_id ? employeesById.get(row.employee_id) : undefined
        const correction = latestByCalculation.get(row.id)
        return {
          ...row,
          employeeNumber: employee?.employee_number ?? 'Unknown employee',
          employeeName: employee?.full_name ?? 'Unknown employee',
          currentFirstRecordedAt: row.first_recorded_at,
          currentLastRecordedAt: row.last_recorded_at,
          hasCorrection: Boolean(correction),
        }
      }),
      page: { offset, limit, hasMore },
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  }

  const { data: fetchedRows, error } = await supabase.from('attendance_corrections')
    .select('id, daily_calculation_id, correction_type, previous_values, corrected_values, reason, corrected_by, corrected_at')
    .order('corrected_at', { ascending: false })
    .range(offset, offset + limit)
  if (error) return NextResponse.json({ error: 'Attendance correction history could not be loaded.' }, { status: 500 })
  const rows = (fetchedRows ?? []).slice(0, limit)
  const hasMore = (fetchedRows ?? []).length > limit
  const calculationIds = [...new Set(rows.map((row) => row.daily_calculation_id))]
  const profileIds = [...new Set(rows.map((row) => row.corrected_by))]
  const [calculationResult, profileResult] = await Promise.all([
    calculationIds.length ? supabase.from('daily_attendance_calculations').select('id, employee_id, attendance_date').in('id', calculationIds) : Promise.resolve({ data: [], error: null }),
    profileIds.length ? supabase.from('user_profiles').select('id, full_name').in('id', profileIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (calculationResult.error || profileResult.error) return NextResponse.json({ error: 'Correction history details could not be loaded.' }, { status: 500 })
  const employeeIds = [...new Set((calculationResult.data ?? []).flatMap((row) => row.employee_id ? [row.employee_id] : []))]
  const { data: employeeRows, error: employeeError } = employeeIds.length
    ? await supabase.from('employees').select('id, employee_number, full_name').in('id', employeeIds)
    : { data: [], error: null }
  if (employeeError) return NextResponse.json({ error: 'Correction employee details could not be loaded.' }, { status: 500 })
  const calculationById = new Map((calculationResult.data ?? []).map((row) => [row.id, row]))
  const employeeById = new Map((employeeRows ?? []).map((row) => [row.id, row]))
  const profileById = new Map((profileResult.data ?? []).map((row) => [row.id, row]))
  return NextResponse.json({
    corrections: rows.map((row) => {
      const calculation = calculationById.get(row.daily_calculation_id)
      const employee = calculation?.employee_id ? employeeById.get(calculation.employee_id) : undefined
      return {
        ...row,
        attendanceDate: calculation?.attendance_date ?? null,
        employeeNumber: employee?.employee_number ?? 'Unknown employee',
        employeeName: employee?.full_name ?? 'Unknown employee',
        correctedByName: profileById.get(row.corrected_by)?.full_name ?? 'Administrator account',
      }
    }),
    page: { offset, limit, hasMore },
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(_request: Request) {
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  return NextResponse.json({ error: 'Direct time edits are disabled. A correction must be supported by source evidence and recalculate attendance before it can be saved.' }, { status: 409 })
}
