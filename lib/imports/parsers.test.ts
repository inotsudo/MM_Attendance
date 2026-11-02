import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import ExcelJS from 'exceljs'
import { parseOrganizedExcel } from './excel-parser'
import { parseIvmsPageItems, parseIvmsPdf, pdfOpenErrorMessage } from './pdf-parser'
import { kigaliIso, normalizeEmployeeNumber, parseSourceDateTime } from './time'
import { annotateDuplicates, findIdentityMatches, getImportConfirmationBlockers } from './preview'
import type { ParsedAttendanceImport } from './types'
import type { PdfAttendanceRecord, ExcelAttendanceRecord } from './types'

describe('attendance source parsers', () => {
  it('matches iVMS IDs with Excel apostrophe text markers without altering source values', () => {
    expect(normalizeEmployeeNumber("'2")).toBe('2')
    expect(normalizeEmployeeNumber('’002’')).toBe('002')
    expect(normalizeEmployeeNumber('EMP-02')).toBe('EMP-02')
  })

  it('extracts a representative iVMS Original Records event and wrapped checkpoint text', async () => {
    const fixture = new Uint8Array(await readFile(new URL('./__fixtures__/ivms-original-records-sample.pdf', import.meta.url)))
    const result = await parseIvmsPdf(fixture)
    expect(result.records).toHaveLength(2)
    const records = result.records as PdfAttendanceRecord[]
    const record = records[0]
    expect(record.employeeNumber).toBe('2')
    expect(record.employeeName).toBe('Employee Example')
    expect(record.sourcePage).toBe(1)
    expect(record.checkpoint).toContain('Main Entrance')
    expect(record.checkpoint).toContain('Fingerprint')
    expect(record.normalizedTimestamp).toBe('2026-09-14T06:04:51.000Z')
    expect(record.attendanceStatus).toBe('Check-In')
    expect(record.fields).toHaveProperty('temperature')
    expect(records[1].employeeNumber).toBeNull()
    expect(records[1].normalizedTimestamp).toBeNull()
    expect(records[1].warnings.map((warning) => warning.code)).toContain('missing_employee_id')
    expect(records[1].warnings.map((warning) => warning.code)).toContain('missing_timestamp')
  })

  it('reassembles an employee name that wraps across PDF text lines', () => {
    const labels = ['Person ID', 'Name', 'Department', 'Time', 'Attendance Status', 'Attendance Check Point', 'Custom Name', 'Data Source', 'Handling Type', 'Temperature', 'Abnormal']
    const starts = [10, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500]
    const items = labels.map((text, index) => ({ text, x: starts[index], y: 200 }))
    items.push(
      { text: 'EMP-5', x: 12, y: 100 },
      { text: 'A Long Employee', x: 52, y: 100 },
      { text: 'Name', x: 52, y: 90 },
      { text: 'Operations', x: 102, y: 100 },
      { text: '2026-09-14 08:00:00', x: 152, y: 100 },
      { text: 'Check-In', x: 202, y: 100 },
      { text: 'Main Entrance', x: 252, y: 100 },
    )
    const result = parseIvmsPageItems(items, 1, 0)
    expect(result.records).toHaveLength(1)
    expect(result.records[0].employeeName).toBe('A Long Employee Name')
    expect(result.records[0].normalizedTimestamp).toBe('2026-09-14T06:00:00.000Z')
    expect(result.records[0].sourcePage).toBe(1)
  })

  it('joins a name split mid-word and ignores page-continuation text as a record anchor', () => {
    const labels = ['Person ID', 'Name', 'Department', 'Time', 'Attendance Status', 'Attendance Check Point', 'Custom Name', 'Data Source', 'Handling Type', 'Temperature', 'Abnormal']
    const starts = [10, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500]
    const items = labels.map((text, index) => ({ text, x: starts[index], y: 200 }))
    items.push(
      { text: 'EMP-5', x: 12, y: 100 },
      { text: 'DUSABIMANA Ne', x: 52, y: 100 },
      { text: 'po', x: 70, y: 90 },
      { text: '2026-09-14 08:04:51', x: 152, y: 100 },
      { text: 'Fingerprint Reader continuation', x: 252, y: 60 },
    )
    const result = parseIvmsPageItems(items, 1, 0)
    expect(result.records).toHaveLength(1)
    expect(result.records[0].employeeName).toBe('DUSABIMANA Nepo')
    expect(result.records[0].normalizedTimestamp).toBe('2026-09-14T06:04:51.000Z')
  })

  it('rejects non-PDF signatures and reports a valid non-iVMS PDF as unsupported', async () => {
    await expect(parseIvmsPdf(new Uint8Array([1, 2, 3]))).rejects.toThrow('signature')
    const notIvms = new Uint8Array(await readFile(new URL('./__fixtures__/unsupported-sample.pdf', import.meta.url)))
    await expect(parseIvmsPdf(notIvms)).rejects.toThrow('not a supported iVMS')
  })

  it('distinguishes encrypted PDFs from other PDF decoder failures', () => {
    expect(pdfOpenErrorMessage(Object.assign(new Error('Password required'), { name: 'PasswordException' }))).toContain('password-protected or encrypted')
    expect(pdfOpenErrorMessage(Object.assign(new Error('Invalid document'), { name: 'InvalidPDFException' }))).toContain('(InvalidPDFException): Invalid document')
  })

  it('pairs non-conventional date headings with IN and OUT columns and preserves blanks', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Attendance Sheet')
    sheet.getCell('B2').value = 'Month'; sheet.getCell('G2').value = 'July'
    sheet.getCell('L2').value = 'Year'; sheet.getCell('O2').value = 2026
    sheet.getCell('A4').value = 'ID'; sheet.getCell('B4').value = 'Employees Names'
    sheet.getCell('D4').value = new Date(Date.UTC(1900, 8, 14)); sheet.getCell('F4').value = new Date(Date.UTC(1900, 8, 15))
    sheet.getCell('D5').value = 'IN'; sheet.getCell('E5').value = 'OUT'; sheet.getCell('F5').value = 'IN'; sheet.getCell('G5').value = 'OUT'
    sheet.getCell('A6').value = 2; sheet.getCell('B6').value = 'Employee Example'; sheet.getCell('D6').value = '*08:04:51'; sheet.getCell('E6').value = '*17:34:30'
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer())
    const result = await parseOrganizedExcel(bytes)
    const records = result.records as ExcelAttendanceRecord[]
    expect(records).toHaveLength(2)
    expect(records[0].normalizedWorkDate).toBe('2026-09-14')
    expect(records[0].normalizedInAt).toBe('2026-09-14T06:04:51.000Z')
    expect(records[1].normalizedWorkDate).toBe('2026-09-15')
    expect(records[1].sourceIn).toBeNull()
    expect(records[1].sourceOut).toBeNull()
    expect(result.warnings.some((warning) => warning.code === 'month_label_conflict')).toBe(true)
    expect(result.warnings.find((warning) => warning.code === 'month_label_conflict')?.severity).toBe('warning')
    expect(getImportConfirmationBlockers(result).some((warning) => warning.code === 'month_label_conflict')).toBe(false)
  })

  it('blocks ambiguous date headings and flags invalid times without normalizing them', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Attendance Sheet')
    sheet.getCell('A1').value = 'Year'; sheet.getCell('B1').value = 2026
    sheet.getCell('A3').value = 'ID'; sheet.getCell('B3').value = 'Employees Names'; sheet.getCell('D3').value = '09/10/2026'
    sheet.getCell('D4').value = 'IN'; sheet.getCell('E4').value = 'OUT'
    sheet.getCell('A5').value = 'EMP-1'; sheet.getCell('B5').value = 'Test Employee'; sheet.getCell('D5').value = '25:00'; sheet.getCell('E5').value = '*17:30:00'
    const result = await parseOrganizedExcel(new Uint8Array(await workbook.xlsx.writeBuffer()))
    const record = (result.records as ExcelAttendanceRecord[])[0]
    expect(record.normalizedWorkDate).toBeNull()
    expect(record.normalizedInAt).toBeNull()
    expect(record.normalizedOutAt).toBeNull()
    expect(record.warnings.map((warning) => warning.code)).toContain('ambiguous_work_date')
    expect(record.warnings.map((warning) => warning.code)).toContain('invalid_in_time')
    expect(getImportConfirmationBlockers(result).map((warning) => warning.code)).toContain('ambiguous_work_date')
  })

  it('flags duplicate employee rows and preserves each row for review', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Attendance Sheet')
    sheet.getCell('A3').value = 'ID'; sheet.getCell('B3').value = 'Employees Names'; sheet.getCell('D3').value = new Date(Date.UTC(1900, 8, 14))
    sheet.getCell('D4').value = 'IN'; sheet.getCell('E4').value = 'OUT'
    sheet.getCell('A5').value = 'EMP-1'; sheet.getCell('B5').value = 'Test Employee'; sheet.getCell('D5').value = '*08:00:00'
    sheet.getCell('A6').value = 'EMP-1'; sheet.getCell('B6').value = 'Test Employee'; sheet.getCell('D6').value = '*08:05:00'
    const result = await parseOrganizedExcel(new Uint8Array(await workbook.xlsx.writeBuffer()))
    const records = result.records as ExcelAttendanceRecord[]
    expect(records).toHaveLength(2)
    expect(records.map((record) => record.sourceRow)).toEqual([5, 6])
    expect(records.every((record) => record.warnings.some((warning) => warning.code === 'duplicate_employee_id'))).toBe(true)
  })

  it('uses cached Excel formula values and flags formula cells without a cached result', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Attendance Sheet')
    sheet.getCell('A1').value = 'Year'; sheet.getCell('B1').value = 2026
    sheet.getCell('A3').value = 'ID'; sheet.getCell('B3').value = 'Employees Names'; sheet.getCell('D3').value = new Date(Date.UTC(1900, 8, 14))
    sheet.getCell('D4').value = 'IN'; sheet.getCell('E4').value = 'OUT'
    sheet.getCell('A5').value = 'EMP-1'; sheet.getCell('B5').value = 'Test Employee'
    sheet.getCell('D5').value = { formula: 'TIME(8,0,0)', result: 8 / 24 }
    sheet.getCell('E5').value = { formula: 'TIME(17,30,0)' }
    const result = await parseOrganizedExcel(new Uint8Array(await workbook.xlsx.writeBuffer()))
    const record = (result.records as ExcelAttendanceRecord[])[0]
    expect(record.normalizedInAt).toBe('2026-09-14T06:00:00.000Z')
    expect(record.rawValues.in).toBe('=TIME(8,0,0)')
    expect(record.normalizedOutAt).toBeNull()
    expect(record.warnings.map((warning) => warning.code)).toContain('formula_result_missing')
  })

  it('rejects malformed and unsupported workbooks', async () => {
    await expect(parseOrganizedExcel(new Uint8Array([0, 1, 2, 3]))).rejects.toThrow('not a readable Excel workbook')
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Notes').getCell('A1').value = 'not an attendance sheet'
    await expect(parseOrganizedExcel(new Uint8Array(await workbook.xlsx.writeBuffer()))).rejects.toThrow('No supported organized attendance layout')
  })

  it('parses explicit and rejects ambiguous or invalid timestamps using Kigali time', () => {
    expect(parseSourceDateTime('2026-09-14 08:04:51').iso).toBe('2026-09-14T06:04:51.000Z')
    expect(parseSourceDateTime('09/10/2026 08:00:00').ambiguous).toBe(true)
    expect(parseSourceDateTime('2026-02-30 08:00:00').iso).toBeNull()
    expect(kigaliIso(2026, 9, 14, 8, 0)).toBe('2026-09-14T06:00:00.000Z')
  })

  it('flags duplicate events and never promotes a name match over an employee ID mismatch', () => {
    const parsed: ParsedAttendanceImport = {
      sourceType: 'ivms_pdf_original_records',
      warnings: [],
      records: [
        { sourceIndex: 1, sourcePage: 1, sourceRow: 1, identityKey: 'UNKNOWN', employeeNumber: 'UNKNOWN', employeeName: 'Employee Example', department: null, sourceTimestamp: '', normalizedTimestamp: '2026-09-14T06:00:00Z', attendanceStatus: null, checkpoint: null, fields: {}, rawText: '', warnings: [] },
        { sourceIndex: 2, sourcePage: 1, sourceRow: 2, identityKey: 'UNKNOWN', employeeNumber: 'UNKNOWN', employeeName: 'Employee Example', department: null, sourceTimestamp: '', normalizedTimestamp: '2026-09-14T06:00:00Z', attendanceStatus: null, checkpoint: null, fields: {}, rawText: '', warnings: [] },
      ],
    }
    expect(annotateDuplicates(parsed)).toBe(1)
    const matches = findIdentityMatches(parsed, [{ id: 'employee-1', employeeNumber: 'EMP-1', fullName: 'Employee Example' }])
    expect(matches[0].matchStatus).toBe('suggested')
    expect(matches[0].selectedEmployeeId).toBeNull()
  })
})
