import { parseSourceDateTime } from './imports/time'

export const DEFAULT_ATTENDANCE_RULES = {
  normalStart: '08:00',
  graceUntil: '08:30',
  veryLateFrom: '09:30',
  scheduledEnd: '17:30',
  overtimeFrom: '19:30',
  weekendOvertimeDays: null,
  version: 1,
} as const

export type AttendanceRules = {
  normalStart: string
  graceUntil: string
  veryLateFrom: string
  scheduledEnd: string
  overtimeFrom: string
  /** null means weekend overtime has no explicit policy. */
  weekendOvertimeDays?: Array<'Saturday' | 'Sunday'> | null
  version: number
}
export type ArrivalClassification = 'before_start' | 'on_time' | 'late' | 'very_late' | 'no_event'
export type CompletenessClassification = 'complete_evidence' | 'incomplete_evidence' | 'no_events'

export type FingerprintEvent = {
  id: string
  employeeId: string | null
  employeeName: string | null
  department: string | null
  timestamp: string
  sourceStatus?: string | null
  checkpoint?: string | null
  sourceRow?: number | null
  direction?: 'IN' | 'OUT' | null
}

export type ReviewIssue = {
  code: 'invalid_timestamp' | 'unmatched_employee' | 'duplicate_event' | 'single_event' | 'conflicting_employee' | 'missing_in' | 'missing_out' | 'direction_unknown' | 'weekend_overtime_policy_unconfigured'
  message: string
  eventIds: string[]
}

export type DailyAttendanceResult = {
  employeeId: string | null
  employeeName: string | null
  department: string | null
  attendanceDate: string
  firstRecordedEvent: string | null
  lastRecordedEvent: string | null
  totalRecordedEvents: number
  arrivalClassification: ArrivalClassification
  overtimeEvidence: boolean
  weekend: boolean
  completeness: CompletenessClassification
  reviewIssues: ReviewIssue[]
  rulesVersion: number
  sourceEventIds: string[]
}

type ValidEvent = FingerprintEvent & { parsed: Date; date: string }

function minutes(value: string) {
  const [hours, mins] = value.split(':').map(Number)
  return hours * 60 + mins
}

