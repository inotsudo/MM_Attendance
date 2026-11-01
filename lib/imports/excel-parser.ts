import 'server-only'

import ExcelJS from 'exceljs'
import { kigaliIso, normalizeEmployeeName, normalizeEmployeeNumber } from './time'
import type { ExcelAttendanceRecord, ImportWarning, ParsedAttendanceImport } from './types'

type CellPrimitive = string | number | boolean | null

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

function textValue(value: ExcelJS.CellValue): string | null {
  const cached = cachedValue(value)
  if (cached == null) return null
  if (cached instanceof Date) return cached.toISOString()
  return String(cached).trim() || null
}

function dateParts(value: ExcelJS.CellValue): { year: number | null; month: number; day: number } | null {
  const cached = cachedValue(value)
  if (cached instanceof Date) {
    return { year: cached.getUTCFullYear() === 1900 ? null : cached.getUTCFullYear(), month: cached.getUTCMonth() + 1, day: cached.getUTCDate() }
  }
  if (typeof cached === 'number') {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(cached) * 86_400_000)
    return { year: date.getUTCFullYear() === 1900 ? null : date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
  }
  if (typeof cached === 'string') {
    const match = cached.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/)
    if (match) return { year: +match[1] === 1900 ? null : +match[1], month: +match[2], day: +match[3] }
    const monthDay = cached.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?$/)
    if (monthDay) return { year: monthDay[3] ? +monthDay[3] : null, month: +monthDay[1], day: +monthDay[2] }
  }
  return null
}

