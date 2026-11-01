import type { AttendanceReport, ReportCalculation, ReportCorrection, ReportEmployee, ReportEvidence, ReportException, ReportImport, ReportReviewItem, ReportRule } from './types'

export type BuildAttendanceReportInput = {
  reportId: string
  generatedAt: string
  from: string
  to: string
  employees: ReportEmployee[]
  evidence: ReportEvidence[]
  calculations: ReportCalculation[]
  corrections: ReportCorrection[]
  reviews: ReportReviewItem[]
  rules: ReportRule[]
  imports: ReportImport[]
}

export function dateSequence(from: string, to: string) {
  const dates: string[] = []
  for (let time = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); time <= end; time += 86_400_000) {
    dates.push(new Date(time).toISOString().slice(0, 10))
  }
  return dates
}

export function formatKigaliTime(value: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}

export function formatKigaliDateTime(value: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(value))
}

function ruleFor(date: string, rules: ReportRule[]) {
  return rules.filter((rule) => rule.effectiveFrom <= date).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.version - b.version).at(-1)
}

function labelClassification(value: string) {
  return ({ before_start: 'Before start', on_time: 'On time', late: 'Late', very_late: 'Very late', no_event: 'Not recorded' } as Record<string, string>)[value] ?? 'Unclassified'
}

