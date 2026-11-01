import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { parseOrganizedExcel } from './excel-parser'
import { parseIvmsPdf } from './pdf-parser'
import type { ExcelAttendanceRecord, PdfAttendanceRecord } from './types'

const pdfPath = process.env.MMRJD_TEST_IVMS_PDF
const workbookPath = process.env.MMRJD_TEST_ATTENDANCE_XLSX

describe('optional real attendance source integration fixtures', () => {
  it.skipIf(!pdfPath)('extracts the supplied real iVMS Original Records Report', async () => {
    const result = await parseIvmsPdf(new Uint8Array(await readFile(pdfPath!)))
    const records = result.records as PdfAttendanceRecord[]
    const pages = new Set(records.map((record) => record.sourcePage))
    expect(records.length).toBeGreaterThan(0)
    expect(pages.size).toBeGreaterThan(1)
    expect(records.every((record) => Object.keys(record.fields).length === 11)).toBe(true)
    const flagged = records.filter((record) => record.warnings.length > 0).length
    console.log(`Real iVMS fixture: ${records.length} events across ${pages.size} pages; ${flagged} events flagged for review.`)
  })

  it.skipIf(!workbookPath)('extracts the supplied real organized attendance workbook', async () => {
    const result = await parseOrganizedExcel(new Uint8Array(await readFile(workbookPath!)))
    const records = result.records as ExcelAttendanceRecord[]
    expect(records.length).toBeGreaterThan(0)
    expect(records.some((record) => record.normalizedWorkDate?.startsWith('2026-'))).toBe(true)
    expect(result.warnings.some((warning) => warning.code === 'month_label_conflict')).toBe(true)
    expect(records.some((record) => record.sourceIn === null || record.sourceOut === null)).toBe(true)
    console.log(`Real XLSX fixture: ${records.length} daily employee rows across ${new Set(records.map((record) => record.sourceSheet)).size} sheets.`)
  })
})
