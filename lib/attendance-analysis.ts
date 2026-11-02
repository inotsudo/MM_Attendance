import { inferFingerprintDirection, processAttendanceEvents, type AttendanceRules, type FingerprintEvent } from './attendance-engine'
import { parseSourceDateTime } from './imports/time'

export type AnalysisEvidence = {
  id: string
  sourceType: 'ivms_pdf_original_records' | 'organized_excel'
  importId: string
  filename: string
  employeeNumber: string | null
  employeeName: string | null
  department: string | null
  date: string | null
  timestamp: string | null
  sourceTimestampText?: string | null
  sourceIn?: string | null
  sourceOut?: string | null
  normalizedInAt?: string | null
  normalizedOutAt?: string | null
  sourcePage?: number | null
  sourceSheet?: string | null
  sourceRow?: number | null
  matchedEmployeeId: string | null
}

export type AnalysisCalculation = {
  id: string
  employeeId: string
  employeeNumber: string
  employeeName: string
  attendanceDate: string
  version: number
  rulesVersionId: string
  arrivalClassification: string
  firstRecordedAt: string | null
  lastRecordedAt: string | null
  recordedEventCount: number
  overtimeEvidence: boolean
  weekend: boolean
  completeness: string
  calculationResult: unknown
}

export type AnalysisRule = AttendanceRules & {
  id: string
  effectiveFrom: string
  timezone: string
}

export type AttendanceFindingDraft = {
  employeeId: string | null
  employeeNumber: string | null
  employeeName: string | null
  attendanceDate: string | null
  category: string
  evidenceClass: 'confirmed_inconsistency' | 'potential_inconsistency' | 'insufficient_evidence'
  title: string
  explanation: string
  currentValues: Record<string, unknown>
  sourceReferences: Record<string, unknown>
  rulesVersionId: string | null
  calculationId: string | null
  proposal: null | {
    affectedField: 'arrival_classification'
    previousValue: { value: string }
    proposedValue: { value: string }
    proposedCalculation: Record<string, unknown>
    explanation: string
    confidence: number
  }
}

function recordSource(item: AnalysisEvidence) {
  return {
    evidenceId: item.id,
    importId: item.importId,
    file: item.filename,
    kind: item.sourceType === 'ivms_pdf_original_records' ? 'iVMS PDF' : 'Organized Excel',
    employeeId: item.employeeNumber,
    employeeName: item.employeeName,
    date: item.date,
    time: item.timestamp ?? null,
    originalTime: item.sourceTimestampText ?? null,
    in: item.sourceIn ?? null,
    out: item.sourceOut ?? null,
    page: item.sourcePage ?? null,
    sheet: item.sourceSheet ?? null,
    row: item.sourceRow ?? null,
  }
}

function parseEngineVersion(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const version = (value as { engineVersion?: unknown }).engineVersion
  return typeof version === 'number' ? version : null
}

