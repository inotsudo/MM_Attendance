import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import ExcelJS from 'exceljs'
import { parseOrganizedExcel } from './excel-parser'
import { parseIvmsPdf, pdfOpenErrorMessage } from './pdf-parser'
import { kigaliIso, parseSourceDateTime } from './time'
import { annotateDuplicates, findIdentityMatches } from './preview'
import type { ParsedAttendanceImport } from './types'
import type { PdfAttendanceRecord, ExcelAttendanceRecord } from './types'

describe('attendance source parsers', () => {
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
