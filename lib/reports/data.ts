import 'server-only'

import { parseSourceDateTime } from '@/lib/imports/time'
import type { Json } from '@/lib/database.types'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import type { BuildAttendanceReportInput } from './dataset'
import type { ReportCalculation, ReportCorrection, ReportEvidence, ReportImport, ReportReviewItem, ReportRule } from './types'

const PAGE_SIZE = 500
const MAX_ROWS = 100_000

type PageResult<T> = { data: T[] | null; error: { message: string } | null }
type PageQuery<T> = (from: number, to: number) => PromiseLike<PageResult<T>>

async function fetchAll<T>(query: PageQuery<T>): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await query(from, from + PAGE_SIZE - 1)
    if (error) throw new Error('Attendance report data could not be loaded.')
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
  throw new Error('The selected reporting period contains too many records to export safely.')
}

function chunks<T>(values: T[], size = 100) {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function policyWeekendOvertimeDays(value: Json): Array<'Saturday' | 'Sunday'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.weekendOvertimeDays)) return null
  if (!value.weekendOvertimeDays.every((day) => day === 'Saturday' || day === 'Sunday')) return null
  return value.weekendOvertimeDays as Array<'Saturday' | 'Sunday'>
}

function kigaliBounds(from: string, to: string) {
  const start = new Date(`${from}T00:00:00+02:00`)
  const after = new Date(`${new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}T00:00:00+02:00`)
  return { start: start.toISOString(), after: after.toISOString() }
}

function timestampCouldBeInWeek(source: string, from: string, to: string) {
  const parsed = parseSourceDateTime(source)
  if (parsed.iso) {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(parsed.iso))
    return date >= from && date <= to
  }
  const ambiguous = source.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/)
  if (ambiguous) {
    const [, first, second, year] = ambiguous
    return [`${year}-${second.padStart(2, '0')}-${first.padStart(2, '0')}`, `${year}-${first.padStart(2, '0')}-${second.padStart(2, '0')}`].some((date) => date >= from && date <= to)
  }
  const isoDate = source.trim().match(/^(\d{4}-\d{2}-\d{2})/)
  return Boolean(isoDate && isoDate[1] >= from && isoDate[1] <= to)
}