export function analyzeAttendanceCalculation(input: {
  calculation: AnalysisCalculation
  evidence: AnalysisEvidence[]
  rule: AnalysisRule | null
  engineVersion: number
}): AttendanceFindingDraft[] {
  const { calculation, evidence, rule, engineVersion } = input
  const sourceReferences = { evidenceIds: evidence.map((item) => item.id).sort(), records: evidence.map(recordSource) }
  const currentValues = {
    arrivalClassification: calculation.arrivalClassification,
    firstRecordedAt: calculation.firstRecordedAt,
    lastRecordedAt: calculation.lastRecordedAt,
    recordedEventCount: calculation.recordedEventCount,
    overtimeEvidence: calculation.overtimeEvidence,
    completeness: calculation.completeness,
    ruleVersionId: calculation.rulesVersionId,
  }
  const base = {
    employeeId: calculation.employeeId,
    employeeNumber: calculation.employeeNumber,
    employeeName: calculation.employeeName,
    attendanceDate: calculation.attendanceDate,
    currentValues,
    sourceReferences,
    calculationId: calculation.id,
  }

  if (!evidence.length) return [{
    ...base, category: 'missing_source_evidence', evidenceClass: 'insufficient_evidence',
    title: 'Calculation has no linked source evidence',
    explanation: 'The saved calculation cannot be checked because no original source rows are linked to it.',
    rulesVersionId: rule?.id ?? null, proposal: null,
  }]
  if (!rule || rule.timezone !== 'Africa/Kigali') return [{
    ...base, category: 'attendance_rules_unavailable', evidenceClass: 'insufficient_evidence',
    title: 'Attendance rules cannot verify this day',
    explanation: rule ? `The applicable rule uses ${rule.timezone}; MM&RJD attendance is grouped in Africa/Kigali.` : 'No versioned attendance rule is effective for this date.',
    rulesVersionId: rule?.id ?? null, proposal: null,
  }]

  const identityConflicts = evidence.filter((item) => item.matchedEmployeeId !== calculation.employeeId)
  if (identityConflicts.length) return [{
    ...base, category: 'conflicting_employee_match', evidenceClass: 'insufficient_evidence',
    title: 'Source employee match conflicts with the calculation',
    explanation: 'One or more linked source rows are unmatched or assigned to a different employee. No attendance correction is proposed until the identity is reviewed.',
    rulesVersionId: rule.id, proposal: null,
  }]

  const events: FingerprintEvent[] = []
  const findings: AttendanceFindingDraft[] = []
  const invalidSourceTimes = evidence.filter((item) => item.sourceType === 'ivms_pdf_original_records'
    ? !parseSourceDateTime(item.timestamp ?? item.sourceTimestampText ?? '').iso
    : Boolean((item.sourceIn && !item.normalizedInAt) || (item.sourceOut && !item.normalizedOutAt)))
  for (const item of evidence) {
    if (item.sourceType === 'ivms_pdf_original_records') {
      const timestamp = item.timestamp ?? item.sourceTimestampText ?? ''
      events.push({ id: item.id, employeeId: calculation.employeeId, employeeName: item.employeeName, department: item.department, timestamp })
    } else {
      if (item.normalizedInAt) events.push({ id: `${item.id}:in`, employeeId: calculation.employeeId, employeeName: item.employeeName, department: item.department, timestamp: item.normalizedInAt, direction: 'IN' })
      if (item.normalizedOutAt) events.push({ id: `${item.id}:out`, employeeId: calculation.employeeId, employeeName: item.employeeName, department: item.department, timestamp: item.normalizedOutAt, direction: 'OUT' })
    }
  }
  if (events.length === 0) return [...findings, {
    ...base, category: 'incomplete_attendance_evidence', evidenceClass: 'insufficient_evidence',
    title: 'No usable attendance times are saved for this day',
    explanation: 'The linked records contain blank or unparseable time values. The original values remain available for review; no time is invented.',
    rulesVersionId: rule.id, proposal: null,
  }]
  const result = processAttendanceEvents(events, rule)[0]
  if (!result || result.attendanceDate !== calculation.attendanceDate) return [{
    ...base, category: 'invalid_or_mismatched_source_date', evidenceClass: 'insufficient_evidence',
    title: 'Source dates do not match the calculated day',
    explanation: 'The linked evidence cannot be reliably grouped into this employee and attendance date.',
    rulesVersionId: rule.id, proposal: null,
  }]

  const duplicateTimes = new Set(events.map((event) => event.timestamp)).size < events.length
  if (invalidSourceTimes.length) findings.push({
    ...base, category: 'invalid_source_timestamp', evidenceClass: 'insufficient_evidence',
    title: 'One or more source times are invalid',
    explanation: 'The original time text is preserved, but the value cannot be interpreted as a valid attendance time. No correction is proposed.',
    rulesVersionId: rule.id, proposal: null,
  })
  if (duplicateTimes) findings.push({
    ...base, category: 'duplicate_fingerprint_events', evidenceClass: 'potential_inconsistency',
    title: 'Duplicate source timestamps found',
    explanation: 'Two or more linked records have the same timestamp. Both source records are preserved; verify whether the duplicate is genuine before making a decision.',
    rulesVersionId: rule.id, proposal: null,
  })

  const currentRuleIsLatest = calculation.rulesVersionId === rule.id
  const savedEngine = parseEngineVersion(calculation.calculationResult)
  const refreshed = {
    arrivalClassification: result.arrivalClassification,
    firstRecordedAt: result.firstRecordedEvent,
    lastRecordedAt: result.lastRecordedEvent,
    recordedEventCount: result.totalRecordedEvents,
    overtimeEvidence: result.overtimeEvidence,
    isWeekend: result.weekend,
    completeness: result.completeness,
    engineVersion,
    calculationResult: {
      engineVersion,
      rulesVersion: rule.version,
      sourceEventIds: result.sourceEventIds,
      directionPolicy: 'fingerprint-before-12-kigali-in-after-12-out',
      reviewIssues: result.reviewIssues,
    },
  }
  const classChanged = calculation.arrivalClassification !== result.arrivalClassification
  const anyValueChanged = classChanged || calculation.firstRecordedAt !== result.firstRecordedEvent || calculation.lastRecordedAt !== result.lastRecordedEvent || calculation.recordedEventCount !== result.totalRecordedEvents || calculation.overtimeEvidence !== result.overtimeEvidence || calculation.completeness !== result.completeness
  const needsRefresh = !currentRuleIsLatest || savedEngine !== engineVersion

  if (classChanged || needsRefresh || anyValueChanged) {
    const hasExplicitArrival = evidence.some((item) => item.sourceType === 'organized_excel' && item.normalizedInAt)
    const hasPdfArrival = evidence.some((item) => item.sourceType === 'ivms_pdf_original_records' && inferFingerprintDirection(item.timestamp ?? item.sourceTimestampText ?? '') === 'IN')
    const enoughEvidence = hasExplicitArrival || hasPdfArrival
    const proposal = classChanged && enoughEvidence ? {
      affectedField: 'arrival_classification' as const,
      previousValue: { value: calculation.arrivalClassification },
      proposedValue: { value: result.arrivalClassification },
      proposedCalculation: refreshed,
      explanation: `Recalculation from the linked source events and rule v${rule.version} produces “${result.arrivalClassification.replaceAll('_', ' ')}”, while the saved result is “${calculation.arrivalClassification.replaceAll('_', ' ')}”.`,
      confidence: hasExplicitArrival ? 0.99 : 0.85,
    } : null
    findings.push({
      ...base,
      category: classChanged ? 'arrival_classification_mismatch' : 'stale_calculation',
      evidenceClass: hasExplicitArrival ? 'confirmed_inconsistency' : enoughEvidence ? 'potential_inconsistency' : 'insufficient_evidence',
      title: classChanged ? 'Saved arrival classification differs from source-based calculation' : 'Calculation needs refreshing',
      explanation: proposal?.explanation ?? (classChanged ? 'The available PDF events do not establish a reliable arrival event, so the system cannot propose a corrected classification.' : 'The saved calculation uses an old rule or engine version. The current source evidence does not support an automatic field correction; the day needs reprocessing and review.'),
      rulesVersionId: rule.id,
      proposal,
    })
  }

  if (result.completeness === 'incomplete_evidence') findings.push({
    ...base, category: 'incomplete_attendance_evidence', evidenceClass: 'insufficient_evidence',
    title: 'Attendance evidence is incomplete',
    explanation: result.reviewIssues.map((issue) => issue.message).join(' ') || 'An arrival or departure value is missing. No time is inferred or invented.',
    rulesVersionId: rule.id, proposal: null,
  })
  return findings
}

