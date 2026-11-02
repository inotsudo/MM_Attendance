import 'server-only'

import ExcelJS from 'exceljs'
import { kigaliIso, normalizeEmployeeName, normalizeEmployeeNumber } from './time'
import type { ExcelAttendanceRecord, ImportWarning, ParsedAttendanceImport } from './types'

type CellPrimitive = string | number | boolean | null
type DateParts = { year: number | null; month: number; day: number; ambiguous?: boolean }

function rawValue(value: ExcelJS.CellValue): CellPrimitive {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if ('formula' in value) return `=${value.formula}`
  if ('sharedFormula' in value) return `=${value.sharedFormula}`
  if ('text' in value) return value.text
  if ('error' in value) return `#${value.error}`
  if ('richText' in value) return value.richText.map((part) => part.text).join('')
  return JSON.stringify(value)
}

function cachedValue(value: ExcelJS.CellValue): ExcelJS.CellValue {
  if (value && typeof value === 'object' && 'formula' in value) return value.result ?? null
  if (value && typeof value === 'object' && 'sharedFormula' in value) return value.result ?? null
  return value
}

function formulaResultMissing(value: ExcelJS.CellValue) {
  return Boolean(value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value) && cachedValue(value) == null)
}

function textValue(value: ExcelJS.CellValue): string | null {
  const cached = cachedValue(value)
  if (cached == null) return null
  if (cached instanceof Date) return cached.toISOString()
  return String(cached).trim() || null
}

function dateParts(value: ExcelJS.CellValue): DateParts | null {
  const cached = cachedValue(value)
  if (cached instanceof Date) {
    return { year: cached.getUTCFullYear() === 1900 ? null : cached.getUTCFullYear(), month: cached.getUTCMonth() + 1, day: cached.getUTCDate() }
  }
  if (typeof cached === 'number') {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(cached) * 86_400_000)
    if (Number.isNaN(date.getTime())) return null
    return { year: date.getUTCFullYear() === 1900 ? null : date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
  }
  if (typeof cached === 'string') {
    const match = cached.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/)
    if (match) return { year: +match[1] === 1900 ? null : +match[1], month: +match[2], day: +match[3] }
    const monthDay = cached.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?$/)
    if (monthDay) {
      const first = +monthDay[1]
      const second = +monthDay[2]
      const year = monthDay[3] ? +monthDay[3] : null
      if (first > 12 && second <= 12) return { year, month: second, day: first }
      if (second > 12 && first <= 12) return { year, month: first, day: second }
      if (first <= 12 && second <= 12) return { year, month: first, day: second, ambiguous: true }
    }
  }
  return null
}

