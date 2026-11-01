import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { createImportHistoryWorkbook } from './history-workbook'

describe('Excel import history export', () => {
  it('creates a formatted XLSX import log with only persisted import values', async () => {
    const bytes = await createImportHistoryWorkbook([
      {
        id: 'import-test-1',
        original_filename: 'attendance-original.pdf',
        source_type: 'ivms_pdf_original_records',
        file_type: 'application/pdf',
        file_size_bytes: 133_120,
        uploaded_at: '2026-11-01T15:56:27.561918+00:00',
        processing_status: 'needs_review',
        processing_error: 'PDF source needs administrator review.',
      },
    ], new Date('2026-11-01T16:00:00.000Z'))
    expect(new Uint8Array(bytes).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]))

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0])
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Import History'])
    const sheet = workbook.getWorksheet('Import History')!
    expect(sheet.getCell('A1').text).toContain('MM&RJD | Attendance Import History')
    expect(sheet.getCell('A3').text).toContain('1 original file')
    expect(sheet.getCell('A5').text).toBe('Import ID')
    expect(sheet.getCell('A6').text).toBe('import-test-1')
    expect(sheet.getCell('B6').text).toBe('attendance-original.pdf')
    expect(sheet.getCell('C6').text).toBe('iVMS PDF Original Records')
    expect(sheet.getCell('G6').text).toBe('needs review')
    expect(sheet.getCell('H6').text).toContain('needs administrator review')
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 6, xSplit: 2 })
    expect(sheet.autoFilter).toBeDefined()
    expect(sheet.pageSetup.orientation).toBe('landscape')
    expect(sheet.pageSetup.fitToWidth).toBe(1)
    expect(sheet.pageSetup.printTitlesRow).toBe('1:5')
  })

  it('labels an empty import log without inventing file records', async () => {
    const bytes = await createImportHistoryWorkbook([], new Date('2026-11-01T16:00:00.000Z'))
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0])
    const sheet = workbook.getWorksheet('Import History')!
    expect(sheet.getCell('A3').text).toContain('0 original files')
    expect(sheet.getCell('A6').text).toContain('No attendance source files')
  })
})
