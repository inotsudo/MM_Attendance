import { DEFAULT_ATTENDANCE_RULES, inferFingerprintDirection, type FingerprintEvent } from '../attendance-engine'
import { normalizeEmployeeName, normalizeEmployeeNumber, parseSourceDateTime } from '../imports/time'
import type { AttendanceReport, ManualAttendanceRow, ReportCalculation, ReportCorrection, ReportDayCell, ReportEmployee, ReportEvidence, ReportException, ReportImport, ReportReviewItem, ReportRule } from './types'

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

function formatKigaliClock(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date)
}

function buildManualAttendanceRows(evidence: ReportEvidence[], dates: string[], rules: ReportRule[], employees: ReportEmployee[]): ManualAttendanceRow[] {
  type Candidate = { event: FingerprintEvent; display: string; explicitDirection: 'IN' | 'OUT' | null; validTimestamp: boolean }
  const groups = new Map<string, { employeeNumber: string | null; name: string; nameCounts: Map<string, number>; byDate: Map<string, Candidate[]>; invalidDates: Set<string> }>()
  for (const item of evidence) {
    if (!item.date || !dates.includes(item.date)) continue
    const number = normalizeEmployeeNumber(item.employeeNumber)
    const normalizedName = normalizeEmployeeName(item.employeeName)
    if (!number && !normalizedName) continue
    const identity = number ? `id:${number}` : `name:${normalizedName}`
    const group = groups.get(identity) ?? { employeeNumber: item.employeeNumber, name: '', nameCounts: new Map<string, number>(), byDate: new Map<string, Candidate[]>(), invalidDates: new Set<string>() }
    // Keep the name as supplied by the source. When one ID has minor PDF line
    // wrap variants across its event rows, use the most frequently extracted
    // source spelling (longer source spelling breaks ties); never construct a
    // name from roster data or normalized matching text.
    if (item.employeeName?.trim()) {
      const sourceName = item.employeeName.trim()
      const count = (group.nameCounts.get(sourceName) ?? 0) + 1
      group.nameCounts.set(sourceName, count)
      const selectedCount = group.nameCounts.get(group.name) ?? 0
      if (count > selectedCount || (count === selectedCount && sourceName.length > group.name.length)) group.name = sourceName
    }
    groups.set(identity, group)
    if (!item.date || !dates.includes(item.date)) continue
    const candidates: Candidate[] = []
    if (item.sourceType === 'ivms_pdf_original_records' && item.timestamp) {
      const clock = formatKigaliClock(item.timestamp)
      if (clock) candidates.push({ event: { id: item.id, employeeId: identity, employeeName: item.employeeName, department: item.department, timestamp: item.timestamp }, display: `*${clock}`, explicitDirection: null, validTimestamp: true })
      else group.invalidDates.add(item.date)
    } else if (item.sourceType === 'ivms_pdf_original_records') {
      group.invalidDates.add(item.date)
    } else if (item.sourceType === 'organized_excel') {
      if (item.normalizedInAt || item.sourceIn) {
        const rawClock = item.sourceIn?.replace(/^\*+/, '')
        const parsed = item.normalizedInAt ? { iso: item.normalizedInAt } : parseSourceDateTime(`${item.date} ${rawClock ?? ''}`)
        const timestamp = parsed.iso ?? `${item.date} ${rawClock ?? ''}`
        candidates.push({ event: { id: `${item.id}:in`, employeeId: identity, employeeName: item.employeeName, department: item.department, timestamp, direction: 'IN' }, display: item.sourceIn ?? formatKigaliClock(timestamp) ?? '', explicitDirection: 'IN', validTimestamp: Boolean(parsed.iso) })
      }
      if (item.normalizedOutAt || item.sourceOut) {
        const rawClock = item.sourceOut?.replace(/^\*+/, '')
        const parsed = item.normalizedOutAt ? { iso: item.normalizedOutAt } : parseSourceDateTime(`${item.date} ${rawClock ?? ''}`)
        const timestamp = parsed.iso ?? `${item.date} ${rawClock ?? ''}`
        candidates.push({ event: { id: `${item.id}:out`, employeeId: identity, employeeName: item.employeeName, department: item.department, timestamp, direction: 'OUT' }, display: item.sourceOut ?? formatKigaliClock(timestamp) ?? '', explicitDirection: 'OUT', validTimestamp: Boolean(parsed.iso) })
      }
    }
    if (candidates.length) group.byDate.set(item.date, [...(group.byDate.get(item.date) ?? []), ...candidates])
  }

  // Include the active roster so employees with no events in the selected week
  // still receive a row. Where source events exist, retain their original name.
  for (const employee of employees) {
    const normalizedNumber = normalizeEmployeeNumber(employee.employeeNumber)
    const identity = normalizedNumber ? `id:${normalizedNumber}` : `roster:${employee.id}`
    const group = groups.get(identity)
    if (group) continue
    groups.set(identity, {
      employeeNumber: employee.employeeNumber,
      name: employee.fullName,
      nameCounts: new Map(),
      byDate: new Map(),
      invalidDates: new Set(),
    })
  }

  return [...groups.entries()].map(([identity, group]) => {
    let absentCount = 0
    const dayRows = dates.map((date) => {
      const candidates = group.byDate.get(date) ?? []
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Kigali', weekday: 'long' }).format(new Date(`${date}T12:00:00Z`))
      const isRestDay = weekday === 'Saturday' || weekday === 'Sunday'
      if (!candidates.length) {
        const status = group.invalidDates.has(date) ? 'review' as const : isRestDay ? 'blank' as const : 'absent' as const
        if (status === 'absent') absentCount += 2
        return { date, inTime: null, outTime: null, inStatus: status, outStatus: status, hasEvidence: false }
      }
      const dateRule = rules.filter((rule) => rule.effectiveFrom <= date).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.version - b.version).at(-1)
      const incoming = candidates.filter((candidate) => candidate.explicitDirection === 'IN' || (candidate.explicitDirection === null && inferFingerprintDirection(candidate.event.timestamp) === 'IN')).sort((a, b) => new Date(a.event.timestamp).getTime() - new Date(b.event.timestamp).getTime())
      const outgoing = candidates.filter((candidate) => candidate.explicitDirection === 'OUT' || (candidate.explicitDirection === null && inferFingerprintDirection(candidate.event.timestamp) === 'OUT')).sort((a, b) => new Date(a.event.timestamp).getTime() - new Date(b.event.timestamp).getTime())
      const unresolvedNoon = candidates.some((candidate) => candidate.explicitDirection === null && inferFingerprintDirection(candidate.event.timestamp) === null)
      const inTime = incoming[0]?.display ?? null
      const outTime = outgoing.at(-1)?.display ?? null
      const noSideCanBeAssigned = unresolvedNoon && incoming.length === 0 && outgoing.length === 0
      // The organization has approved these thresholds as its active policy.
      // Use them for the presentation grid when no versioned DB rule is
      // available; a present rule in a different timezone remains unverified.
      const usableRule = !dateRule || dateRule.timezone === 'Africa/Kigali'
      const latestOut = outgoing.at(-1)
      const lastOutClock = latestOut?.validTimestamp ? formatKigaliClock(latestOut.event.timestamp) : null
      const reachedOvertimeThreshold = Boolean(lastOutClock && lastOutClock >= (dateRule?.overtimeFrom ?? DEFAULT_ATTENDANCE_RULES.overtimeFrom))
      const weekendPolicyMissing = isRestDay && reachedOvertimeThreshold && (dateRule?.timezone !== 'Africa/Kigali' || dateRule.weekendOvertimeDays == null)
      const inNeedsReview = noSideCanBeAssigned || Boolean(incoming[0] && !incoming[0].validTimestamp)
      const outNeedsReview = noSideCanBeAssigned || Boolean(outgoing.at(-1) && !outgoing.at(-1)!.validTimestamp) || weekendPolicyMissing
      const arrivalClock = incoming[0]?.validTimestamp ? formatKigaliClock(incoming[0].event.timestamp) : null
      const [arrivalHour, arrivalMinute] = (arrivalClock ?? '').split(':').map(Number)
      const arrivalMinutes = arrivalHour * 60 + arrivalMinute
      const lateFrom = dateRule?.graceUntil ?? DEFAULT_ATTENDANCE_RULES.graceUntil
      const veryLateFrom = dateRule?.veryLateFrom ?? DEFAULT_ATTENDANCE_RULES.veryLateFrom
      const lateMinutes = Number(lateFrom.slice(0, 2)) * 60 + Number(lateFrom.slice(3, 5))
      const veryLateMinutes = Number(veryLateFrom.slice(0, 2)) * 60 + Number(veryLateFrom.slice(3, 5))
      const arrivalStatus = arrivalMinutes >= veryLateMinutes ? 'very_late' : arrivalMinutes >= lateMinutes ? 'late' : 'normal'
      const weekendName = weekday as 'Saturday' | 'Sunday'
      const weekendOvertimeAllowed = dateRule?.weekendOvertimeDays?.includes(weekendName) ?? false
      const overtimeStatus = reachedOvertimeThreshold && (!isRestDay || weekendOvertimeAllowed)
      const inStatus: ManualAttendanceRow['days'][number]['inStatus'] = inNeedsReview ? 'review'
        : isRestDay ? inTime ? 'normal' : 'blank'
          : Boolean(inTime) && !usableRule ? 'review'
            : !inTime ? 'absent'
              : arrivalStatus
      const outStatus: ManualAttendanceRow['days'][number]['outStatus'] = outNeedsReview ? 'review'
        : isRestDay ? !outTime ? 'blank' : overtimeStatus ? 'overtime' : 'normal'
          : Boolean(outTime) && !usableRule ? 'review'
            : !outTime ? 'absent' : overtimeStatus ? 'overtime' : 'normal'
      if (inStatus === 'absent') absentCount++
      if (outStatus === 'absent') absentCount++
      return { date, inTime, outTime, inStatus, outStatus, hasEvidence: true }
    })
    return { sourceEmployeeNumber: group.employeeNumber, employeeName: group.name, days: dayRows, absentCount, identity }
  }).sort((a, b) => {
    const aId = normalizeEmployeeNumber(a.sourceEmployeeNumber) ?? ''
    const bId = normalizeEmployeeNumber(b.sourceEmployeeNumber) ?? ''
    if (aId && bId) return aId.localeCompare(bId, 'en', { numeric: true })
    if (aId) return -1
    if (bId) return 1
    return a.employeeName.localeCompare(b.employeeName)
  }).map(({ identity: _identity, ...row }) => row)
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
    let absentMarks = 0

    const days = dates.map((date) => {
      const key = `${employee.id}|${date}`
      const sources = evidenceByEmployeeDate.get(key) ?? []
      const noSourceRecords = sources.length === 0
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Kigali', weekday: 'long' }).format(new Date(`${date}T12:00:00Z`))
      const isRestDay = weekday === 'Saturday' || weekday === 'Sunday'
      const organized = sources.filter((item) => item.sourceType === 'organized_excel')
      const fingerprint = sources.filter((item) => item.sourceType === 'ivms_pdf_original_records')
      const candidates = (calculationsByEmployeeDate.get(key) ?? []).sort((a, b) => b.version - a.version)
      const calculation = candidates[0]
      const applicableRule = ruleFor(date, input.rules)
      const expectedIds = sources.map((item) => item.id).sort()
      const actualIds = calculation?.evidenceIds.slice().sort() ?? []
      const evidenceComplete = expectedIds.length > 0 && expectedIds.length === actualIds.length && expectedIds.every((id, index) => id === actualIds[index])
      const ruleCurrent = Boolean(applicableRule && calculation?.rulesVersionId === applicableRule.id && applicableRule.timezone === 'Africa/Kigali')
      const engineCurrent = calculation?.engineVersion === 3
      const hasCorrections = Boolean(calculation && (calculation.correctionCount > 0 || input.corrections.some((correction) => correction.calculationId === calculation.id)))
      const current = Boolean(calculation && ruleCurrent && engineCurrent && evidenceComplete && !hasCorrections)
      const allTimes = sources.flatMap((item) => item.sourceType === 'organized_excel'
        ? [item.normalizedInAt, item.normalizedOutAt].map(formatKigaliTime).filter((time): time is string => Boolean(time))
        : item.timestamp ? [formatKigaliTime(item.timestamp)].filter((time): time is string => Boolean(time)) : [])
      const fingerprintTimes = fingerprint.filter((item) => item.timestamp).map((item) => ({ time: formatKigaliTime(item.timestamp)!, instant: new Date(item.timestamp!).getTime() }))
      const hasObservedTime = fingerprintTimes.length > 0 || organized.some((item) => Boolean(item.sourceIn || item.sourceOut))
      const noonOnlyAmbiguity = hasObservedTime && fingerprintTimes.length > 0 && fingerprintTimes.every(({ time }) => time === '12:00') && !organized.length
      const fingerprintIns = fingerprintTimes.filter(({ time }) => time < '12:00').sort((a, b) => a.instant - b.instant)
      const fingerprintOuts = fingerprintTimes.filter(({ time }) => time > '12:00').sort((a, b) => a.instant - b.instant)
      const inTimes = organized.length
        ? organized.flatMap((item) => item.sourceIn ? [formatKigaliTime(item.normalizedInAt) ?? item.sourceIn] : []).sort().slice(0, 1)
        : fingerprintIns.slice(0, 1).map(({ time }) => time)
      const outTimes = organized.length
        ? organized.flatMap((item) => item.sourceOut ? [formatKigaliTime(item.normalizedOutAt) ?? item.sourceOut] : []).sort().slice(-1)
        : fingerprintOuts.slice(-1).map(({ time }) => time)
      const latestOutForThreshold = outTimes.at(-1)?.replace(/^\*/, '') ?? null
      const outAtOrAfterThreshold = Boolean(applicableRule && latestOutForThreshold && latestOutForThreshold >= applicableRule.overtimeFrom)
      const weekendOvertimeUnverified = Boolean(isRestDay && outAtOrAfterThreshold && applicableRule?.weekendOvertimeDays == null)
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
        notes.add('No source records were imported for this day. Missing workday IN/OUT slots are marked absent; Saturday and Sunday are rest days.')
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
          const weekendName = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Kigali', weekday: 'long' }).format(new Date(`${date}T12:00:00Z`))
          if (weekendOvertimeUnverified) {
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
          if (fingerprint.length && fingerprintTimes.some(({ time }) => time === '12:00')) {
            notes.add('A fingerprint at exactly 12:00 cannot be assigned as IN or OUT under the approved noon rule.')
            exceptions.push({ severity: 'warning', employeeNumber: employee.employeeNumber, employeeName: employee.fullName, date, source: 'iVMS PDF', explanation: 'A fingerprint event at exactly 12:00 is retained but cannot be assigned to either side of the noon direction rule.' })
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
      const lateClassification = current && calculation ? calculation.arrivalClassification : null
      const weekendOvertimeAllowed = applicableRule?.weekendOvertimeDays?.includes(weekday as 'Saturday' | 'Sunday') ?? false
      const outIsOvertime = Boolean(current && outTimes[0] && applicableRule && outTimes[0].replace(/^\*/, '') >= applicableRule.overtimeFrom && (!isRestDay || weekendOvertimeAllowed))
      const inStatus: ReportDayCell['inStatus'] = noSourceRecords ? isRestDay ? 'blank' : 'absent'
        : !hasObservedTime ? 'blank'
          : noonOnlyAmbiguity ? 'review'
            : isRestDay ? inTimes.length ? 'normal' : 'blank'
              : !inTimes.length ? 'absent'
                : lateClassification === 'very_late' ? 'very_late' : lateClassification === 'late' ? 'late' : 'normal'
      const outStatus: ReportDayCell['outStatus'] = noSourceRecords ? isRestDay ? 'blank' : 'absent'
        : !hasObservedTime ? 'blank'
          : noonOnlyAmbiguity ? 'review'
            : isRestDay ? !outTimes.length ? 'blank' : weekendOvertimeUnverified ? 'review' : outIsOvertime ? 'overtime' : 'normal'
              : !outTimes.length ? 'absent' : weekendOvertimeUnverified ? 'review' : outIsOvertime ? 'overtime' : 'normal'
      if (inStatus === 'absent') absentMarks++
      if (outStatus === 'absent') absentMarks++
      return {
        date,
        kind,
        firstRecorded: current && calculation ? formatKigaliTime(calculation.firstRecordedAt) : allTimes[0] ?? null,
        lastRecorded: current && calculation ? formatKigaliTime(calculation.lastRecordedAt) : allTimes.at(-1) ?? null,
        inTimes,
        outTimes,
        inStatus,
        outStatus,
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
    return { employee, days, totals: { calculatedDays, evidenceDays, lateDays, veryLateDays, overtimeDays, incompleteDays, noSourceRecordDays, absentMarks, reviewExceptions: rowExceptions.length } }
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
  const manualAttendanceRows = buildManualAttendanceRows(input.evidence, dates, input.rules, input.employees)
  return {
    metadata: {
      reportId: input.reportId,
      title: 'Weekly Employee Attendance Report',
      organization: 'MM&RJD',
      generatedAt: input.generatedAt,
      timezone: 'Africa/Kigali',
      periodStart: input.from,
      periodEnd: input.to,
      rosterBasis: 'Active employee roster at report generation plus source identities; historical employment dates are not stored.',
    },
    dates,
    rules: [...uniqueRules.values()],
    imports: input.imports,
    employees: employeeRows,
    manualAttendanceRows,
    exceptions,
    fingerprintEvidence: input.evidence.filter((item) => item.sourceType === 'ivms_pdf_original_records' && (item.date == null || (item.date >= input.from && item.date <= input.to))),
    summary: {
      employeesIncluded: employeeRows.length,
      attendanceDaysCalculated: employeeRows.reduce((sum, row) => sum + row.totals.calculatedDays, 0),
      daysWithEvidence: employeeRows.reduce((sum, row) => sum + row.totals.evidenceDays, 0),
      noSourceRecordDays: employeeRows.reduce((sum, row) => sum + row.totals.noSourceRecordDays, 0),
      absentMarks: manualAttendanceRows.reduce((sum, row) => sum + row.absentCount, 0),
      lateDays: employeeRows.reduce((sum, row) => sum + row.totals.lateDays, 0),
      veryLateDays: employeeRows.reduce((sum, row) => sum + row.totals.veryLateDays, 0),
      verifiedOvertimeDays: employeeRows.reduce((sum, row) => sum + row.totals.overtimeDays, 0),
      incompleteDays: employeeRows.reduce((sum, row) => sum + row.totals.incompleteDays, 0),
      reviewExceptions: exceptions.length,
    },
    diagnostics: {
      sourceRecordsFound: input.evidence.length,
      validSourceRecords: input.evidence.filter((item) => item.date !== null).length,
      invalidSourceRecords: input.evidence.filter((item) => item.date === null).length,
      matchedEmployees: new Set(input.evidence.flatMap((item) => item.employeeId ? [item.employeeId] : [])).size,
      unmatchedRecords: input.evidence.filter((item) => !item.employeeId).length,
      employeesIncluded: employeeRows.length,
      calculatedEmployeeDays: employeeRows.reduce((sum, row) => sum + row.totals.calculatedDays, 0),
      incompleteEmployeeDays: employeeRows.reduce((sum, row) => sum + row.totals.incompleteDays, 0),
      reviewExceptions: exceptions.length,
    },
  }
}