export function comparePdfAndExcelEvidence(input: {
  selectedImportId: string
  records: AnalysisEvidence[]
  calculations: AnalysisCalculation[]
}): AttendanceFindingDraft[] {
  const groups = new Map<string, AnalysisEvidence[]>()
  for (const item of input.records) {
    if (!item.matchedEmployeeId || !item.date) continue
    const key = `${item.matchedEmployeeId}|${item.date}`
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const calculationByDay = new Map(input.calculations.map((calculation) => [`${calculation.employeeId}|${calculation.attendanceDate}`, calculation]))
  const findings: AttendanceFindingDraft[] = []
  for (const [key, records] of groups) {
    const selectedSource = records.some((record) => record.importId === input.selectedImportId)
    const pdf = records.filter((record) => record.sourceType === 'ivms_pdf_original_records')
    const excel = records.filter((record) => record.sourceType === 'organized_excel')
    if (!selectedSource || !pdf.length || !excel.length) continue
    const toTimestamp = (value: string) => {
      const normalized = parseSourceDateTime(value).iso
      return normalized ? Date.parse(normalized) : Number.NaN
    }
    const fingerprintIns = pdf.flatMap((item) => {
      const timestamp = item.timestamp ?? item.sourceTimestampText ?? ''
      return inferFingerprintDirection(timestamp) === 'IN' ? [{ timestamp, at: toTimestamp(timestamp), item }] : []
    }).filter((event) => Number.isFinite(event.at)).sort((a, b) => a.at - b.at)
    const fingerprintOuts = pdf.flatMap((item) => {
      const timestamp = item.timestamp ?? item.sourceTimestampText ?? ''
      return inferFingerprintDirection(timestamp) === 'OUT' ? [{ timestamp, at: toTimestamp(timestamp), item }] : []
    }).filter((event) => Number.isFinite(event.at)).sort((a, b) => a.at - b.at)
    const excelIns = excel.flatMap((item) => item.normalizedInAt ? [{ timestamp: item.normalizedInAt, at: Date.parse(item.normalizedInAt), item }] : []).sort((a, b) => a.at - b.at)
    const excelOuts = excel.flatMap((item) => item.normalizedOutAt ? [{ timestamp: item.normalizedOutAt, at: Date.parse(item.normalizedOutAt), item }] : []).sort((a, b) => a.at - b.at)
    const comparisons = [
      { field: 'IN', pdf: fingerprintIns[0], excel: excelIns[0] },
      { field: 'OUT', pdf: fingerprintOuts.at(-1), excel: excelOuts.at(-1) },
    ].filter((row) => row.pdf && row.excel && row.pdf.at !== row.excel.at)
    if (!comparisons.length) continue
    const [employeeId, attendanceDate] = key.split('|')
    const calculation = calculationByDay.get(key)
    const values = Object.fromEntries(comparisons.map((row) => [`${row.field.toLowerCase()}Comparison`, { pdf: row.pdf!.timestamp, excel: row.excel!.timestamp }]))
    const recordsForFinding = [...new Map([...comparisons.flatMap((row) => [row.pdf!.item, row.excel!.item]), ...records].map((item) => [item.id, item])).values()]
    const first = recordsForFinding[0]
    findings.push({
      employeeId,
      employeeNumber: first.employeeNumber,
      employeeName: first.employeeName,
      attendanceDate,
      category: 'pdf_excel_time_discrepancy',
      evidenceClass: 'potential_inconsistency',
      title: 'PDF and Excel attendance times differ',
      explanation: `The saved PDF fingerprint times and organized Excel values differ: ${comparisons.map((row) => `${row.field} · PDF ${row.pdf!.timestamp} · Excel ${row.excel!.timestamp}`).join('; ')}. The PDF is preserved as event evidence and Excel values are not assumed correct; HR must decide which record is valid.`,
      currentValues: values,
      sourceReferences: { evidenceIds: recordsForFinding.map((item) => item.id).sort(), records: recordsForFinding.map(recordSource) },
      rulesVersionId: calculation?.rulesVersionId ?? null,
      calculationId: calculation?.id ?? null,
      proposal: null,
    })
  }
  return findings
}