function localMinutes(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

function toDate(value: string) {
  const normalized = parseSourceDateTime(value)
  const parsed = normalized.iso ? new Date(normalized.iso) : new Date(Number.NaN)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function dateKey(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

function weekendDay(date: Date) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Kigali', weekday: 'long' }).format(date)
  return weekday === 'Saturday' || weekday === 'Sunday' ? weekday : null
}

function issue(code: ReviewIssue['code'], message: string, eventIds: string[]): ReviewIssue {
  return { code, message, eventIds }
}

export function processAttendanceEvents(
  events: FingerprintEvent[],
  rules: AttendanceRules = DEFAULT_ATTENDANCE_RULES,
): DailyAttendanceResult[] {
  const invalidByIdentityAndDate = new Map<string, FingerprintEvent[]>()
  const valid: ValidEvent[] = []

  for (const event of events) {
    const parsed = toDate(event.timestamp)
    if (!parsed) {
      const date = /^\d{4}-\d{2}-\d{2}/.test(event.timestamp) ? event.timestamp.slice(0, 10) : 'unknown-date'
      const employeeKey = event.employeeId ?? `unmatched:${event.employeeName ?? 'unknown'}`
      const key = `${employeeKey}|${date}`
      invalidByIdentityAndDate.set(key, [...(invalidByIdentityAndDate.get(key) ?? []), event])
      continue
    }
    valid.push({ ...event, parsed, date: dateKey(parsed) })
  }

  const groups = new Map<string, ValidEvent[]>()
  for (const event of valid) {
    const employeeKey = event.employeeId ?? `unmatched:${event.employeeName ?? 'unknown'}`
    const key = `${employeeKey}|${event.date}`
    groups.set(key, [...(groups.get(key) ?? []), event])
  }

  const results: DailyAttendanceResult[] = []
  for (const [key, grouped] of groups) {
    const sorted = [...grouped].sort((a, b) => a.parsed.getTime() - b.parsed.getTime() || a.id.localeCompare(b.id))
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const reviewIssues: ReviewIssue[] = []
    const duplicateIds = sorted.filter((event, index) => index > 0 && event.parsed.getTime() === sorted[index - 1].parsed.getTime()).map((event) => event.id)
    if (duplicateIds.length) reviewIssues.push(issue('duplicate_event', 'Multiple fingerprint events share the same timestamp.', duplicateIds))
    if (!first.employeeId) reviewIssues.push(issue('unmatched_employee', 'The event could not be matched to an employee.', sorted.map((event) => event.id)))
    const directional = sorted.some((event) => event.direction === 'IN' || event.direction === 'OUT')
    const inEvents = sorted.filter((event) => event.direction === 'IN')
    const outEvents = sorted.filter((event) => event.direction === 'OUT')
    if (directional && inEvents.length === 0) reviewIssues.push(issue('missing_in', 'No explicit IN record was found; arrival cannot be classified.', sorted.map((event) => event.id)))
    if (directional && outEvents.length === 0) reviewIssues.push(issue('missing_out', 'No explicit OUT record was found; the attendance day is incomplete.', sorted.map((event) => event.id)))
    if (!directional && sorted.length === 1) reviewIssues.push(issue('single_event', 'Only one event was recorded; the working day is incomplete evidence.', [first.id]))
    else if (!directional) reviewIssues.push(issue('direction_unknown', 'Source events do not establish IN or OUT direction; arrival and completeness are not classified.', sorted.map((event) => event.id)))

    const arrivalEvent = directional ? inEvents[0] : first
    const firstMinutes = arrivalEvent ? localMinutes(arrivalEvent.parsed) : 0
    const normalStart = minutes(rules.normalStart)
    const graceUntil = minutes(rules.graceUntil)
    const veryLateFrom = minutes(rules.veryLateFrom)
    let arrivalClassification: ArrivalClassification = 'on_time'
    if (!directional || inEvents.length === 0) arrivalClassification = 'no_event'
    else if (firstMinutes < normalStart) arrivalClassification = 'before_start'
    else if (firstMinutes < graceUntil) arrivalClassification = 'on_time'
    else if (firstMinutes < veryLateFrom) arrivalClassification = 'late'
    else arrivalClassification = 'very_late'

    const lastOut = directional ? outEvents.at(-1) : last
    const weekendName = weekendDay(first.parsed)
    const weekend = weekendName !== null
    const weekendAllowed = weekendName ? rules.weekendOvertimeDays?.includes(weekendName) ?? null : false
    const possibleWeekendOvertime = weekend && lastOut && localMinutes(lastOut.parsed) >= minutes(rules.overtimeFrom)
    if (possibleWeekendOvertime && weekendAllowed === null) reviewIssues.push(issue('weekend_overtime_policy_unconfigured', 'A weekend event reached the overtime threshold, but the applicable weekend overtime policy is not configured.', [lastOut.id]))
    const overtimeEvidence = Boolean(lastOut && localMinutes(lastOut.parsed) >= minutes(rules.overtimeFrom) && (!weekend || weekendAllowed === true))
    const completeEvidence = directional && inEvents.length > 0 && outEvents.length > 0

    results.push({
      employeeId: first.employeeId,
      employeeName: first.employeeName,
      department: first.department,
      attendanceDate: first.date,
      firstRecordedEvent: first.timestamp,
      lastRecordedEvent: last.timestamp,
      totalRecordedEvents: sorted.length,
      arrivalClassification,
      overtimeEvidence,
      weekend,
      completeness: completeEvidence ? 'complete_evidence' : 'incomplete_evidence',
      reviewIssues,
      rulesVersion: rules.version,
      sourceEventIds: sorted.map((event) => event.id),
    })
  }

  for (const [key, invalidEvents] of invalidByIdentityAndDate) {
    const [employeeKey, date] = key.split('|')
    const first = invalidEvents[0]
    results.push({ employeeId: first.employeeId, employeeName: first.employeeName, department: first.department, attendanceDate: date, firstRecordedEvent: null, lastRecordedEvent: null, totalRecordedEvents: invalidEvents.length, arrivalClassification: 'no_event', overtimeEvidence: false, weekend: false, completeness: 'incomplete_evidence', reviewIssues: [issue('invalid_timestamp', 'One or more source events have invalid timestamps. They were retained for review.', invalidEvents.map((event) => event.id))], rulesVersion: rules.version, sourceEventIds: invalidEvents.map((event) => event.id) })
  }

  return results.sort((a, b) => a.attendanceDate.localeCompare(b.attendanceDate) || (a.employeeId ?? '').localeCompare(b.employeeId ?? ''))
}