export function buildAttendanceReport(input: BuildAttendanceReportInput): AttendanceReport {
  const dates = dateSequence(input.from, input.to)
  const exceptions: ReportException[] = []
  for (const date of dates) {
    const rule = ruleFor(date, input.rules)
    const hasReportingSubjects = input.employees.length > 0 || input.evidence.some((item) => item.date === date)
    if (!rule && hasReportingSubjects) exceptions.push({ severity: 'error', employeeNumber: null, employeeName: null, date, source: null, explanation: `No versioned attendance rule is effective on ${date}; no classifications can be verified.` })
    else if (rule && rule.timezone !== 'Africa/Kigali' && hasReportingSubjects) exceptions.push({ severity: 'error', employeeNumber: null, employeeName: null, date, source: `Rule v${rule.version}`, explanation: `The applicable rule uses ${rule.timezone}, not Africa/Kigali; no classifications can be verified.` })
  }
  const evidenceByEmployeeDate = new Map<string, ReportEvidence[]>()
  for (const item of input.evidence) {
    if (!item.date) {
      exceptions.push({ severity: 'error', employeeNumber: item.employeeNumber, employeeName: item.employeeName, date: null, source: item.sourceType, explanation: `Source record ${item.id} has no normalized date and cannot be placed in a reporting day.` })
      continue
    }
    if (item.date < input.from || item.date > input.to) continue
    if (!item.employeeId) {
      exceptions.push({ severity: 'warning', employeeNumber: item.employeeNumber, employeeName: item.employeeName, date: item.date, source: item.sourceType, explanation: 'Source record has no confirmed employee match and is excluded from employee totals.' })
      continue
    }
    const key = `${item.employeeId}|${item.date}`
    evidenceByEmployeeDate.set(key, [...(evidenceByEmployeeDate.get(key) ?? []), item])
  }

  const calculationsByEmployeeDate = new Map<string, ReportCalculation[]>()
  for (const calculation of input.calculations) {
    const key = `${calculation.employeeId}|${calculation.date}`
    calculationsByEmployeeDate.set(key, [...(calculationsByEmployeeDate.get(key) ?? []), calculation])
  }
  const reviewsByEvidence = new Map<string, ReportReviewItem[]>()
  const attachedReviewIds = new Set<string>()
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]))
  const relevantImportIds = new Set(input.evidence.map((item) => item.importId))
  for (const review of input.reviews) {
    if (review.status !== 'open' || !relevantImportIds.has(review.importId)) continue
    if (review.evidenceId) {
      const source = evidenceById.get(review.evidenceId)
      if (!source?.date || source.date < input.from || source.date > input.to) continue
      reviewsByEvidence.set(review.evidenceId, [...(reviewsByEvidence.get(review.evidenceId) ?? []), review])
    }
  }

  const sourceKeys = new Set([...evidenceByEmployeeDate.keys()])
  for (const calculation of input.calculations) {
    if (calculation.date < input.from || calculation.date > input.to || sourceKeys.has(`${calculation.employeeId}|${calculation.date}`)) continue
    const employee = input.employees.find((item) => item.id === calculation.employeeId)
    exceptions.push({ severity: 'warning', employeeNumber: employee?.employeeNumber ?? null, employeeName: employee?.fullName ?? null, date: calculation.date, source: 'Saved calculation', explanation: 'A saved calculation has no source evidence linked in this reporting period and is not included as current attendance.' })
  }
  for (const review of input.reviews) {
    if (review.status !== 'open' || !relevantImportIds.has(review.importId) || review.evidenceId) continue
    exceptions.push({ severity: review.severity, employeeNumber: null, employeeName: null, date: null, source: input.imports.find((item) => item.id === review.importId)?.filename ?? null, explanation: review.description })
  }

  const employeeRows = input.employees.map((employee) => {
    let calculatedDays = 0
    let evidenceDays = 0
    let lateDays = 0
    let veryLateDays = 0
    let overtimeDays = 0
    let incompleteDays = 0
    let noSourceRecordDays = 0

    const days = dates.map((date) => {
      const key = `${employee.id}|${date}`
      const sources = evidenceByEmployeeDate.get(key) ?? []
      const organized = sources.filter((item) => item.sourceType === 'organized_excel')
      const fingerprint = sources.filter((item) => item.sourceType === 'ivms_pdf_original_records')
      const candidates = (calculationsByEmployeeDate.get(key) ?? []).sort((a, b) => b.version - a.version)
      const calculation = candidates[0]
      const applicableRule = ruleFor(date, input.rules)
      const expectedIds = organized.map((item) => item.id).sort()
      const actualIds = calculation?.evidenceIds.slice().sort() ?? []
      const evidenceComplete = expectedIds.length > 0 && expectedIds.length === actualIds.length && expectedIds.every((id, index) => id === actualIds[index]) && fingerprint.length === 0
      const ruleCurrent = Boolean(applicableRule && calculation?.rulesVersionId === applicableRule.id && applicableRule.timezone === 'Africa/Kigali')
      const engineCurrent = calculation?.engineVersion === 2
      const hasCorrections = Boolean(calculation && (calculation.correctionCount > 0 || input.corrections.some((correction) => correction.calculationId === calculation.id)))
      const current = Boolean(calculation && ruleCurrent && engineCurrent && evidenceComplete && !hasCorrections)
      const allTimes = sources.flatMap((item) => item.sourceType === 'organized_excel'
        ? [item.normalizedInAt, item.normalizedOutAt].map(formatKigaliTime).filter((time): time is string => Boolean(time))
        : item.timestamp ? [formatKigaliTime(item.timestamp)].filter((time): time is string => Boolean(time)) : [])
      const inTimes = organized.flatMap((item) => item.sourceIn ? [formatKigaliTime(item.normalizedInAt) ?? item.sourceIn] : []).sort()
      const outTimes = organized.flatMap((item) => item.sourceOut ? [formatKigaliTime(item.normalizedOutAt) ?? item.sourceOut] : []).sort()
      const notes = new Set<string>()
      const evidenceReviews = sources.flatMap((item) => reviewsByEvidence.get(item.id) ?? [])
      for (const review of evidenceReviews) notes.add(review.description)

      let kind: 'calculated' | 'fingerprint_events' | 'organized_evidence' | 'stale' | 'no_records'
      let classification = '—'
      let completeness = 'No source records'
      let overtime: 'Yes' | 'No' | 'Unverified' | '—' = '—'
      if (!sources.length) {
        kind = 'no_records'
        noSourceRecordDays += 1
        notes.add('No source records were imported for this day; this is not a verified absence.')
        exceptions.push({ severity: 'info', employeeNumber: employee.employeeNumber, employeeName: employee.fullName, date, source: null, explanation: 'No source records were imported for this employee and date. This is not a verified absence.' })
      } else {
        evidenceDays += 1
        if (current && calculation) {
          kind = 'calculated'
          calculatedDays += 1
          classification = labelClassification(calculation.arrivalClassification)
          completeness = calculation.completeness === 'complete_evidence' ? 'Evidence complete' : 'Incomplete evidence'
          if (calculation.arrivalClassification === 'late') lateDays += 1
          if (calculation.arrivalClassification === 'very_late') veryLateDays += 1
          if (calculation.completeness !== 'complete_evidence') incompleteDays += 1
          const lastOut = organized.map((item) => formatKigaliTime(item.normalizedOutAt)).filter((time): time is string => Boolean(time)).sort().at(-1)
          const outAtOrAfterThreshold = Boolean(lastOut && lastOut >= applicableRule!.overtimeFrom)
          const weekendName = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Kigali', weekday: 'long' }).format(new Date(`${date}T12:00:00Z`))
          if (calculation.weekend && outAtOrAfterThreshold && applicableRule!.weekendOvertimeDays == null) {
            overtime = 'Unverified'
            notes.add('Weekend overtime policy is not configured; this time is not counted as verified overtime.')
          } else {
            const configuredWeekendDay = applicableRule!.weekendOvertimeDays?.includes(weekendName as 'Saturday' | 'Sunday') ?? false
            overtime = calculation.weekend && outAtOrAfterThreshold && !configuredWeekendDay ? 'No' : calculation.overtimeEvidence ? 'Yes' : 'No'
            if (calculation.overtimeEvidence) overtimeDays += 1
          }
        } else {
          kind = calculation ? 'stale' : fingerprint.length ? 'fingerprint_events' : 'organized_evidence'
          completeness = 'Not verified'
          if (calculation) {
            notes.add(hasCorrections ? 'A historical correction is attached; its typed values are not projected into the report, so the saved classification is suppressed.' : !ruleCurrent ? 'Saved calculation uses an outdated or unavailable rule version; classification suppressed.' : !engineCurrent ? 'Saved calculation predates the current attendance engine; classification suppressed.' : 'Saved calculation does not include all source evidence; classification suppressed.')
            exceptions.push({ severity: 'warning', employeeNumber: employee.employeeNumber, employeeName: employee.fullName, date, source: organized[0]?.sourceSheet ?? 'Saved calculation', explanation: notes.values().next().value as string })
          }
          if (fingerprint.length) {
            notes.add('PDF fingerprint records do not establish IN or OUT direction; individual events are retained as evidence.')
            exceptions.push({ severity: 'warning', employeeNumber: employee.employeeNumber, employeeName: employee.fullName, date, source: 'iVMS PDF', explanation: 'Fingerprint events do not establish IN or OUT direction. No arrival or complete-day classification is inferred.' })
          }
          if (organized.length && !calculation) {
            const explanation = !applicableRule
              ? 'Source IN/OUT values exist, but no versioned attendance rules are effective for this date.'
              : applicableRule.timezone !== 'Africa/Kigali'
                ? `Source IN/OUT values exist, but the applicable rule uses ${applicableRule.timezone}, not Africa/Kigali.`
                : 'Source IN/OUT values exist, but there is no current persisted attendance calculation.'
            notes.add(explanation)
            exceptions.push({ severity: 'warning', employeeNumber: employee.employeeNumber, employeeName: employee.fullName, date, source: 'Organized Excel', explanation })
          }
          incompleteDays += 1
          overtime = 'Unverified'
        }
      }
      const uniqueEvidenceReviews = [...new Map(evidenceReviews.map((review) => [review.id, review])).values()]
      if (uniqueEvidenceReviews.length) {
        uniqueEvidenceReviews.forEach((review) => {
          attachedReviewIds.add(review.id)
          notes.add(review.description)
          exceptions.push({ severity: review.severity, employeeNumber: employee.employeeNumber, employeeName: employee.fullName, date, source: sources.find((item) => item.id === review.evidenceId)?.sourceSheet ?? 'Attendance evidence', explanation: review.description })
        })
      }
      return {
        date,
        kind,
        firstRecorded: current && calculation ? formatKigaliTime(calculation.firstRecordedAt) : allTimes[0] ?? null,
        lastRecorded: current && calculation ? formatKigaliTime(calculation.lastRecordedAt) : allTimes.at(-1) ?? null,
        inTimes,
        outTimes,
        sourceInValues: organized.flatMap((item) => item.sourceIn ? [item.sourceIn] : []),
        sourceOutValues: organized.flatMap((item) => item.sourceOut ? [item.sourceOut] : []),
        eventTimes: fingerprint.map((item) => item.timestamp ? formatKigaliTime(item.timestamp) ?? item.sourceTimestampText ?? 'Invalid time' : item.sourceTimestampText ?? 'Invalid time'),
        classification,
        completeness,
        overtime,
        recordCount: sources.length,
        notes: [...notes],
      }
    })
    const rowExceptions = exceptions.filter((item) => item.employeeNumber === employee.employeeNumber)
    return { employee, days, totals: { calculatedDays, evidenceDays, lateDays, veryLateDays, overtimeDays, incompleteDays, noSourceRecordDays, reviewExceptions: rowExceptions.length } }
  })

  for (const review of input.reviews) {
    if (review.status !== 'open' || !relevantImportIds.has(review.importId) || attachedReviewIds.has(review.id) || !review.evidenceId) continue
    const source = evidenceById.get(review.evidenceId)
    if (!source || (source.date && (source.date < input.from || source.date > input.to))) continue
    exceptions.push({ severity: review.severity, employeeNumber: source.employeeNumber, employeeName: source.employeeName, date: source.date, source: input.imports.find((item) => item.id === review.importId)?.filename ?? null, explanation: review.description })
  }
  const employeeById = new Map(input.employees.map((employee) => [employee.id, employee]))
  const calculationById = new Map(input.calculations.map((calculation) => [calculation.id, calculation]))
  for (const correction of input.corrections) {
    const calculation = calculationById.get(correction.calculationId)
    if (!calculation || calculation.date < input.from || calculation.date > input.to) continue
    const employee = employeeById.get(correction.employeeId)
    exceptions.push({ severity: 'warning', employeeNumber: employee?.employeeNumber ?? null, employeeName: employee?.fullName ?? null, date: calculation.date, source: `Correction ${correction.correctionType}`, explanation: `A correction was recorded at ${correction.correctedAt} by profile ${correction.correctedBy}: ${correction.reason}. Corrected values are retained as history but are not applied to a current calculation by this report.` })
  }

  const uniqueRules = new Map<string, ReportRule>()
  for (const day of dates) {
    const rule = ruleFor(day, input.rules)
    if (rule) uniqueRules.set(rule.id, rule)
  }
  return {
    metadata: {
      reportId: input.reportId,
      title: 'Weekly Employee Attendance Report',
      organization: 'MM&RJD',
      generatedAt: input.generatedAt,
      timezone: 'Africa/Kigali',
      periodStart: input.from,
      periodEnd: input.to,
      rosterBasis: 'Employees marked active in the roster at report generation time; historical employment dates are not stored.',
    },
    dates,
    rules: [...uniqueRules.values()],
    imports: input.imports,
    employees: employeeRows,
    exceptions,
    fingerprintEvidence: input.evidence.filter((item) => item.sourceType === 'ivms_pdf_original_records' && (item.date == null || (item.date >= input.from && item.date <= input.to))),
    summary: {
      employeesIncluded: employeeRows.length,
      activeEmployees: employeeRows.length,
      attendanceDaysCalculated: employeeRows.reduce((sum, row) => sum + row.totals.calculatedDays, 0),
      daysWithEvidence: employeeRows.reduce((sum, row) => sum + row.totals.evidenceDays, 0),
      lateDays: employeeRows.reduce((sum, row) => sum + row.totals.lateDays, 0),
      veryLateDays: employeeRows.reduce((sum, row) => sum + row.totals.veryLateDays, 0),
      verifiedOvertimeDays: employeeRows.reduce((sum, row) => sum + row.totals.overtimeDays, 0),
      incompleteDays: employeeRows.reduce((sum, row) => sum + row.totals.incompleteDays, 0),
      reviewExceptions: exceptions.length,
    },
  }
}