function clockParts(value: ExcelJS.CellValue): { hour: number; minute: number; second: number } | null {
  const cached = cachedValue(value)
  if (cached == null || cached === '') return null
  if (cached instanceof Date) return { hour: cached.getUTCHours(), minute: cached.getUTCMinutes(), second: cached.getUTCSeconds() }
  if (typeof cached === 'number') {
    const seconds = Math.round((cached % 1) * 86_400)
    return { hour: Math.floor(seconds / 3600) % 24, minute: Math.floor((seconds % 3600) / 60), second: seconds % 60 }
  }
  const match = String(cached).trim().replace(/^\*+/, '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  return match ? { hour: +match[1], minute: +match[2], second: +(match[3] ?? 0) } : null
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
  inValue: ExcelJS.CellValue
  outValue: ExcelJS.CellValue
  resolvedDate: { year: number | null; month: number; day: number } | null
  warnings: ImportWarning[]
}): ExcelAttendanceRecord {
  const employeeNumber = textValue(args.idValue)
  const employeeName = textValue(args.nameValue)
  const sourceDate = textValue(args.headingValue) ?? ''
  const sourceIn = textValue(args.inValue)
  const sourceOut = textValue(args.outValue)
  const date = args.resolvedDate
  const workDate = date?.year ? `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}` : null
  const inClock = clockParts(args.inValue)
  const outClock = clockParts(args.outValue)
  const normalizedInAt = workDate && inClock ? kigaliIso(date!.year!, date!.month, date!.day, inClock.hour, inClock.minute, inClock.second) : null
  const normalizedOutAt = workDate && outClock ? kigaliIso(date!.year!, date!.month, date!.day, outClock.hour, outClock.minute, outClock.second) : null
  const recordWarnings = [...args.warnings]
  if (!employeeNumber) recordWarnings.push({ code: 'missing_employee_id', severity: 'warning', message: 'Employee ID is blank; this entry needs explicit identity review.', sourceIndex: args.sourceIndex, sheet: args.sheet, row: args.row })
  if (!employeeName) recordWarnings.push({ code: 'missing_employee_name', severity: 'warning', message: 'Employee name is blank.', sourceIndex: args.sourceIndex, sheet: args.sheet, row: args.row })
  if (!date?.year) recordWarnings.push({ code: 'ambiguous_work_date', severity: 'error', message: 'The date heading has no reliable year; this entry was preserved without a normalized date.', sourceIndex: args.sourceIndex, sheet: args.sheet, row: args.row })
  if (sourceIn && !inClock) recordWarnings.push({ code: 'invalid_in_time', severity: 'error', message: 'The IN cell contains a value that could not be interpreted as a time.', sourceIndex: args.sourceIndex, sheet: args.sheet, row: args.row })
  if (sourceOut && !outClock) recordWarnings.push({ code: 'invalid_out_time', severity: 'error', message: 'The OUT cell contains a value that could not be interpreted as a time.', sourceIndex: args.sourceIndex, sheet: args.sheet, row: args.row })
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
    const dateColumns: Array<{ column: number; date: { year: number | null; month: number; day: number } }> = []
    let currentDate: { year: number | null; month: number; day: number } | null = null
    for (let column = 1; column <= sheet.columnCount; column++) {
      const date = dateParts(header.getCell(column).value)
      if (date) currentDate = date
      const direction = label(directions.getCell(column).value)
      if (!currentDate || !['in', 'out'].includes(direction)) continue
      dateColumns.push({ column, date: currentDate })
    }
    const days = new Map<string, { date: { year: number | null; month: number; day: number }; inColumn?: number; outColumn?: number }>()
    for (const entry of dateColumns) {
      const key = `${entry.date.year ?? 'unknown'}-${entry.date.month}-${entry.date.day}`
      const day = days.get(key) ?? { date: entry.date }
      const direction = label(directions.getCell(entry.column).value)
      if (direction === 'in') day.inColumn = entry.column
      else day.outColumn = entry.column
      days.set(key, day)
    }
    if (days.size === 0) continue

    let dataStart = headerRow + 2
    for (const day of days.values()) {
      if (!day.date.year && meta.year) day.date.year = meta.year
      if (meta.month && meta.month !== day.date.month) {
        warnings.push({ code: 'month_label_conflict', severity: 'warning', message: `The month label on worksheet “${sheet.name}” conflicts with the actual date headings; dates follow the headings.`, sheet: sheet.name })
        break
      }
    }
    for (let rowNumber = dataStart; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber)
      const idValue = row.getCell(idColumn).value
      const nameValue = row.getCell(nameColumn).value
      const employeeNumber = textValue(idValue)
      const employeeName = textValue(nameValue)
      const hasAttendanceValues = [...days.values()].some((day) => Boolean((day.inColumn && row.getCell(day.inColumn).value != null) || (day.outColumn && row.getCell(day.outColumn).value != null)))
      if (!employeeNumber && !employeeName && !hasAttendanceValues) continue
      if (!employeeNumber && !employeeName && hasAttendanceValues) {
        warnings.push({ code: 'unidentified_excel_row', severity: 'warning', message: 'A row contains attendance values but no employee ID or name; its values were not discarded.', sheet: sheet.name, row: rowNumber })
      }
      for (const day of days.values()) {
        sourceIndex += 1
        const column = day.inColumn ?? day.outColumn ?? 1
        const heading = header.getCell(column).value
        const headingDate = dateParts(heading) ?? day.date
        const resolvedDate = { ...headingDate, year: headingDate.year ?? meta.year }
        const actualDate = resolvedDate.year ? kigaliIso(resolvedDate.year, resolvedDate.month, resolvedDate.day, 0, 0) : null
        const sourceHeading = heading ?? `${resolvedDate.month}/${resolvedDate.day}/${resolvedDate.year ?? ''}`
        const recordWarnings: ImportWarning[] = []
        if (!actualDate) recordWarnings.push({ code: 'date_year_missing', severity: 'error', message: 'No reliable year was found in the date heading or workbook metadata.', sourceIndex, sheet: sheet.name, row: rowNumber })
        records.push(makeRecord({
          sourceIndex,
          sheet: sheet.name,
          row: rowNumber,
          column,
          idValue,
          nameValue,
          departmentValue: null,
          headingValue: sourceHeading as ExcelJS.CellValue,
          inValue: day.inColumn ? row.getCell(day.inColumn).value : null,
          outValue: day.outColumn ? row.getCell(day.outColumn).value : null,
          resolvedDate: resolvedDate.year ? resolvedDate : null,
          warnings: recordWarnings,
        }))
      }
    }
  }
  if (!records.length) throw new Error('No supported organized attendance layout was found. Expected an employee ID/name row, date headings, and IN/OUT columns.')
  return { sourceType: 'organized_excel', records, warnings }
}
