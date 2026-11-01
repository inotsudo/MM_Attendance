import { describe, expect, it } from 'vitest'
import { DEFAULT_ATTENDANCE_RULES, processAttendanceEvents, type FingerprintEvent } from './attendance-engine'

const event = (id: string, employeeId: string | null, timestamp: string, employeeName = 'Test Employee'): FingerprintEvent => ({ id, employeeId, employeeName, department: 'Operations', timestamp })
const resultAt = (time: string, date = '2024-10-14') => processAttendanceEvents([{ ...event('in', 'EMP-1', `${date}T${time}:00`), direction: 'IN' }, { ...event('out', 'EMP-1', `${date}T17:30:00`), direction: 'OUT' }])[0]

describe('processAttendanceEvents', () => {
  it.each([
    ['07:59', 'before_start'], ['08:00', 'on_time'], ['08:29', 'on_time'], ['08:30', 'late'], ['09:29', 'late'], ['09:30', 'very_late'], ['10:00', 'very_late'],
  ])('classifies %s as %s', (time, expected) => expect(resultAt(time).arrivalClassification).toBe(expected))

  it('detects overtime from the last event without calculating working duration', () => {
    const result = processAttendanceEvents([{ ...event('in', 'EMP-1', '2024-10-14T08:00:00'), direction: 'IN' }, { ...event('out', 'EMP-1', '2024-10-14T19:30:00'), direction: 'OUT' }])[0]
    expect(result.overtimeEvidence).toBe(true)
    expect(result.lastRecordedEvent).toContain('19:30')
  })

  it('requires explicit Excel IN and OUT values for complete evidence and arrival classification', () => {
    const complete = processAttendanceEvents([
      { ...event('in', 'EMP-1', '2024-10-14T09:30:00'), direction: 'IN' },
      { ...event('out', 'EMP-1', '2024-10-14T17:30:00'), direction: 'OUT' },
    ])[0]
    expect(complete.arrivalClassification).toBe('very_late')
    expect(complete.completeness).toBe('complete_evidence')

    const onlyOut = processAttendanceEvents([{ ...event('out', 'EMP-1', '2024-10-14T17:30:00'), direction: 'OUT' }])[0]
    expect(onlyOut.arrivalClassification).toBe('no_event')
    expect(onlyOut.completeness).toBe('incomplete_evidence')
    expect(onlyOut.reviewIssues.map((item) => item.code)).toContain('missing_in')
  })

  it('does not count weekend overtime without an explicit weekend rule', () => {
    const events = [
      { ...event('in', 'EMP-1', '2024-10-19T08:00:00'), direction: 'IN' as const },
      { ...event('out', 'EMP-1', '2024-10-19T20:00:00'), direction: 'OUT' as const },
    ]
    const unspecified = processAttendanceEvents(events)[0]
    expect(unspecified.overtimeEvidence).toBe(false)
    expect(unspecified.reviewIssues.map((item) => item.code)).toContain('weekend_overtime_policy_unconfigured')
    expect(processAttendanceEvents(events, { ...DEFAULT_ATTENDANCE_RULES, weekendOvertimeDays: ['Saturday'] })[0].overtimeEvidence).toBe(true)
    expect(processAttendanceEvents(events, { ...DEFAULT_ATTENDANCE_RULES, weekendOvertimeDays: [] })[0].overtimeEvidence).toBe(false)
  })

  it('identifies weekend events', () => expect(resultAt('08:00', '2024-10-19').weekend).toBe(true))

  it('does not infer arrival or completeness from direction-unknown events', () => {
    const result = processAttendanceEvents([event('a', 'EMP-1', '2024-10-14T08:00:00'), event('b', 'EMP-1', '2024-10-14T17:30:00')])[0]
    expect(result.arrivalClassification).toBe('no_event')
    expect(result.completeness).toBe('incomplete_evidence')
    expect(result.reviewIssues.map((item) => item.code)).toContain('direction_unknown')
  })

  it('flags a single event as incomplete evidence', () => {
    const result = processAttendanceEvents([event('only', 'EMP-1', '2024-10-14T08:00:00')])[0]
    expect(result.completeness).toBe('incomplete_evidence')
    expect(result.reviewIssues[0].code).toBe('single_event')
  })

  it('returns invalid timestamps for review instead of dropping them', () => {
    const result = processAttendanceEvents([event('bad', 'EMP-1', 'not-a-timestamp')])[0]
    expect(result.reviewIssues[0].code).toBe('invalid_timestamp')
    expect(result.sourceEventIds).toEqual(['bad'])
    expect(result.completeness).toBe('incomplete_evidence')
  })

  it('flags duplicate timestamps and preserves both source IDs', () => {
    const result = processAttendanceEvents([event('a', 'EMP-1', '2024-10-14T08:00:00'), event('b', 'EMP-1', '2024-10-14T08:00:00')])[0]
    expect(result.totalRecordedEvents).toBe(2)
    expect(result.sourceEventIds).toEqual(['a', 'b'])
    expect(result.reviewIssues[0].code).toBe('duplicate_event')
  })

  it('keeps unmatched employees reviewable', () => {
    const result = processAttendanceEvents([event('a', null, '2024-10-14T08:00:00'), event('b', null, '2024-10-14T17:30:00')])[0]
    expect(result.employeeId).toBeNull()
    expect(result.reviewIssues.some((item) => item.code === 'unmatched_employee')).toBe(true)
  })

  it('uses the supplied rule version and thresholds', () => {
    const custom = { ...DEFAULT_ATTENDANCE_RULES, graceUntil: '08:15', version: 7 }
    const result = resultAt('08:20')
    const customResult = processAttendanceEvents([{ ...event('in', 'EMP-1', '2024-10-14T08:20:00'), direction: 'IN' }, { ...event('out', 'EMP-1', '2024-10-14T17:30:00'), direction: 'OUT' }], custom)[0]
    expect(result.arrivalClassification).toBe('on_time')
    expect(customResult.arrivalClassification).toBe('late')
    expect(customResult.rulesVersion).toBe(7)
  })
})
