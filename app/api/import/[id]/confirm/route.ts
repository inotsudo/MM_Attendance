import { NextResponse } from 'next/server'
import { processAttendanceEvents, type AttendanceRules, type FingerprintEvent } from '@/lib/attendance-engine'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { annotateDuplicates, findIdentityMatches } from '@/lib/imports/preview'
import { downloadImport, parseStoredImport } from '@/lib/imports/storage'
import { normalizeEmployeeName, normalizeEmployeeNumber } from '@/lib/imports/time'
import type { EmployeeOption, ImportWarning } from '@/lib/imports/types'
import type { Json } from '@/lib/database.types'

export const runtime = 'nodejs'
export const maxDuration = 60

type RuleRow = {
  id: string
  version: number
  attendance_timezone: string
  effective_from: string
  normal_start: string
  grace_until: string
  very_late_from: string
  scheduled_end: string
  overtime_from: string
  policy: Json
}

function issue(code: string, message: string, sourceIndex?: number, severity: 'info' | 'warning' | 'error' = 'warning') {
  return { code, message, severity, ...(sourceIndex ? { sourceIndex } : {}), evidence: {} }
}

function toRules(row: RuleRow): AttendanceRules {
  const policy = row.policy && typeof row.policy === 'object' && !Array.isArray(row.policy) ? row.policy : null
  const weekendOvertimeDays = policy && Array.isArray(policy.weekendOvertimeDays)
    ? policy.weekendOvertimeDays.every((day) => day === 'Saturday' || day === 'Sunday') ? policy.weekendOvertimeDays as Array<'Saturday' | 'Sunday'> : null
    : null
  return {
    normalStart: row.normal_start,
    graceUntil: row.grace_until,
    veryLateFrom: row.very_late_from,
    scheduledEnd: row.scheduled_end,
    overtimeFrom: row.overtime_from,
    weekendOvertimeDays,
    version: row.version,
  }
}

