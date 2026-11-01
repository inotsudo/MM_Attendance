import { normalizeEmployeeName, normalizeEmployeeNumber } from './time'
import type { EmployeeOption, IdentityMatch, ParsedAttendanceImport } from './types'

export function findIdentityMatches(parsed: ParsedAttendanceImport, employees: EmployeeOption[]) {
  const byNumber = new Map(employees.map((employee) => [normalizeEmployeeNumber(employee.employeeNumber), employee]))
  const byName = new Map<string, EmployeeOption[]>()
  for (const employee of employees) {
    const key = normalizeEmployeeName(employee.fullName)
    if (key) byName.set(key, [...(byName.get(key) ?? []), employee])
  }

  const groups = new Map<string, typeof parsed.records>()
  for (const record of parsed.records) groups.set(record.identityKey, [...(groups.get(record.identityKey) ?? []), record])
  const matches: IdentityMatch[] = []
  for (const [identityKey, records] of groups) {
    const first = records[0]
    const number = normalizeEmployeeNumber(first.employeeNumber)
    const name = normalizeEmployeeName(first.employeeName)
    const idEmployee = number ? byNumber.get(number) : undefined
    const names = new Set(records.map((record) => normalizeEmployeeName(record.employeeName)).filter(Boolean))
    const conflictingSourceNames = names.size > 1
    const exactIdNameMatches = Boolean(idEmployee && (!name || normalizeEmployeeName(idEmployee.fullName) === name))
    const nameCandidates = name ? byName.get(name) ?? [] : []
    let matchStatus: IdentityMatch['matchStatus'] = 'unmatched'
    let selectedEmployeeId: string | null = null
    let reason = 'No employee matched this source identity. Review it or keep it unmatched.'
    let candidates: EmployeeOption[] = []

    if (conflictingSourceNames) {
      matchStatus = 'conflict'
      reason = 'The same source employee ID appears with multiple names in this file.'
      candidates = idEmployee ? [idEmployee] : nameCandidates
    } else if (idEmployee && exactIdNameMatches) {
      matchStatus = 'matched'
      selectedEmployeeId = idEmployee.id
      reason = 'Employee ID matches exactly.'
      candidates = [idEmployee]
    } else if (idEmployee) {
      matchStatus = 'conflict'
      reason = 'Employee ID matches, but the source name differs. Confirm the identity explicitly.'
      candidates = [idEmployee, ...nameCandidates.filter((candidate) => candidate.id !== idEmployee.id)]
    } else if (nameCandidates.length) {
      matchStatus = nameCandidates.length === 1 ? 'suggested' : 'conflict'
      reason = number
        ? 'The employee ID does not match an employee. Name matches are suggestions only; confirm explicitly.'
        : 'Name matches are suggestions only; choose an employee explicitly.'
      candidates = nameCandidates
    }

    matches.push({
      identityKey,
      sourceEmployeeNumber: first.employeeNumber,
      sourceEmployeeName: first.employeeName,
      recordCount: records.length,
      matchStatus,
      selectedEmployeeId,
      reason,
      candidates,
    })
  }
  return matches
}

export function annotateDuplicates<T extends { sourceIndex: number; identityKey: string; warnings: Array<{ code: string; severity: 'warning' | 'error'; message: string; sourceIndex?: number }> }>(parsed: ParsedAttendanceImport & { records: T[] }) {
  const seen = new Set<string>()
  let duplicateCount = 0
  for (const record of parsed.records) {
    const source = record as T & Record<string, unknown>
    const stamp = typeof source.normalizedTimestamp === 'string'
      ? source.normalizedTimestamp
      : `${source.normalizedWorkDate ?? ''}|${source.sourceIn ?? ''}|${source.sourceOut ?? ''}`
    const signature = `${record.identityKey}|${stamp}`
    if (!stamp || stamp === '||') continue
    if (seen.has(signature)) {
      duplicateCount += 1
      record.warnings.push({ code: 'duplicate_event', severity: 'warning', message: 'This source record duplicates an earlier identity and timestamp/IN/OUT value.', sourceIndex: record.sourceIndex })
    } else seen.add(signature)
  }
  return duplicateCount
}

export function buildPreviewSummary(parsed: ParsedAttendanceImport, matches: IdentityMatch[], duplicateCount: number) {
  const records = parsed.records
  const dates = records.flatMap((record) => {
    if ('normalizedTimestamp' in record && record.normalizedTimestamp) return [record.normalizedTimestamp.slice(0, 10)]
    if ('normalizedWorkDate' in record && record.normalizedWorkDate) return [record.normalizedWorkDate]
    return []
  }).sort()
  const employeeIds = new Set(records.map((record) => normalizeEmployeeNumber(record.employeeNumber)).filter(Boolean))
  const incomplete = records.filter((record) => record.warnings.length > 0).length
  const warningCount = parsed.warnings.length + records.reduce((sum, record) => sum + record.warnings.length, 0)
  return {
    totalRecords: records.length,
    uniqueEmployeeIdentifiers: employeeIds.size,
    dateRange: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
    duplicateRecords: duplicateCount,
    incompleteRecords: incomplete,
    unmatchedIdentities: matches.filter((match) => match.matchStatus !== 'matched').length,
    warningCount,
  }
}

const confirmationBlockingIssues = new Set([
  'month_label_conflict',
  'year_label_conflict',
  'ambiguous_work_date',
  'invalid_work_date',
  'date_year_missing',
  'duplicate_date_heading',
  'duplicate_date_direction',
])

export function getImportConfirmationBlockers(parsed: ParsedAttendanceImport) {
  return [...parsed.warnings, ...parsed.records.flatMap((record) => record.warnings)]
    .filter((warning) => confirmationBlockingIssues.has(warning.code))
}
