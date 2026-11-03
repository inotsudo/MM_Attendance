import { NextResponse } from 'next/server'
import { parseIvmsPdf } from '@/lib/imports/pdf-parser'
import { parseOrganizedExcel } from '@/lib/imports/excel-parser'
import { buildAttendanceReport } from '@/lib/reports/dataset'
import { createAttendanceWorkbook } from '@/lib/reports/excel'
import { createAttendancePdf } from '@/lib/reports/pdf'
import type { ReportEvidence, ReportRule } from '@/lib/reports/types'
import type { ExcelAttendanceRecord, PdfAttendanceRecord } from '@/lib/imports/types'

export const runtime = 'nodejs'
export const maxDuration = 60
const MAX_FILE_BYTES = 25 * 1024 * 1024

function signatureMatches(sourceType: 'ivms_pdf_original_records' | 'organized_excel', bytes: Uint8Array) {
  if (sourceType === 'ivms_pdf_original_records') return new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-'
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2])
}

function weekDates(weekStart: string) {
  const from = new Date(`${weekStart}T00:00:00Z`)
  if (Number.isNaN(from.getTime()) || from.toISOString().slice(0, 10) !== weekStart || from.getUTCDay() !== 1) return null
  return { from: weekStart, to: new Date(from.getTime() + 6 * 86_400_000).toISOString().slice(0, 10) }
}

