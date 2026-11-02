import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { buildAttendanceReport } from '@/lib/reports/dataset'
import { loadAttendanceReportInput } from '@/lib/reports/data'
import { createAttendanceWorkbook } from '@/lib/reports/excel'
import { createAttendancePdf } from '@/lib/reports/pdf'

export const runtime = 'nodejs'
export const maxDuration = 60

function validDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function currentWeek() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const time = Date.parse(`${today}T00:00:00Z`)
  const day = new Date(time).getUTCDay()
  const monday = time - ((day + 6) % 7) * 86_400_000
  return { from: new Date(monday).toISOString().slice(0, 10), to: new Date(monday + 6 * 86_400_000).toISOString().slice(0, 10) }
}

export async function GET(request: Request) {
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const query = new URL(request.url).searchParams
  const defaultPeriod = currentWeek()
  const from = query.get('from') ?? defaultPeriod.from
  const to = query.get('to') ?? defaultPeriod.to
  const importId = query.get('importId')
  const format = query.get('format') ?? 'pdf'
  if (!['pdf', 'xlsx'].includes(format)) return NextResponse.json({ error: 'Choose PDF or Excel format.' }, { status: 400 })
  if (!importId || !/^[0-9a-f-]{36}$/i.test(importId)) return NextResponse.json({ error: 'Select a processed attendance import before generating a report.' }, { status: 400 })
  if (!validDate(from) || !validDate(to)) return NextResponse.json({ error: 'Choose a valid reporting week.' }, { status: 400 })
  const start = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  if (start.getUTCDay() !== 1 || end.getTime() - start.getTime() !== 6 * 86_400_000) {
    return NextResponse.json({ error: 'The reporting period must be one complete Monday-to-Sunday week.' }, { status: 400 })
  }

  try {
    const reportId = crypto.randomUUID()
    const generatedAt = new Date().toISOString()
    const input = await loadAttendanceReportInput(from, to, importId, reportId, generatedAt)
    const report = buildAttendanceReport(input)
    console.info('Attendance report data diagnostics', { reportId, importId, periodStart: from, periodEnd: to, ...report.diagnostics })
    if (report.diagnostics.matchedEmployees > 0 && report.diagnostics.employeesIncluded === 0) {
      throw new Error('The selected import has matched attendance records, but none of the matched employees are available in the active employee roster. Review employee status and matching before exporting.')
    }
    const reportValidation = report.diagnostics.reviewExceptions === 0
      ? 'ready_for_export'
      : report.diagnostics.calculatedEmployeeDays === 0
        ? 'requires_review'
        : 'ready_with_disclosed_issues'
    const period = `${from}-to-${to}`
    if (format === 'xlsx') {
      const bytes = await createAttendanceWorkbook(report)
      return new Response(bytes, {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="MMRJD-weekly-attendance-${period}.xlsx"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Report-Source-Records': String(report.diagnostics.sourceRecordsFound),
          'X-Report-Employees': String(report.diagnostics.employeesIncluded),
          'X-Report-Calculated-Days': String(report.diagnostics.calculatedEmployeeDays),
          'X-Report-Validation': reportValidation,
          'X-Report-Exceptions': String(report.diagnostics.reviewExceptions),
        },
      })
    }
    const bytes = createAttendancePdf(report)
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="MMRJD-weekly-attendance-${period}.pdf"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Report-Source-Records': String(report.diagnostics.sourceRecordsFound),
        'X-Report-Employees': String(report.diagnostics.employeesIncluded),
        'X-Report-Calculated-Days': String(report.diagnostics.calculatedEmployeeDays),
        'X-Report-Validation': reportValidation,
        'X-Report-Exceptions': String(report.diagnostics.reviewExceptions),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The report could not be generated.'
    return NextResponse.json({ error: message }, { status: 422, headers: { 'Cache-Control': 'private, no-store' } })
  }
}