function asDateInKigali(timestamp: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const administrator = await getAdministratorProfile()
  if (!administrator) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const { id: importId } = await context.params
  if (!/^[0-9a-f-]{36}$/i.test(importId)) return NextResponse.json({ error: 'The import ID is invalid.' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'The confirmation request is invalid.' }, { status: 400 }) }
  const selectionValue = body && typeof body === 'object' ? (body as Record<string, unknown>).employeeByIdentity : null
  if (!selectionValue || typeof selectionValue !== 'object' || Array.isArray(selectionValue)) {
    return NextResponse.json({ error: 'Review the employee matches before confirming this import.' }, { status: 400 })
  }
  const employeeByIdentity = selectionValue as Record<string, unknown>

  try {
    const { supabase, record, bytes } = await downloadImport(importId)
    if (record.processing_status === 'completed') return NextResponse.json({ alreadyCompleted: true, status: 'completed' })
    if (!['parsed', 'needs_review'].includes(record.processing_status)) return NextResponse.json({ error: 'Preview this file before confirming it.' }, { status: 409 })

    const parsed = await parseStoredImport(record.source_type, bytes)
    const duplicateCount = annotateDuplicates(parsed)
    const { data: employeeRows, error: employeeError } = await supabase
      .from('employees')
      .select('id, employee_number, full_name')
      .eq('is_active', true)
      .order('employee_number')
      .limit(1000)
    if (employeeError) throw new Error('Employee records could not be loaded for confirmation.')
    const employees: EmployeeOption[] = (employeeRows ?? []).map((employee) => ({ id: employee.id, employeeNumber: employee.employee_number, fullName: employee.full_name }))
    const identityMatches = findIdentityMatches(parsed, employees)
    const allowedIdentityKeys = new Set(identityMatches.map((match) => match.identityKey))
    if (Object.keys(employeeByIdentity).some((key) => !allowedIdentityKeys.has(key))) throw new Error('The match review no longer matches this file. Preview the file again.')
    for (const key of allowedIdentityKeys) {
      if (!(key in employeeByIdentity)) throw new Error('Review every employee identity before confirming the import.')
    }
    const selectedIds = Object.values(employeeByIdentity).filter((value): value is string => typeof value === 'string' && value.length > 0)
    if (Object.values(employeeByIdentity).some((value) => value !== null && typeof value !== 'string')) throw new Error('One of the employee selections is invalid.')
    const uniqueIds = [...new Set(selectedIds)]
    const selectedEmployees = uniqueIds.length
      ? await supabase.from('employees').select('id, employee_number, full_name').eq('is_active', true).in('id', uniqueIds)
      : { data: [], error: null }
    if (selectedEmployees.error || (selectedEmployees.data?.length ?? 0) !== uniqueIds.length) throw new Error('A selected employee is no longer active or available. Preview the file and review matches again.')

    const employeesById = new Map((selectedEmployees.data ?? []).map((employee) => [employee.id, employee]))
    const matchPayload = identityMatches.map((match) => {
      const selectedId = employeeByIdentity[match.identityKey] as string | null
      if (!selectedId) return { employeeId: null, method: null, note: 'Administrator left this source identity unmatched.' }
      const employee = employeesById.get(selectedId)!
      const idMatches = normalizeEmployeeNumber(employee.employee_number) === normalizeEmployeeNumber(match.sourceEmployeeNumber)
      const nameMatches = !match.sourceEmployeeName || normalizeEmployeeName(employee.full_name) === normalizeEmployeeName(match.sourceEmployeeName)
      return {
        employeeId: selectedId,
        method: idMatches && nameMatches ? 'employee_number' : 'manual',
        note: idMatches && nameMatches ? 'Exact employee ID match confirmed.' : 'Administrator explicitly confirmed this employee identity.',
      }
    })
    const matchIndex = new Map(identityMatches.map((match, index) => [match.identityKey, index]))
    const recordMatchPayload = parsed.records.map((sourceRecord) => matchPayload[matchIndex.get(sourceRecord.identityKey)!])

    const reviewItems: Array<ReturnType<typeof issue>> = []
    for (const warning of parsed.warnings) reviewItems.push(issue(warning.code, warning.message, warning.sourceIndex, warning.severity))
    for (const sourceRecord of parsed.records) {
      for (const warning of sourceRecord.warnings as ImportWarning[]) reviewItems.push(issue(warning.code, warning.message, sourceRecord.sourceIndex, warning.severity))
      const mapped = recordMatchPayload[sourceRecord.sourceIndex - 1]
      if (!mapped?.employeeId) reviewItems.push(issue('unmatched_employee', 'No employee was assigned to this source identity.', sourceRecord.sourceIndex))
      const match = identityMatches[matchIndex.get(sourceRecord.identityKey)!]
      if (match.matchStatus === 'conflict') reviewItems.push(issue('conflicting_employee', 'The source employee ID and name conflict or the source identity appears with conflicting names.', sourceRecord.sourceIndex))
    }
    if (duplicateCount > 0) {
      // The record-level duplicate warnings above are persisted individually.
    }

    const { data: ruleRows, error: rulesError } = await supabase
      .from('attendance_rule_versions')
      .select('id, version, attendance_timezone, effective_from, normal_start, grace_until, very_late_from, scheduled_end, overtime_from, policy')
      .order('effective_from', { ascending: true })
      .limit(1000)
    const rules = (rulesError ? [] : (ruleRows ?? [])) as RuleRow[]
    const eventsByEmployeeDate = new Map<string, { events: FingerprintEvent[]; sourceIndices: Set<number> }>()
    const addEvent = (sourceRecord: (typeof parsed.records)[number], employeeId: string, timestamp: string, sourceStatus: string | null) => {
      const date = asDateInKigali(timestamp)
      const key = `${employeeId}|${date}`
      const group = eventsByEmployeeDate.get(key) ?? { events: [], sourceIndices: new Set<number>() }
      group.events.push({
        id: `source-${sourceRecord.sourceIndex}-${group.events.length}`,
        employeeId,
        employeeName: sourceRecord.employeeName,
        department: sourceRecord.department,
        timestamp,
        sourceStatus,
          direction: sourceStatus === 'IN' || sourceStatus === 'OUT' ? sourceStatus : null,
        sourceRow: sourceRecord.sourceIndex,
      })
      group.sourceIndices.add(sourceRecord.sourceIndex)
      eventsByEmployeeDate.set(key, group)
    }

    parsed.records.forEach((sourceRecord, index) => {
      const selectedId = recordMatchPayload[index]?.employeeId
      if (!selectedId) return
      if ('normalizedTimestamp' in sourceRecord) {
        if (sourceRecord.normalizedTimestamp) addEvent(sourceRecord, selectedId, sourceRecord.normalizedTimestamp, sourceRecord.attendanceStatus)
      } else {
        if (sourceRecord.normalizedInAt) addEvent(sourceRecord, selectedId, sourceRecord.normalizedInAt, 'IN')
        if (sourceRecord.normalizedOutAt) addEvent(sourceRecord, selectedId, sourceRecord.normalizedOutAt, 'OUT')
      }
    })

    const calculations: Array<Record<string, unknown>> = []
    if (record.source_type === 'ivms_pdf_original_records' && eventsByEmployeeDate.size > 0) {
      reviewItems.push(issue('pdf_direction_not_assumed', 'PDF fingerprint events do not reliably identify IN or OUT direction. Original events were retained, but daily attendance was not calculated from inferred first/last events.', undefined, 'warning'))
    }
    for (const [key, group] of eventsByEmployeeDate) {
      if (record.source_type === 'ivms_pdf_original_records') continue
      const [employeeId, attendanceDate] = key.split('|')
      const rule = rules.filter((candidate) => candidate.effective_from <= attendanceDate).at(-1)
      if (!rule || rule.attendance_timezone !== 'Africa/Kigali') {
        reviewItems.push(issue('attendance_rules_unavailable', rule ? 'The applicable rule version does not use Africa/Kigali; no calculation was created.' : `No attendance rule version is effective for ${attendanceDate}; no calculation was created.`, undefined, 'error'))
        continue
      }
      const result = processAttendanceEvents(group.events, toRules(rule))[0]
      if (!result || !result.sourceEventIds.length) continue
      const sourceIndices = [...new Set(result.sourceEventIds.map((eventId) => Number(eventId.match(/^source-(\d+)-/)?.[1])).filter(Number.isInteger))]
      for (const engineIssue of result.reviewIssues) {
        const indices = engineIssue.eventIds.map((eventId) => Number(eventId.match(/^source-(\d+)-/)?.[1])).filter(Number.isInteger)
        for (const sourceIndex of new Set(indices)) reviewItems.push(issue(engineIssue.code, engineIssue.message, sourceIndex))
      }
      calculations.push({
        employeeId,
        attendanceDate,
        rulesVersionId: rule.id,
        firstRecordedAt: result.firstRecordedEvent,
        lastRecordedAt: result.lastRecordedEvent,
        recordedEventCount: result.totalRecordedEvents,
        arrivalClassification: result.arrivalClassification,
        overtimeEvidence: result.overtimeEvidence,
        isWeekend: result.weekend,
        completeness: result.completeness,
        calculationResult: { engineVersion: 2, rulesVersion: rule.version, sourceEventIds: result.sourceEventIds, reviewIssues: result.reviewIssues },
        sourceIndices,
      })
    }
    if (rulesError) reviewItems.push(issue('attendance_rules_unavailable', 'Attendance rules could not be read; source evidence will be saved without calculated results.', undefined, 'error'))
    else if (rules.length === 0 && eventsByEmployeeDate.size > 0) reviewItems.push(issue('attendance_rules_missing', 'No versioned attendance rules are configured; source evidence will be saved without calculated results.', undefined, 'error'))

    const { data: result, error: confirmError } = await supabase.rpc('confirm_attendance_import', {
      p_import_id: importId,
      p_records: parsed.records as unknown as Json,
      p_matches: recordMatchPayload as unknown as Json,
      p_review_items: reviewItems as unknown as Json,
      p_calculations: calculations as unknown as Json,
    })
    if (confirmError) throw new Error(confirmError.message.includes('Could not') ? confirmError.message : 'The import could not be saved atomically. Retry confirmation; no partial evidence was committed.')
    const payload = result as { alreadyCompleted?: boolean; status?: string; recordCount?: number; reviewCount?: number }
    return NextResponse.json({
      alreadyCompleted: Boolean(payload.alreadyCompleted),
      status: payload.status,
      recordCount: payload.recordCount ?? parsed.records.length,
      reviewCount: payload.reviewCount ?? reviewItems.length,
      calculationCount: calculations.length,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The import could not be confirmed.'
    return NextResponse.json({ error: message }, { status: 422 })
  }
}
