import { NextResponse } from 'next/server'
import { analyzeAttendanceCalculation, comparePdfAndExcelEvidence, type AnalysisCalculation, type AnalysisEvidence, type AnalysisRule } from '@/lib/attendance-analysis'
import type { AttendanceFindingDraft } from '@/lib/attendance-analysis'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 60
const PAGE_SIZE = 500
const MAX_ROWS = 10_000
const ENGINE_VERSION = 3

type Page<T> = { data: T[] | null; error: { message: string } | null }
async function fetchAll<T>(query: (from: number, to: number) => PromiseLike<Page<T>>): Promise<T[]> {
  const result: T[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await query(from, from + PAGE_SIZE - 1)
    if (error) throw new Error('Persisted attendance evidence could not be loaded for analysis.')
    const batch = data ?? []
    result.push(...batch)
    if (batch.length < PAGE_SIZE) return result
  }
  throw new Error('This import has more than 10,000 source records. Split it into smaller files before analysis.')
}

function chunks<T>(values: T[], size = 100) {
  const output: T[][] = []
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size))
  return output
}

function kigaliDate(value: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value))
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day}`
}

export async function POST(request: Request) {
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  let input: unknown
  try { input = await request.json() } catch { return NextResponse.json({ error: 'Choose an uploaded attendance file to analyze.' }, { status: 400 }) }
  const importId = input && typeof input === 'object' ? (input as Record<string, unknown>).importId : null
  if (typeof importId !== 'string' || !/^[0-9a-f-]{36}$/i.test(importId)) return NextResponse.json({ error: 'Choose a valid uploaded attendance file.' }, { status: 400 })

  const supabase = await createSupabaseServerClient()
  try {
    const { data: imported, error: importError } = await supabase.from('attendance_imports')
      .select('id, original_filename, source_type, processing_status')
      .eq('id', importId).maybeSingle()
    if (importError || !imported) return NextResponse.json({ error: 'The selected attendance file could not be found.' }, { status: 404 })
    if (!['completed', 'needs_review'].includes(imported.processing_status)) return NextResponse.json({ error: 'Analyze a file after its source records have been saved.' }, { status: 409 })

    const isPdf = imported.source_type === 'ivms_pdf_original_records'
    const sourceRows = isPdf
      ? await fetchAll((from, to) => supabase.from('raw_fingerprint_events').select('id, import_id, source_employee_number, source_employee_name, source_department, source_page, source_row, source_timestamp_text, normalized_timestamp').eq('import_id', importId).order('source_row').range(from, to))
      : await fetchAll((from, to) => supabase.from('organized_attendance_entries').select('id, import_id, source_employee_number, source_employee_name, source_department, source_sheet, source_row, source_work_date_text, normalized_work_date, source_in_text, normalized_in_at, source_out_text, normalized_out_at').eq('import_id', importId).order('source_row').range(from, to))
    if (!sourceRows.length) return NextResponse.json({ error: 'This upload has no persisted source records to analyze.' }, { status: 409 })

    const sourceIds = sourceRows.map((row) => row.id)
    const sourceDateValues = sourceRows.map((row) => 'normalized_timestamp' in row
      ? row.normalized_timestamp ? kigaliDate(row.normalized_timestamp) : null
      : row.normalized_work_date).filter((date): date is string => Boolean(date)).sort()
    const dateFrom = sourceDateValues[0]
    const dateTo = sourceDateValues.at(-1)
    const afterDate = dateTo ? new Date(Date.parse(`${dateTo}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : null
    const crossSourceRows = dateFrom && dateTo && afterDate ? await Promise.all([
      fetchAll((from, to) => supabase.from('raw_fingerprint_events').select('id, import_id, source_employee_number, source_employee_name, source_department, source_page, source_row, source_timestamp_text, normalized_timestamp').gte('normalized_timestamp', new Date(`${dateFrom}T00:00:00+02:00`).toISOString()).lt('normalized_timestamp', new Date(`${afterDate}T00:00:00+02:00`).toISOString()).range(from, to)),
      fetchAll((from, to) => supabase.from('organized_attendance_entries').select('id, import_id, source_employee_number, source_employee_name, source_department, source_sheet, source_row, source_work_date_text, normalized_work_date, source_in_text, normalized_in_at, source_out_text, normalized_out_at').gte('normalized_work_date', dateFrom).lte('normalized_work_date', dateTo).range(from, to)),
    ]) : [[], []]
    const linkedEvidence = (await Promise.all(chunks(sourceIds).map((ids) => isPdf
      ? fetchAll((from, to) => supabase.from('daily_attendance_evidence').select('daily_calculation_id, raw_fingerprint_event_id, organized_attendance_entry_id').in('raw_fingerprint_event_id', ids).range(from, to))
      : fetchAll((from, to) => supabase.from('daily_attendance_evidence').select('daily_calculation_id, raw_fingerprint_event_id, organized_attendance_entry_id').in('organized_attendance_entry_id', ids).range(from, to))))).flat()
    const candidateCalculationIds = [...new Set(linkedEvidence.map((row) => row.daily_calculation_id))]
    const initialCalculations = candidateCalculationIds.length
      ? (await Promise.all(chunks(candidateCalculationIds).map((ids) => fetchAll((from, to) => supabase.from('daily_attendance_calculations')
          .select('id, employee_id, attendance_date, calculation_version, rules_version_id, first_recorded_at, last_recorded_at, recorded_event_count, arrival_classification, overtime_evidence, is_weekend, completeness, calculation_result')
          .in('id', ids).range(from, to))))).flat()
      : []
    const employeeIds = [...new Set(initialCalculations.flatMap((row) => row.employee_id ? [row.employee_id] : []))]
    const dates = initialCalculations.map((row) => row.attendance_date).sort()
    const currentCalculations = employeeIds.length && dates.length
      ? (await Promise.all(chunks(employeeIds).map((ids) => fetchAll((from, to) => supabase.from('daily_attendance_calculations')
          .select('id, employee_id, attendance_date, calculation_version, rules_version_id, first_recorded_at, last_recorded_at, recorded_event_count, arrival_classification, overtime_evidence, is_weekend, completeness, calculation_result')
          .in('employee_id', ids).gte('attendance_date', dates[0]).lte('attendance_date', dates.at(-1)!).order('calculation_version', { ascending: false }).range(from, to))))).flat()
      : []
    const latestByEmployeeDate = new Map<string, typeof currentCalculations[number]>()
    for (const row of currentCalculations) {
      const key = `${row.employee_id}|${row.attendance_date}`
      if (!latestByEmployeeDate.has(key)) latestByEmployeeDate.set(key, row)
    }
    const candidates = [...new Map(initialCalculations.map((row) => {
      const key = `${row.employee_id}|${row.attendance_date}`
      return [key, latestByEmployeeDate.get(key) ?? row] as const
    })).values()]
    const calculationIds = [...new Set(candidates.map((row) => row.id))]
    const calculationEvidence = calculationIds.length
      ? (await Promise.all(chunks(calculationIds).map((ids) => fetchAll((from, to) => supabase.from('daily_attendance_evidence')
          .select('daily_calculation_id, raw_fingerprint_event_id, organized_attendance_entry_id').in('daily_calculation_id', ids).range(from, to))))).flat()
      : []
    const allRawIds = [...new Set(calculationEvidence.flatMap((row) => row.raw_fingerprint_event_id ? [row.raw_fingerprint_event_id] : []))]
    const allEntryIds = [...new Set(calculationEvidence.flatMap((row) => row.organized_attendance_entry_id ? [row.organized_attendance_entry_id] : []))]
    const [linkedRawRows, linkedEntryRows] = await Promise.all([
      allRawIds.length ? Promise.all(chunks(allRawIds).map((ids) => fetchAll((from, to) => supabase.from('raw_fingerprint_events').select('id, import_id, source_employee_number, source_employee_name, source_department, source_page, source_row, source_timestamp_text, normalized_timestamp').in('id', ids).range(from, to)))).then((pages) => pages.flat()) : [],
      allEntryIds.length ? Promise.all(chunks(allEntryIds).map((ids) => fetchAll((from, to) => supabase.from('organized_attendance_entries').select('id, import_id, source_employee_number, source_employee_name, source_department, source_sheet, source_row, source_work_date_text, normalized_work_date, source_in_text, normalized_in_at, source_out_text, normalized_out_at').in('id', ids).range(from, to)))).then((pages) => pages.flat()) : [],
    ])
    // Include every selected source row, even malformed rows with no normalized date,
    // so their existing match decisions can be reported accurately.
    const selectedRawRows = isPdf ? sourceRows as typeof crossSourceRows[0] : []
    const selectedEntryRows = !isPdf ? sourceRows as typeof crossSourceRows[1] : []
    const rawRows = [...new Map([...crossSourceRows[0], ...linkedRawRows, ...selectedRawRows].map((row) => [row.id, row])).values()]
    const entryRows = [...new Map([...crossSourceRows[1], ...linkedEntryRows, ...selectedEntryRows].map((row) => [row.id, row])).values()]
    const rawById = new Map(rawRows.map((row) => [row.id, row]))
    const entryById = new Map(entryRows.map((row) => [row.id, row]))
    const allRawMatchIds = [...new Set(rawRows.map((row) => row.id))]
    const allEntryMatchIds = [...new Set(entryRows.map((row) => row.id))]
    const rawMatches = allRawMatchIds.length ? (await Promise.all(chunks(allRawMatchIds).map((ids) => fetchAll((from, to) => supabase.from('employee_match_decisions').select('raw_fingerprint_event_id, employee_id, match_status, created_at').in('raw_fingerprint_event_id', ids).order('created_at', { ascending: false }).range(from, to))))).flat() : []
    const entryMatches = allEntryMatchIds.length ? (await Promise.all(chunks(allEntryMatchIds).map((ids) => fetchAll((from, to) => supabase.from('employee_match_decisions').select('organized_attendance_entry_id, employee_id, match_status, created_at').in('organized_attendance_entry_id', ids).order('created_at', { ascending: false }).range(from, to))))).flat() : []
    const matchByEvidence = new Map<string, string | null>()
    for (const row of [...rawMatches, ...entryMatches]) {
      const key = ('raw_fingerprint_event_id' in row ? row.raw_fingerprint_event_id : row.organized_attendance_entry_id) as string | null
      if (key && !matchByEvidence.has(key)) matchByEvidence.set(key, row.match_status === 'matched' ? row.employee_id : null)
    }
    const allImportIds = [...new Set([...rawRows, ...entryRows].map((row) => row.import_id))]
    const [employeeResult, sourceImportResult, ruleRows] = await Promise.all([
      employeeIds.length ? supabase.from('employees').select('id, employee_number, full_name').in('id', employeeIds) : Promise.resolve({ data: [], error: null }),
      allImportIds.length ? supabase.from('attendance_imports').select('id, original_filename').in('id', allImportIds) : Promise.resolve({ data: [], error: null }),
      fetchAll((from, to) => supabase.from('attendance_rule_versions').select('id, version, attendance_timezone, effective_from, normal_start, grace_until, very_late_from, scheduled_end, overtime_from, policy').order('effective_from').order('version').range(from, to)),
    ])
    if (employeeResult.error || sourceImportResult.error) throw new Error('Employee or source import details could not be verified for analysis.')
    const employees = employeeResult.data ?? []
    const sourceImports = sourceImportResult.data ?? []
    const employeeById = new Map(employees.map((row) => [row.id, row]))
    const filenameByImport = new Map(sourceImports.map((row) => [row.id, row.original_filename]))
    const evidenceByCalculation = new Map<string, AnalysisEvidence[]>()
    for (const evidence of calculationEvidence) {
      const raw = evidence.raw_fingerprint_event_id ? rawById.get(evidence.raw_fingerprint_event_id) : null
      const entry = evidence.organized_attendance_entry_id ? entryById.get(evidence.organized_attendance_entry_id) : null
      const source = raw ?? entry
      if (!source) continue
      const item: AnalysisEvidence = raw ? {
        id: raw.id, sourceType: 'ivms_pdf_original_records', importId: raw.import_id,
        filename: filenameByImport.get(raw.import_id) ?? 'Attendance PDF', employeeNumber: raw.source_employee_number,
        employeeName: raw.source_employee_name, department: raw.source_department,
        date: raw.normalized_timestamp ? kigaliDate(raw.normalized_timestamp) : null,
        timestamp: raw.normalized_timestamp, sourceTimestampText: raw.source_timestamp_text,
        sourcePage: raw.source_page, sourceRow: raw.source_row, matchedEmployeeId: matchByEvidence.get(raw.id) ?? null,
      } : {
        id: entry!.id, sourceType: 'organized_excel', importId: entry!.import_id,
        filename: filenameByImport.get(entry!.import_id) ?? 'Attendance workbook', employeeNumber: entry!.source_employee_number,
        employeeName: entry!.source_employee_name, department: entry!.source_department, date: entry!.normalized_work_date, timestamp: null,
        sourceIn: entry!.source_in_text, sourceOut: entry!.source_out_text,
        normalizedInAt: entry!.normalized_in_at, normalizedOutAt: entry!.normalized_out_at,
        sourceSheet: entry!.source_sheet, sourceRow: entry!.source_row, matchedEmployeeId: matchByEvidence.get(entry!.id) ?? null,
      }
      evidenceByCalculation.set(evidence.daily_calculation_id, [...(evidenceByCalculation.get(evidence.daily_calculation_id) ?? []), item])
    }

    const findings: AttendanceFindingDraft[] = []
    const analysisCalculations: AnalysisCalculation[] = []
    for (const row of candidates) {
      if (!row.employee_id) continue
      const employee = employeeById.get(row.employee_id)
      if (!employee) continue
      const applicable = ruleRows.filter((rule) => rule.effective_from <= row.attendance_date).at(-1)
      const rule: AnalysisRule | null = applicable ? {
        id: applicable.id, version: applicable.version, effectiveFrom: applicable.effective_from,
        timezone: applicable.attendance_timezone, normalStart: applicable.normal_start,
        graceUntil: applicable.grace_until, veryLateFrom: applicable.very_late_from,
        scheduledEnd: applicable.scheduled_end, overtimeFrom: applicable.overtime_from,
        weekendOvertimeDays: applicable.policy && typeof applicable.policy === 'object' && !Array.isArray(applicable.policy) && Array.isArray((applicable.policy as Record<string, unknown>).weekendOvertimeDays)
          ? (applicable.policy as { weekendOvertimeDays: Array<'Saturday' | 'Sunday'> }).weekendOvertimeDays : null,
      } : null
      const calculation: AnalysisCalculation = {
          id: row.id, employeeId: row.employee_id, employeeNumber: employee.employee_number, employeeName: employee.full_name,
          attendanceDate: row.attendance_date, version: row.calculation_version, rulesVersionId: row.rules_version_id,
          arrivalClassification: row.arrival_classification, firstRecordedAt: row.first_recorded_at,
          lastRecordedAt: row.last_recorded_at, recordedEventCount: row.recorded_event_count,
          overtimeEvidence: row.overtime_evidence, weekend: row.is_weekend, completeness: row.completeness,
          calculationResult: row.calculation_result,
        }
      analysisCalculations.push(calculation)
      findings.push(...analyzeAttendanceCalculation({
        calculation,
        evidence: evidenceByCalculation.get(row.id) ?? [], rule, engineVersion: ENGINE_VERSION,
      }))
    }

    const crossSourceEvidence: AnalysisEvidence[] = [
      ...rawRows.map((row): AnalysisEvidence => ({
        id: row.id, sourceType: 'ivms_pdf_original_records', importId: row.import_id,
        filename: filenameByImport.get(row.import_id) ?? 'Attendance PDF', employeeNumber: row.source_employee_number,
        employeeName: row.source_employee_name, department: row.source_department,
        date: row.normalized_timestamp ? kigaliDate(row.normalized_timestamp) : null,
        timestamp: row.normalized_timestamp, sourceTimestampText: row.source_timestamp_text,
        sourcePage: row.source_page, sourceRow: row.source_row, matchedEmployeeId: matchByEvidence.get(row.id) ?? null,
      })),
      ...entryRows.map((row): AnalysisEvidence => ({
        id: row.id, sourceType: 'organized_excel', importId: row.import_id,
        filename: filenameByImport.get(row.import_id) ?? 'Attendance workbook', employeeNumber: row.source_employee_number,
        employeeName: row.source_employee_name, department: row.source_department, date: row.normalized_work_date,
        timestamp: null, sourceIn: row.source_in_text, sourceOut: row.source_out_text,
        normalizedInAt: row.normalized_in_at, normalizedOutAt: row.normalized_out_at,
        sourceSheet: row.source_sheet, sourceRow: row.source_row, matchedEmployeeId: matchByEvidence.get(row.id) ?? null,
      })),
    ]
    findings.push(...comparePdfAndExcelEvidence({ selectedImportId: importId, records: crossSourceEvidence, calculations: analysisCalculations }))

    const currentEvidenceIds = new Set(calculationEvidence.map((row) => row.raw_fingerprint_event_id ?? row.organized_attendance_entry_id))
    for (const row of sourceRows) {
      if (currentEvidenceIds.has(row.id)) continue
      const match = matchByEvidence.get(row.id) ?? null
      const employeeNumber = row.source_employee_number
      const employeeName = row.source_employee_name
      const normalizedTimestamp = 'normalized_timestamp' in row ? row.normalized_timestamp : null
      const normalizedWorkDate = 'normalized_work_date' in row ? row.normalized_work_date : null
      const date = isPdf ? (normalizedTimestamp ? kigaliDate(normalizedTimestamp) : null) : normalizedWorkDate
      const entry = 'source_in_text' in row ? row : null
      const raw = 'source_timestamp_text' in row ? row : null
      const sourceInPresent = Boolean(entry?.source_in_text?.trim())
      const sourceOutPresent = Boolean(entry?.source_out_text?.trim())
      const invalidPdfTimestamp = Boolean(raw && !normalizedTimestamp)
      const invalidExcelTime = Boolean(entry && ((sourceInPresent && !entry.normalized_in_at) || (sourceOutPresent && !entry.normalized_out_at)))
      const incompleteExcelDay = Boolean(entry && (!sourceInPresent || !sourceOutPresent))
      const missingExcelBoth = Boolean(entry && !sourceInPresent && !sourceOutPresent)
      const category = !match
        ? 'unmatched_employee'
        : invalidPdfTimestamp || invalidExcelTime
          ? 'invalid_source_timestamp'
          : incompleteExcelDay
            ? 'incomplete_organized_attendance'
            : 'source_not_in_current_calculation'
      const title = !match
        ? 'Employee identity needs review'
        : invalidPdfTimestamp || invalidExcelTime
          ? 'Source date or time could not be interpreted'
          : incompleteExcelDay
            ? missingExcelBoth ? 'Organized attendance row has no recorded times' : 'Organized attendance is missing an IN or OUT value'
            : 'Source record is not in a current calculation'
      const explanation = !match
        ? 'This source row has no confirmed employee match. The system cannot include it in an employee calculation.'
        : invalidPdfTimestamp
          ? `The original PDF timestamp “${raw?.source_timestamp_text ?? ''}” could not be normalized. It is preserved for inspection and is not used to calculate attendance.`
          : invalidExcelTime
            ? 'At least one original Excel time value could not be interpreted. The source cell value is preserved; no time is inferred.'
            : missingExcelBoth
              ? 'This dated workbook row has neither an IN nor an OUT time. Without an approved work calendar, it cannot be classified as an absence.'
              : incompleteExcelDay
                ? `The workbook row is missing its ${!sourceInPresent ? 'IN' : 'OUT'} value. The missing counterpart is not inferred.`
                : 'This saved source row is not linked to the current employee/date calculation. It is preserved and excluded from correction proposals until recalculation includes it.'
      findings.push({
        employeeId: match, employeeNumber, employeeName, attendanceDate: date,
        category,
        evidenceClass: 'insufficient_evidence',
        title,
        explanation,
        currentValues: {}, sourceReferences: { evidenceIds: [row.id], records: [{ evidenceId: row.id, importId, file: imported.original_filename, employeeId: employeeNumber, employeeName, sourceRow: row.source_row, sourcePage: 'source_page' in row ? row.source_page : null, sourceSheet: 'source_sheet' in row ? row.source_sheet : null }] },
        rulesVersionId: null, calculationId: null, proposal: null,
      })
    }

    const summary = {
      recordsAnalyzed: sourceRows.length,
      confirmedInconsistencies: findings.filter((finding) => finding.evidenceClass === 'confirmed_inconsistency').length,
      potentialInconsistencies: findings.filter((finding) => finding.evidenceClass === 'potential_inconsistency').length,
      insufficientEvidence: findings.filter((finding) => finding.evidenceClass === 'insufficient_evidence').length,
      proposals: findings.filter((finding) => finding.proposal !== null).length,
    }
    const sourceDates = sourceRows.map((row) => {
      if ('normalized_timestamp' in row) return row.normalized_timestamp ? kigaliDate(row.normalized_timestamp) : null
      return row.normalized_work_date
    }).filter((date): date is string => Boolean(date))
    const datesFound = [...findings.map((finding) => finding.attendanceDate), ...sourceDates].filter((date): date is string => Boolean(date)).sort()
    const { data: run, error: persistError } = await supabase.rpc('persist_attendance_analysis', {
      p_import_id: importId,
      p_period_from: datesFound[0] ?? null,
      p_period_to: datesFound.at(-1) ?? null,
      p_source_record_count: sourceRows.length,
      p_summary: summary,
      p_findings: findings as unknown as import('@/lib/database.types').Json,
    })
    if (persistError) throw new Error('The analysis could not be saved. Apply the attendance review database migrations and retry.')
    const persisted = run as { runId?: string; findingCount?: number; proposalCount?: number }
    return NextResponse.json({ analysisRunId: persisted.runId, summary: { ...summary, findingCount: persisted.findingCount ?? findings.length, proposalCount: persisted.proposalCount ?? summary.proposals } }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Attendance analysis failed.' }, { status: 422, headers: { 'Cache-Control': 'private, no-store' } })
  }
}