function clockParts(value: ExcelJS.CellValue): { hour: number; minute: number; second: number } | null {
  const cached = cachedValue(value)
  if (cached == null || cached === '') return null
  if (cached instanceof Date) return { hour: cached.getUTCHours(), minute: cached.getUTCMinutes(), second: cached.getUTCSeconds() }
  if (typeof cached === 'number') {
    if (cached < 0 || cached >= 1) return null
    const seconds = Math.round((cached % 1) * 86_400)
    return { hour: Math.floor(seconds / 3600) % 24, minute: Math.floor((seconds % 3600) / 60), second: seconds % 60 }
  }
  const match = String(cached).trim().replace(/^\*+/, '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return null
  const parts = { hour: +match[1], minute: +match[2], second: +(match[3] ?? 0) }
  return parts.hour <= 23 && parts.minute <= 59 && parts.second <= 59 ? parts : null
}

function validWorkDate(value: DateParts | null, fallbackYear: number | null) {
  if (!value || value.ambiguous) return false
  const year = value.year ?? fallbackYear
  return Boolean(year && kigaliIso(year, value.month, value.day, 0, 0))
}

function label(value: ExcelJS.CellValue): string {
  return (textValue(value) ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function identityKey(employeeNumber: string | null, employeeName: string | null, sourceIndex: number) {
  return normalizeEmployeeNumber(employeeNumber) ?? `name:${normalizeEmployeeName(employeeName) ?? `record:${sourceIndex}`}`
}

function makeRecord(args: {
  sourceIndex: number
  sheet: string
  row: number
  column: number
  idValue: ExcelJS.CellValue
  nameValue: ExcelJS.CellValue
  departmentValue?: ExcelJS.CellValue
  headingValue: ExcelJS.CellValue
  headingText: string
  inValue: ExcelJS.CellValue
  outValue: ExcelJS.CellValue
  resolvedDate: DateParts | null
  warnings: ImportWarning[]
}): ExcelAttendanceRecord {
  const employeeNumber = textValue(args.idValue)
  const employeeName = textValue(args.nameValue)
  const sourceDate = args.headingText || textValue(args.headingValue) || ''
  const sourceIn = textValue(args.inValue)
  const sourceOut = textValue(args.outValue)
  const date = args.resolvedDate
  const normalizedDate = validWorkDate(date, date?.year ?? null) ? date : null
  const workDate = normalizedDate?.year ? `${normalizedDate.year}-${String(normalizedDate.month).padStart(2, '0')}-${String(normalizedDate.day).padStart(2, '0')}` : null
  const inClock = clockParts(args.inValue)
  const outClock = clockParts(args.outValue)
  const normalizedInAt = workDate && inClock ? kigaliIso(normalizedDate!.year!, normalizedDate!.month, normalizedDate!.day, inClock.hour, inClock.minute, inClock.second) : null
  const normalizedOutAt = workDate && outClock ? kigaliIso(normalizedDate!.year!, normalizedDate!.month, normalizedDate!.day, outClock.hour, outClock.minute, outClock.second) : null
  const recordWarnings = [...args.warnings]
  if (!employeeNumber) recordWarnings.push({ code: 'missing_employee_id', severity: 'warning', message: 'Employee ID is blank; this entry needs explicit identity review.', sourceIndex: args.sourceIndex, sheet: args.sheet, row: args.row })
  if (!employeeName) recordWarnings.push({ code: 'missing_employee_name', severity: 'warning', message: 'Employee name is blank.', sourceIndex: args.sourceIndex, sheet: args.sheet, row: args.row })
  if (date?.ambiguous) recordWarnings.push({ code: 'ambiguous_work_date', severity: 'error', message: 'The date heading has an ambiguous month/day order; this entry was preserved without a normalized date.', sourceIndex: args.sourceIndex, sheet: args.sheet, row: args.row })
  else if (!workDate) recordWarnings.push({ code: date?.year ? 'invalid_work_date' : 'date_year_missing', severity: 'error', message: date?.year ? 'The date heading is not a valid calendar date; it was preserved without normalization.' : 'No reliable year was found in the date heading or workbook metadata.', sourceIndex: args.sourceIndex, sheet: args.sheet, row: args.row })
  if (sourceIn && !inClock) recordWarnings.push({ code: 'invalid_in_time', severity: 'error', message: 'The IN cell contains a value that could not be interpreted as a valid time.', sourceIndex: args.sourceIndex, sheet: args.sheet, row: args.row })
  if (sourceOut && !outClock) recordWarnings.push({ code: 'invalid_out_time', severity: 'error', message: 'The OUT cell contains a value that could not be interpreted as a valid time.', sourceIndex: args.sourceIndex, sheet: args.sheet, row: args.row })
  if (formulaResultMissing(args.inValue) || formulaResultMissing(args.outValue)) recordWarnings.push({ code: 'formula_result_missing', severity: 'error', message: 'A formula cell has no cached result. Recalculate and save the workbook in a spreadsheet application before importing.', sourceIndex: args.sourceIndex, sheet: args.sheet, row: args.row })
  if (!sourceIn || !sourceOut) recordWarnings.push({ code: 'incomplete_in_out', severity: 'warning', message: 'One or both organized IN/OUT cells are blank; original blanks are preserved.', sourceIndex: args.sourceIndex, sheet: args.sheet, row: args.row })
  return {
    sourceIndex: args.sourceIndex,
    sourceSheet: args.sheet,
    sourceRow: args.row,
    sourceColumn: args.column,
    identityKey: identityKey(employeeNumber, employeeName, args.sourceIndex),
    employeeNumber,
    employeeName,
    department: textValue(args.departmentValue),
    sourceWorkDate: sourceDate,
    normalizedWorkDate: workDate,
    sourceIn,
    normalizedInAt,
    sourceOut,
    normalizedOutAt,
    rawValues: {
      employeeId: rawValue(args.idValue),
      employeeName: rawValue(args.nameValue),
      department: rawValue(args.departmentValue ?? null),
      dateHeading: rawValue(args.headingValue),
      in: rawValue(args.inValue),
      out: rawValue(args.outValue),
    },
    warnings: recordWarnings,
  }
}

function metadata(sheet: ExcelJS.Worksheet) {
  let year: number | null = null
  let month: number | null = null
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 12); rowNumber++) {
    const row = sheet.getRow(rowNumber)
    for (let column = 1; column <= Math.min(sheet.columnCount, 24); column++) {
      const cellLabel = label(row.getCell(column).value)
      if (cellLabel !== 'year' && cellLabel !== 'month') continue
      for (let next = column + 1; next <= Math.min(sheet.columnCount, column + 5); next++) {
        const text = textValue(row.getCell(next).value)
        if (!text) continue
        if (cellLabel === 'year' && /^20\d{2}$/.test(text)) year = Number(text)
        if (cellLabel === 'month') {
          const parsed = Date.parse(`${text} 1, 2000`)
          if (Number.isFinite(parsed)) month = new Date(parsed).getUTCMonth() + 1
        }
        break
      }
    }
  }
  return { year, month }
}

export async function parseOrganizedExcel(bytes: Uint8Array): Promise<ParsedAttendanceImport> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0])
  } catch (error) {
    const message = error instanceof Error && /encrypt|password/i.test(error.message)
      ? 'Encrypted Excel workbooks are not supported.'
      : 'The file is not a readable Excel workbook.'
    throw new Error(message)
  }
  if (workbook.worksheets.length === 0) throw new Error('The workbook contains no worksheets.')

  const records: ExcelAttendanceRecord[] = []
  const warnings: ImportWarning[] = []
  let sourceIndex = 0
  for (const sheet of workbook.worksheets) {
    let headerRow: number | null = null
    let idColumn = 0
    let nameColumn = 0
    for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 30); rowNumber++) {
      const row = sheet.getRow(rowNumber)
      for (let column = 1; column <= sheet.columnCount; column++) {
        const cellLabel = label(row.getCell(column).value)
        if (cellLabel === 'id' || cellLabel === 'employee id' || cellLabel === 'employee number') idColumn = column
        if (cellLabel === 'employees names' || cellLabel === 'employee name' || cellLabel === 'name') nameColumn = column
      }
      if (idColumn && nameColumn) { headerRow = rowNumber; break }
      idColumn = 0
      nameColumn = 0
    }
    if (!headerRow) continue

    const header = sheet.getRow(headerRow)
    const directions = sheet.getRow(headerRow + 1)
    const meta = metadata(sheet)
    const dateColumns: Array<{ column: number; date: DateParts; group: number; heading: ExcelJS.CellValue; headingText: string }> = []
    let currentDate: DateParts | null = null
    let currentHeading: ExcelJS.CellValue = null
    let currentHeadingText = ''
    let currentGroup = 0
    for (let column = 1; column <= sheet.columnCount; column++) {
      const heading = header.getCell(column).value
      const date = dateParts(heading)
      if (date) { currentDate = date; currentHeading = heading; currentHeadingText = header.getCell(column).text || textValue(heading) || ''; currentGroup += 1 }
      const direction = label(directions.getCell(column).value)
      if (!currentDate || !['in', 'out'].includes(direction)) continue
      dateColumns.push({ column, date: currentDate, group: currentGroup, heading: currentHeading, headingText: currentHeadingText })
    }
    const days = new Map<string, { date: DateParts; groups: Map<number, { heading: ExcelJS.CellValue; headingText: string; inColumns: number[]; outColumns: number[] }> }>()
    for (const entry of dateColumns) {
      const key = `${entry.date.year ?? 'unknown'}-${entry.date.month}-${entry.date.day}`
      const day = days.get(key) ?? { date: entry.date, groups: new Map() }
      const group = day.groups.get(entry.group) ?? { heading: entry.heading, headingText: entry.headingText, inColumns: [], outColumns: [] }
      const direction = label(directions.getCell(entry.column).value)
      if (direction === 'in') group.inColumns.push(entry.column)
      else group.outColumns.push(entry.column)
      day.groups.set(entry.group, group)
      days.set(key, day)
    }
    if (days.size === 0) continue

    let dataStart = headerRow + 2
    let hasMonthConflict = false
    let hasYearConflict = false
    let hasDuplicateDate = false
    let hasDuplicateDirection = false
    for (const day of days.values()) {
      if (!day.date.year && meta.year) day.date.year = meta.year
      if (meta.month && meta.month !== day.date.month) hasMonthConflict = true
      if (meta.year && day.date.year && day.date.year !== meta.year) hasYearConflict = true
      if (day.groups.size > 1) hasDuplicateDate = true
      for (const group of day.groups.values()) {
        if (group.inColumns.length > 1 || group.outColumns.length > 1) hasDuplicateDirection = true
      }
    }
    if (hasMonthConflict) warnings.push({ code: 'month_label_conflict', severity: 'warning', message: `Worksheet “${sheet.name}” has a month label that differs from its attendance date headings. Attendance dates are taken from the actual date headings and year, not the month label.`, sheet: sheet.name })
    if (hasYearConflict) warnings.push({ code: 'year_label_conflict', severity: 'error', message: `Worksheet “${sheet.name}” has a year label that conflicts with its actual date headings. Correct the workbook year metadata before confirming this import.`, sheet: sheet.name })
    if (hasDuplicateDate) warnings.push({ code: 'duplicate_date_heading', severity: 'error', message: `Worksheet “${sheet.name}” repeats one or more attendance dates. Review and correct the date columns before confirming this import.`, sheet: sheet.name })
    if (hasDuplicateDirection) warnings.push({ code: 'duplicate_date_direction', severity: 'error', message: `Worksheet “${sheet.name}” contains repeated IN or OUT columns for a date. Correct the layout before confirming this import.`, sheet: sheet.name })
    const daySlots: Array<{ date: DateParts; heading: ExcelJS.CellValue; headingText: string; inColumn?: number; outColumn?: number }> = []
    for (const day of days.values()) {
      for (const group of day.groups.values()) {
        const slotCount = Math.max(group.inColumns.length, group.outColumns.length, 1)
        for (let slot = 0; slot < slotCount; slot++) {
          daySlots.push({ date: day.date, heading: group.heading, headingText: group.headingText, inColumn: group.inColumns[slot], outColumn: group.outColumns[slot] })
        }
      }
    }
    const rowsByEmployeeIdentity = new Map<string, number[]>()
    for (let rowNumber = dataStart; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber)
      const employeeNumber = normalizeEmployeeNumber(textValue(row.getCell(idColumn).value))
      const employeeName = normalizeEmployeeName(textValue(row.getCell(nameColumn).value))
      const identity = employeeNumber ? `id:${employeeNumber}` : employeeName ? `name:${employeeName}` : null
      if (identity) rowsByEmployeeIdentity.set(identity, [...(rowsByEmployeeIdentity.get(identity) ?? []), rowNumber])
    }
    const duplicateEmployeeRows = new Map<number, 'duplicate_employee_id' | 'duplicate_employee_row'>()
    for (const [identity, rowNumbers] of rowsByEmployeeIdentity) {
      if (rowNumbers.length <= 1) continue
      for (const rowNumber of rowNumbers) duplicateEmployeeRows.set(rowNumber, identity.startsWith('id:') ? 'duplicate_employee_id' : 'duplicate_employee_row')
    }

    for (let rowNumber = dataStart; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber)
      const idValue = row.getCell(idColumn).value
      const nameValue = row.getCell(nameColumn).value
      const employeeNumber = textValue(idValue)
      const employeeName = textValue(nameValue)
      const hasAttendanceValues = daySlots.some((day) => Boolean((day.inColumn && row.getCell(day.inColumn).value != null) || (day.outColumn && row.getCell(day.outColumn).value != null)))
      if (!employeeNumber && !employeeName && !hasAttendanceValues) continue
      if (!employeeNumber && !employeeName && hasAttendanceValues) {
        warnings.push({ code: 'unidentified_excel_row', severity: 'warning', message: 'A row contains attendance values but no employee ID or name; its values were not discarded.', sheet: sheet.name, row: rowNumber })
      }
      for (const [dayIndex, day] of daySlots.entries()) {
        sourceIndex += 1
        const column = day.inColumn ?? day.outColumn ?? 1
        const heading = day.heading
        const headingDate = dateParts(heading) ?? day.date
        const resolvedDate = { ...headingDate, year: headingDate.year ?? meta.year }
        const sourceHeading = heading ?? `${resolvedDate.month}/${resolvedDate.day}/${resolvedDate.year ?? ''}`
        const duplicateCode = duplicateEmployeeRows.get(rowNumber)
        const rowWarnings: ImportWarning[] = duplicateCode && dayIndex === 0
          ? [{ code: duplicateCode, severity: 'warning', message: `This employee appears on multiple rows in worksheet “${sheet.name}”; each row is preserved and requires review.`, sourceIndex, sheet: sheet.name, row: rowNumber }]
          : []
        records.push(makeRecord({
          sourceIndex,
          sheet: sheet.name,
          row: rowNumber,
          column,
          idValue,
          nameValue,
          departmentValue: null,
          headingValue: sourceHeading as ExcelJS.CellValue,
          headingText: day.headingText || textValue(sourceHeading as ExcelJS.CellValue) || `${resolvedDate.day}/${resolvedDate.month}/${resolvedDate.year ?? ''}`,
          inValue: day.inColumn ? row.getCell(day.inColumn).value : null,
          outValue: day.outColumn ? row.getCell(day.outColumn).value : null,
          resolvedDate: resolvedDate.year ? resolvedDate : null,
          warnings: rowWarnings,
        }))
      }
    }
  }
  if (!records.length) throw new Error('No supported organized attendance layout was found. Expected an employee ID/name row, date headings, and IN/OUT columns.')
  return { sourceType: 'organized_excel', records, warnings }
}