export async function loadAttendanceReportInput(from: string, to: string, reportId: string, generatedAt: string): Promise<BuildAttendanceReportInput> {
  const supabase = await createSupabaseServerClient()
  const { start, after } = kigaliBounds(from, to)
  const [employeeRows, departmentRows, ruleRows, calculationRows, organizedRows, rawRows] = await Promise.all([
    fetchAll((startAt, endAt) => supabase.from('employees').select('id, employee_number, full_name, department_id').eq('is_active', true).order('employee_number').range(startAt, endAt)),
    fetchAll((startAt, endAt) => supabase.from('departments').select('id, name').range(startAt, endAt)),
    fetchAll((startAt, endAt) => supabase.from('attendance_rule_versions').select('id, version, attendance_timezone, effective_from, normal_start, grace_until, very_late_from, scheduled_end, overtime_from, policy').lte('effective_from', to).order('effective_from').order('version').range(startAt, endAt)),
    fetchAll((startAt, endAt) => supabase.from('daily_attendance_calculations').select('id, employee_id, attendance_date, calculation_version, rules_version_id, first_recorded_at, last_recorded_at, recorded_event_count, arrival_classification, overtime_evidence, is_weekend, completeness, calculation_result, calculated_at').gte('attendance_date', from).lte('attendance_date', to).order('attendance_date').range(startAt, endAt)),
    fetchAll((startAt, endAt) => supabase.from('organized_attendance_entries').select('id, import_id, source_employee_number, source_employee_name, source_department, source_sheet, source_row, source_work_date_text, normalized_work_date, source_in_text, normalized_in_at, source_out_text, normalized_out_at').gte('normalized_work_date', from).lte('normalized_work_date', to).order('normalized_work_date').range(startAt, endAt)),
    fetchAll((startAt, endAt) => supabase.from('raw_fingerprint_events').select('id, import_id, source_employee_number, source_employee_name, source_department, source_page, source_row, source_timestamp_text, normalized_timestamp, source_status, checkpoint').gte('normalized_timestamp', start).lt('normalized_timestamp', after).order('normalized_timestamp').range(startAt, endAt)),
  ])

  const relevantSourceImportIds = [...new Set([...rawRows.map((row) => row.import_id), ...organizedRows.map((row) => row.import_id)])]
  const [invalidOrganizedRows, invalidRawRows] = relevantSourceImportIds.length
    ? await Promise.all([
      Promise.all(chunks(relevantSourceImportIds).map((ids) => fetchAll((startAt, endAt) => supabase.from('organized_attendance_entries').select('id, import_id, source_employee_number, source_employee_name, source_department, source_sheet, source_row, source_work_date_text, normalized_work_date, source_in_text, normalized_in_at, source_out_text, normalized_out_at').in('import_id', ids).is('normalized_work_date', null).range(startAt, endAt)))).then((pages) => pages.flat()),
      Promise.all(chunks(relevantSourceImportIds).map((ids) => fetchAll((startAt, endAt) => supabase.from('raw_fingerprint_events').select('id, import_id, source_employee_number, source_employee_name, source_department, source_page, source_row, source_timestamp_text, normalized_timestamp, source_status, checkpoint').in('import_id', ids).is('normalized_timestamp', null).range(startAt, endAt)))).then((pages) => pages.flat()),
    ])
    : [[], []]

  const normalizedInvalidRaw = invalidRawRows.map((row) => ({ row, parsed: parseSourceDateTime(row.source_timestamp_text) })).filter(({ row }) => timestampCouldBeInWeek(row.source_timestamp_text, from, to))
  const invalidRawIds = new Set(normalizedInvalidRaw.map(({ row }) => row.id))
  const normalizedRawRows = [...rawRows, ...invalidRawRows.filter((row) => invalidRawIds.has(row.id))]
  const invalidOrganizedIds = new Set(invalidOrganizedRows.filter((row) => /^\d{4}-\d{2}-\d{2}/.test(row.source_work_date_text) && row.source_work_date_text.slice(0, 10) >= from && row.source_work_date_text.slice(0, 10) <= to).map((row) => row.id))
  const relevantOrganizedRows = [...organizedRows, ...invalidOrganizedRows.filter((row) => invalidOrganizedIds.has(row.id))]

  const rawIds = normalizedRawRows.map((row) => row.id)
  const organizedIds = relevantOrganizedRows.map((row) => row.id)
  const calculationIds = calculationRows.map((row) => row.id)
  const importIds = [...new Set([...normalizedRawRows.map((row) => row.import_id), ...relevantOrganizedRows.map((row) => row.import_id)])]
  const [rawMatchRows, organizedMatchRows, calculationEvidenceRows, reviewRows, importRows, correctionRows] = await Promise.all([
    rawIds.length ? Promise.all(chunks(rawIds).map((ids) => fetchAll((startAt, endAt) => supabase.from('employee_match_decisions').select('raw_fingerprint_event_id, employee_id').in('raw_fingerprint_event_id', ids).range(startAt, endAt)))).then((pages) => pages.flat()) : [],
    organizedIds.length ? Promise.all(chunks(organizedIds).map((ids) => fetchAll((startAt, endAt) => supabase.from('employee_match_decisions').select('organized_attendance_entry_id, employee_id').in('organized_attendance_entry_id', ids).range(startAt, endAt)))).then((pages) => pages.flat()) : [],
    calculationIds.length ? Promise.all(chunks(calculationIds).map((ids) => fetchAll((startAt, endAt) => supabase.from('daily_attendance_evidence').select('daily_calculation_id, organized_attendance_entry_id, raw_fingerprint_event_id').in('daily_calculation_id', ids).range(startAt, endAt)))).then((pages) => pages.flat()) : [],
    importIds.length ? Promise.all(chunks(importIds).map((ids) => fetchAll((startAt, endAt) => supabase.from('attendance_review_items').select('id, import_id, raw_fingerprint_event_id, organized_attendance_entry_id, issue_code, severity, description, status').in('import_id', ids).eq('status', 'open').range(startAt, endAt)))).then((pages) => pages.flat()) : [],
    importIds.length ? Promise.all(chunks(importIds).map((ids) => fetchAll((startAt, endAt) => supabase.from('attendance_imports').select('id, original_filename, source_type, uploaded_at, sha256_checksum').in('id', ids).range(startAt, endAt)))).then((pages) => pages.flat()) : [],
    calculationIds.length ? Promise.all(chunks(calculationIds).map((ids) => fetchAll((startAt, endAt) => supabase.from('attendance_corrections').select('id, daily_calculation_id, correction_type, reason, corrected_by, corrected_at').in('daily_calculation_id', ids).range(startAt, endAt)))).then((pages) => pages.flat()) : [],
  ])

  const rawMatches = new Map(rawMatchRows.map((row) => [row.raw_fingerprint_event_id, row.employee_id]))
  const organizedMatches = new Map(organizedMatchRows.map((row) => [row.organized_attendance_entry_id, row.employee_id]))
  const calculationEvidence = new Map<string, string[]>()
  for (const row of calculationEvidenceRows) {
    const evidenceId = row.organized_attendance_entry_id ?? row.raw_fingerprint_event_id
    if (evidenceId) calculationEvidence.set(row.daily_calculation_id, [...(calculationEvidence.get(row.daily_calculation_id) ?? []), evidenceId])
  }
  const evidence: ReportEvidence[] = [
    ...normalizedRawRows.map((row) => {
      const invalid = normalizedInvalidRaw.find((candidate) => candidate.row.id === row.id)
      const timestamp = row.normalized_timestamp ?? invalid?.parsed.iso ?? null
      return { id: row.id, importId: row.import_id, sourceType: 'ivms_pdf_original_records' as const, employeeId: rawMatches.get(row.id) ?? null, employeeNumber: row.source_employee_number, employeeName: row.source_employee_name, department: row.source_department, date: timestamp ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp)) : null, timestamp: row.normalized_timestamp, sourceTimestampText: row.source_timestamp_text, sourceIn: null, normalizedInAt: null, sourceOut: null, normalizedOutAt: null, attendanceStatus: row.source_status, checkpoint: row.checkpoint, sourceSheet: null, sourcePage: row.source_page, sourceRow: row.source_row }
    }),
    ...relevantOrganizedRows.map((row) => ({ id: row.id, importId: row.import_id, sourceType: 'organized_excel' as const, employeeId: organizedMatches.get(row.id) ?? null, employeeNumber: row.source_employee_number, employeeName: row.source_employee_name, department: row.source_department, date: row.normalized_work_date ?? (/^\d{4}-\d{2}-\d{2}/.test(row.source_work_date_text) ? row.source_work_date_text.slice(0, 10) : null), timestamp: null, sourceTimestampText: null, sourceIn: row.source_in_text, normalizedInAt: row.normalized_in_at, sourceOut: row.source_out_text, normalizedOutAt: row.normalized_out_at, attendanceStatus: null, checkpoint: null, sourceSheet: row.source_sheet, sourcePage: null, sourceRow: row.source_row })),
  ]
  const departmentNames = new Map(departmentRows.map((row) => [row.id, row.name]))
  const inputEmployees = employeeRows.map((row) => ({ id: row.id, employeeNumber: row.employee_number, fullName: row.full_name, department: row.department_id ? departmentNames.get(row.department_id) ?? null : null }))
  const rules: ReportRule[] = ruleRows.map((row) => ({ id: row.id, version: row.version, effectiveFrom: row.effective_from, normalStart: row.normal_start, graceUntil: row.grace_until, veryLateFrom: row.very_late_from, scheduledEnd: row.scheduled_end, overtimeFrom: row.overtime_from, timezone: row.attendance_timezone, weekendOvertimeDays: policyWeekendOvertimeDays(row.policy) }))
  const calculations: ReportCalculation[] = calculationRows.filter((row) => row.employee_id).map((row) => {
    const result = row.calculation_result
    const engineVersion = result && typeof result === 'object' && !Array.isArray(result) && typeof result.engineVersion === 'number' ? result.engineVersion : null
    return { id: row.id, employeeId: row.employee_id!, date: row.attendance_date, version: row.calculation_version, rulesVersionId: row.rules_version_id, firstRecordedAt: row.first_recorded_at, lastRecordedAt: row.last_recorded_at, recordedEventCount: row.recorded_event_count, arrivalClassification: row.arrival_classification, overtimeEvidence: row.overtime_evidence, weekend: row.is_weekend, completeness: row.completeness, calculatedAt: row.calculated_at, engineVersion, evidenceIds: calculationEvidence.get(row.id) ?? [], correctionCount: correctionRows.filter((correction) => correction.daily_calculation_id === row.id).length }
  })
  const reviews: ReportReviewItem[] = reviewRows.map((row) => ({ id: row.id, importId: row.import_id, evidenceId: row.raw_fingerprint_event_id ?? row.organized_attendance_entry_id, issueCode: row.issue_code, severity: row.severity, description: row.description, status: row.status }))
  const imports: ReportImport[] = importRows.map((row) => ({ id: row.id, filename: row.original_filename, sourceType: row.source_type, uploadedAt: row.uploaded_at, checksum: row.sha256_checksum }))
  const employeesById = new Map(inputEmployees.map((employee) => [employee.id, employee]))
  const calculationsById = new Map(calculations.map((calculation) => [calculation.id, calculation]))
  const corrections: ReportCorrection[] = correctionRows.flatMap((row) => {
    const calculation = calculationsById.get(row.daily_calculation_id)
    if (!calculation) return []
    return [{ id: row.id, calculationId: row.daily_calculation_id, employeeId: calculation.employeeId, correctedAt: row.corrected_at, correctedBy: row.corrected_by, reason: row.reason, correctionType: row.correction_type }]
  }).filter((row) => employeesById.has(row.employeeId))
  return { reportId, generatedAt, from, to, employees: inputEmployees, evidence, calculations, corrections, reviews, rules, imports }
}