export async function POST(request: Request) {
  let form: FormData
  try { form = await request.formData() } catch { return NextResponse.json({ error: 'Choose an attendance file to prepare.' }, { status: 400 }) }
  const file = form.get('file')
  const weekStart = form.get('weekStart')
  const timezone = form.get('timezone')
  const mode = form.get('mode') ?? 'download'
  const format = form.get('format') ?? 'xlsx'
  if (!(file instanceof File) || typeof weekStart !== 'string' || typeof timezone !== 'string' || !['preview', 'download'].includes(String(mode))) return NextResponse.json({ error: 'Choose an attendance file, timezone, and Monday week start date.' }, { status: 400 })
  if (mode === 'download' && !['pdf', 'xlsx'].includes(String(format))) return NextResponse.json({ error: 'Choose PDF or Excel as the download format.' }, { status: 400 })
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()) } catch { return NextResponse.json({ error: 'The browser supplied an invalid timezone.' }, { status: 400 }) }
  if (!file.size) return NextResponse.json({ error: 'The selected file is empty.' }, { status: 400 })
  if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: 'The selected file exceeds the 25 MiB limit.' }, { status: 413 })
  const period = weekDates(weekStart)
  if (!period) return NextResponse.json({ error: 'Choose a valid Monday as the start of the reporting week.' }, { status: 400 })

  const name = file.name.trim()
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
  const sourceType = extension === '.pdf' ? 'ivms_pdf_original_records' : extension === '.xlsx' ? 'organized_excel' : null
  if (!sourceType) return NextResponse.json({ error: 'Supported files are iVMS Original Records PDF reports and XLSX attendance sheets.' }, { status: 415 })
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!signatureMatches(sourceType, bytes)) return NextResponse.json({ error: 'The file contents do not match the selected PDF or XLSX format.' }, { status: 415 })

  try {
    const parsed = sourceType === 'ivms_pdf_original_records' ? await parseIvmsPdf(bytes, timezone) : await parseOrganizedExcel(bytes, timezone)
    const evidence: ReportEvidence[] = parsed.records.map((record, index): ReportEvidence => {
      if (parsed.sourceType === 'ivms_pdf_original_records') {
        const event = record as PdfAttendanceRecord
        return { id: `temporary-${index}`, importId: 'temporary', sourceType: parsed.sourceType, employeeId: null, employeeNumber: event.employeeNumber, employeeName: event.employeeName, department: event.department, date: event.normalizedTimestamp ? new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(event.normalizedTimestamp)) : null, timestamp: event.normalizedTimestamp, sourceTimestampText: event.sourceTimestamp, sourceIn: null, normalizedInAt: null, sourceOut: null, normalizedOutAt: null, attendanceStatus: event.attendanceStatus, checkpoint: event.checkpoint, sourceSheet: null, sourcePage: event.sourcePage, sourceRow: event.sourceRow }
      }
      const entry = record as ExcelAttendanceRecord
      return { id: `temporary-${index}`, importId: 'temporary', sourceType: parsed.sourceType, employeeId: null, employeeNumber: entry.employeeNumber, employeeName: entry.employeeName, department: entry.department, date: entry.normalizedWorkDate, timestamp: null, sourceTimestampText: null, sourceIn: entry.sourceIn, normalizedInAt: entry.normalizedInAt, sourceOut: entry.sourceOut, normalizedOutAt: entry.normalizedOutAt, attendanceStatus: null, checkpoint: null, sourceSheet: entry.sourceSheet, sourcePage: null, sourceRow: entry.sourceRow }
    })
    const rules: ReportRule[] = [{ id: 'temporary-selected-policy', version: 1, effectiveFrom: period.from, normalStart: '08:00', graceUntil: '08:30', veryLateFrom: '09:30', scheduledEnd: '17:30', overtimeFrom: '19:30', timezone, weekendOvertimeDays: null }]
    const generatedAt = new Date().toISOString()
    const report = buildAttendanceReport({ reportId: crypto.randomUUID(), generatedAt, from: period.from, to: period.to, employees: [], evidence, calculations: [], corrections: [], reviews: [], rules, imports: [{ id: 'temporary', filename: name, sourceType, uploadedAt: generatedAt, checksum: 'temporary-memory-only' }], timezone })
    const recordWarnings = parsed.records.flatMap((record) => record.warnings)
    const allWarnings = [...parsed.warnings, ...recordWarnings]
    const counts = new Map<string, number>()
    for (const record of parsed.records) {
      const sourceTime = 'normalizedTimestamp' in record ? record.normalizedTimestamp ?? record.sourceTimestamp : `${record.normalizedWorkDate}|${record.sourceIn}|${record.sourceOut}`
      const key = `${record.employeeNumber?.trim() || record.employeeName?.trim() || 'unknown'}|${sourceTime}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const duplicateRecords = [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)
    if (duplicateRecords > 0) allWarnings.unshift({ severity: 'warning', code: 'duplicate_source_records', message: `${duplicateRecords} duplicate source record${duplicateRecords === 1 ? '' : 's'} were found. Confirm whether they are repeated scans or valid separate punches.` })
    if (mode === 'preview') {
      const periodEvidence = evidence.filter((item) => item.date && item.date >= period.from && item.date <= period.to)
      const periodDates = periodEvidence.map((item) => item.date!).sort()
      return NextResponse.json({
        fileName: name,
        sourceType,
        timezone,
        period,
        summary: {
          sourceRecords: parsed.records.length,
          recordsInPeriod: periodEvidence.length,
          employeeIdentities: report.manualAttendanceRows.length,
          missingEmployeeIds: parsed.records.filter((record) => !record.employeeNumber?.trim()).length,
          duplicateRecords,
          warnings: allWarnings.length,
          dateRange: periodDates.length ? { from: periodDates[0], to: periodDates.at(-1) } : null,
        },
        warningList: allWarnings.slice(0, 100).map((warning) => ({ severity: warning.severity, message: warning.message, sourceIndex: warning.sourceIndex, page: warning.page, sheet: warning.sheet, row: warning.row })),
        warningListTruncated: allWarnings.length > 100,
        employees: report.manualAttendanceRows.map((employee) => ({
          employeeId: employee.sourceEmployeeNumber,
          employeeName: employee.employeeName,
          absentCount: employee.absentCount,
          days: employee.days.map((day) => ({ date: day.date, inTime: day.inTime, outTime: day.outTime, inStatus: day.inStatus, outStatus: day.outStatus })),
        })),
      }, { headers: { 'Cache-Control': 'no-store, private' } })
    }
    const output = format === 'pdf' ? createAttendancePdf(report) : await createAttendanceWorkbook(report)
    const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/\.(pdf|xlsx)$/i, '') || 'attendance'
    const isPdf = format === 'pdf'
    const extension = isPdf ? 'pdf' : 'xlsx'
    const contentType = isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    return new Response(output, { headers: { 'Content-Type': contentType, 'Content-Disposition': `attachment; filename="attendance-${safeName}-${period.from}.${extension}"`, 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'X-Prepared-Records': String(parsed.records.length), 'X-Prepared-Employees': String(report.manualAttendanceRows.length), 'X-Prepared-Warnings': String(allWarnings.length), 'X-Reporting-Period': `${period.from}/${period.to}` } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The attendance file could not be prepared.'
    return NextResponse.json({ error: message }, { status: 422, headers: { 'Cache-Control': 'no-store' } })
  }
}
