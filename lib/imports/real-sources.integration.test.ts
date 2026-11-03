import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
vi.mock('server-only', () => ({}))
import { parseOrganizedExcel } from './excel-parser'
import { parseIvmsPdf } from './pdf-parser'
import { annotateDuplicates, findIdentityMatches, getImportConfirmationBlockers } from './preview'
import type { ExcelAttendanceRecord, PdfAttendanceRecord } from './types'
import { normalizeEmployeeName, normalizeEmployeeNumber } from './time'
import { DEFAULT_ATTENDANCE_RULES, processAttendanceEvents } from '../attendance-engine'
import { buildAttendanceReport } from '../reports/dataset'
import { createAttendanceWorkbook } from '../reports/excel'
import { POST as prepareAttendanceRoute } from '../../app/api/prepare-attendance/route'

const pdfPath = process.env.ATTENDANCE_TEST_IVMS_PDF
const workbookPath = process.env.ATTENDANCE_TEST_XLSX

describe('optional real attendance source integration fixtures', () => {
  it.skipIf(!pdfPath)('extracts the supplied real iVMS Original Records Report', async () => {
    const result = await parseIvmsPdf(new Uint8Array(await readFile(pdfPath!)))
    const records = result.records as PdfAttendanceRecord[]
    const pages = new Set(records.map((record) => record.sourcePage))
    expect(records.length).toBeGreaterThan(0)
    expect(pages.size).toBeGreaterThan(1)
    expect(records.every((record) => Object.keys(record.fields).length === 11)).toBe(true)
    const uniqueEmployeeIds = new Set(records.flatMap((record) => record.employeeNumber ? [record.employeeNumber] : []))
    const validTimestamps = records.filter((record) => record.normalizedTimestamp !== null).length
    const duplicates = annotateDuplicates(result)
    const flagged = records.filter((record) => record.warnings.length > 0).length
    const warningCounts = Object.fromEntries([...new Set(records.flatMap((record) => record.warnings.map((warning) => warning.code)))].map((code) => [code, records.flatMap((record) => record.warnings).filter((warning) => warning.code === code).length]))
    console.log(`Real iVMS fixture: ${records.length} extracted events across ${pages.size} pages; ${uniqueEmployeeIds.size} distinct source employee IDs; ${validTimestamps} valid timestamps; ${duplicates} duplicate events; ${flagged} events flagged for review; issue counts ${JSON.stringify(warningCounts)}. Persistence is not exercised by this parser-only fixture.`)
  })

  it.skipIf(!workbookPath)('extracts the supplied real organized attendance workbook', async () => {
    const result = await parseOrganizedExcel(new Uint8Array(await readFile(workbookPath!)))
    const records = result.records as ExcelAttendanceRecord[]
    expect(records.length).toBeGreaterThan(0)
    expect(records.some((record) => record.normalizedWorkDate?.startsWith('2026-'))).toBe(true)
    expect(result.warnings.some((warning) => warning.code === 'month_label_conflict')).toBe(true)
    expect(getImportConfirmationBlockers(result).some((warning) => warning.code === 'month_label_conflict')).toBe(false)
    expect(records.some((record) => record.sourceIn === null || record.sourceOut === null)).toBe(true)
    const dates = [...new Set(records.map((record) => record.normalizedWorkDate).filter((date): date is string => Boolean(date)))].sort()
    console.log(`Real XLSX fixture: ${records.length} daily employee rows across ${new Set(records.map((record) => record.sourceSheet)).size} sheets; headings resolve to ${dates[0]} through ${dates.at(-1)}; workbook warnings ${JSON.stringify(result.warnings.map((warning) => warning.code))}.`)
  })

  it.skipIf(!pdfPath || !workbookPath)('checks source identity agreement between the supplied PDF and workbook by employee ID', async () => {
    const pdf = await parseIvmsPdf(new Uint8Array(await readFile(pdfPath!)))
    const workbook = await parseOrganizedExcel(new Uint8Array(await readFile(workbookPath!)))
    const employeesById = new Map<string, { id: string; employeeNumber: string; fullName: string }>()
    for (const row of workbook.records as ExcelAttendanceRecord[]) {
      if (!row.employeeNumber || !row.employeeName) continue
      employeesById.set(row.employeeNumber, { id: row.employeeNumber, employeeNumber: row.employeeNumber, fullName: row.employeeName })
    }
    const matches = findIdentityMatches(pdf, [...employeesById.values()])
    const counts = Object.fromEntries(['matched', 'suggested', 'unmatched', 'conflict'].map((status) => [status, matches.filter((match) => match.matchStatus === status).length]))
    const pdfIds = new Set((pdf.records as PdfAttendanceRecord[]).flatMap((record) => record.employeeNumber ? [record.employeeNumber] : []))
    const sheetIds = new Set((workbook.records as ExcelAttendanceRecord[]).flatMap((record) => record.employeeNumber ? [record.employeeNumber] : []))
    const pdfNamesById = new Map<string, Set<string>>()
    for (const record of pdf.records as PdfAttendanceRecord[]) if (record.employeeNumber && record.employeeName) {
      const key = normalizeEmployeeNumber(record.employeeNumber)!
      pdfNamesById.set(key, new Set([...(pdfNamesById.get(key) ?? []), normalizeEmployeeName(record.employeeName)!]))
    }
    const sheetNamesById = new Map<string, Set<string>>()
    for (const record of workbook.records as ExcelAttendanceRecord[]) if (record.employeeNumber && record.employeeName) {
      const key = normalizeEmployeeNumber(record.employeeNumber)!
      sheetNamesById.set(key, new Set([...(sheetNamesById.get(key) ?? []), normalizeEmployeeName(record.employeeName)!]))
    }
    const stripQuote = (value: string) => value.trim().replace(/^['’]+|['’]+$/g, '').toLocaleUpperCase('en-US')
    const canonicalSheetIds = new Set([...sheetIds].map(stripQuote))
    const matchedAfterQuoteNormalization = [...pdfIds].filter((id) => canonicalSheetIds.has(stripQuote(id))).length
    const quotedPdfIds = [...pdfIds].filter((id) => /^['’]/.test(id)).length
    const conflictingPdfNameIds = [...pdfNamesById.values()].filter((names) => names.size > 1).length
    const matchingIdNameConflicts = [...pdfNamesById].filter(([id, names]) => sheetNamesById.has(id) && ![...names].some((name) => sheetNamesById.get(id)!.has(name))).length
    expect(matches.length).toBeGreaterThan(0)
    expect(matchedAfterQuoteNormalization).toBe(pdfIds.size)
    console.log(`Source-to-source identity comparison by stable ID (not a database roster match): ${matches.length} PDF identities; current matching ${JSON.stringify(counts)}; PDF IDs with a leading quote ${quotedPdfIds}/${pdfIds.size}; exact ID overlap after removing only wrapping quote marks ${matchedAfterQuoteNormalization}/${pdfIds.size}; PDF IDs with inconsistent names ${conflictingPdfNameIds}; IDs present in both files but with no matching name ${matchingIdNameConflicts}.`)
  })

  it.skipIf(!pdfPath)('applies the approved noon rule to every valid identified event in the real iVMS PDF', async () => {
    const parsed = await parseIvmsPdf(new Uint8Array(await readFile(pdfPath!)))
    const records = parsed.records as PdfAttendanceRecord[]
    const events = records.flatMap((record) => record.normalizedTimestamp && record.employeeNumber
      ? [{ id: `pdf-row-${record.sourceIndex}`, employeeId: normalizeEmployeeNumber(record.employeeNumber), employeeName: record.employeeName, department: record.department, timestamp: record.normalizedTimestamp }]
      : [])
    const calculations = processAttendanceEvents(events, DEFAULT_ATTENDANCE_RULES)
    expect(calculations.length).toBeGreaterThan(0)
    expect(calculations.reduce((count, result) => count + result.sourceEventIds.length, 0)).toBe(events.length)
    const completeDays = calculations.filter((result) => result.completeness === 'complete_evidence').length
    const incompleteDays = calculations.filter((result) => result.completeness === 'incomplete_evidence').length
    const lateDays = calculations.filter((result) => result.arrivalClassification === 'late').length
    const veryLateDays = calculations.filter((result) => result.arrivalClassification === 'very_late').length
    const overtimeDays = calculations.filter((result) => result.overtimeEvidence).length
    const unresolvedNoonEvents = calculations.filter((result) => result.reviewIssues.some((issue) => issue.code === 'direction_unknown')).length
    console.log(`Actual iVMS policy simulation only (grouped by source Person ID; not database matching or persistence): ${events.length} valid identified events -> ${calculations.length} employee-days; ${completeDays} with both sides, ${incompleteDays} incomplete, ${lateDays} late, ${veryLateDays} very late, ${overtimeDays} qualifying overtime, ${unresolvedNoonEvents} days with unresolved-noon events.`)
  })

  it.skipIf(!pdfPath)('exports the actual iVMS PDF into the manual attendance-sheet layout', async () => {
    const parsed = await parseIvmsPdf(new Uint8Array(await readFile(pdfPath!)))
    const records = parsed.records as PdfAttendanceRecord[]
    const evidence = records.map((record) => {
      const timestamp = record.normalizedTimestamp
      const date = timestamp ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp)) : null
      return {
        id: `real-pdf-row-${record.sourceIndex}`, importId: 'local-real-pdf', sourceType: 'ivms_pdf_original_records' as const,
        employeeId: null, employeeNumber: record.employeeNumber, employeeName: record.employeeName, department: record.department,
        date, timestamp, sourceTimestampText: record.sourceTimestamp, sourceIn: null, normalizedInAt: null,
        sourceOut: null, normalizedOutAt: null, attendanceStatus: record.attendanceStatus, checkpoint: record.checkpoint,
        sourceSheet: null, sourcePage: record.sourcePage, sourceRow: record.sourceRow,
      }
    })
    const dates = [...new Set(evidence.map((record) => record.date).filter((date): date is string => Boolean(date)))].sort()
    const report = buildAttendanceReport({
      reportId: 'local-real-pdf-export', generatedAt: '2026-11-02T00:00:00.000Z', from: '2026-09-14', to: '2026-09-20',
      employees: [], evidence, calculations: [], corrections: [], reviews: [], rules: [],
      imports: [{ id: 'local-real-pdf', filename: '14-18.pdf', sourceType: 'ivms_pdf_original_records', uploadedAt: '2026-11-02T00:00:00.000Z', checksum: '0'.repeat(64) }],
    })
    const workbook = new ExcelJS.Workbook()
    const workbookBytes = await createAttendanceWorkbook(report)
    await writeFile('/tmp/attendance-actual-manual-sheet.xlsx', Buffer.from(workbookBytes))
    await workbook.xlsx.load(Buffer.from(workbookBytes) as unknown as Parameters<typeof workbook.xlsx.load>[0])
    const sheet = workbook.getWorksheet('Attendance Sheet')!
    expect(report.manualAttendanceRows.length).toBeGreaterThan(0)
    expect(sheet.getCell('A4').text).toBe('Employees Names')
    expect(sheet.getCell('B4').text).toBe('14/Sep')
    expect(sheet.getCell('N4').text).toBe('20/Sep')
    expect(sheet.getCell('B5').text).toBe('IN')
    expect(sheet.getCell('C5').text).toBe('OUT')
    expect(sheet.getColumn(16).values.some((value) => typeof value === 'number')).toBe(true)
    const redCells = report.manualAttendanceRows.reduce((sum, row) => sum + row.absentCount, 0)
    console.log(`Actual iVMS manual-layout export (local source evidence only; no database roster or persistence): ${report.manualAttendanceRows.length} source identity rows for ${report.metadata.periodStart} through ${report.metadata.periodEnd}; ${redCells} red missing-counterpart cells.`)
  })

  it.skipIf(!pdfPath || !workbookPath)('compares PDF-prepared IN/OUT cells with the supplied manual workbook', async () => {
    const timezone = 'Africa/Kigali'
    const pdf = await parseIvmsPdf(new Uint8Array(await readFile(pdfPath!)), timezone)
    const organized = await parseOrganizedExcel(new Uint8Array(await readFile(workbookPath!)), timezone)
    const events = pdf.records as PdfAttendanceRecord[]
    const evidence = events.map((record) => ({
      id: `comparison-${record.sourceIndex}`, importId: 'comparison', sourceType: 'ivms_pdf_original_records' as const,
      employeeId: null, employeeNumber: record.employeeNumber, employeeName: record.employeeName, department: record.department,
      date: record.normalizedTimestamp ? new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(record.normalizedTimestamp)) : null,
      timestamp: record.normalizedTimestamp, sourceTimestampText: record.sourceTimestamp, sourceIn: null, normalizedInAt: null,
      sourceOut: null, normalizedOutAt: null, attendanceStatus: record.attendanceStatus, checkpoint: record.checkpoint,
      sourceSheet: null, sourcePage: record.sourcePage, sourceRow: record.sourceRow,
    }))
    const report = buildAttendanceReport({
      reportId: 'comparison', generatedAt: '2026-11-03T00:00:00.000Z', from: '2026-09-14', to: '2026-09-20', timezone,
      employees: [], evidence, calculations: [], corrections: [], reviews: [], rules: [],
      imports: [{ id: 'comparison', filename: '14-18.pdf', sourceType: 'ivms_pdf_original_records', uploadedAt: '2026-11-03T00:00:00.000Z', checksum: 'temporary' }],
    })
    const clock = (value: string | null) => value ? new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : null
    const sourceByIdentityDay = new Map<string, { ins: Array<{ instant: number; clock: string }>; outs: Array<{ instant: number; clock: string }> }>()
    for (const event of events) {
      const id = normalizeEmployeeNumber(event.employeeNumber)
      if (!id || !event.normalizedTimestamp) continue
      const instant = new Date(event.normalizedTimestamp).getTime()
      const eventClock = clock(event.normalizedTimestamp)!
      const key = `${id}|${new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant))}`
      const group = sourceByIdentityDay.get(key) ?? { ins: [], outs: [] }
      const side = eventClock < '12:00:00' ? group.ins : eventClock > '12:00:00' ? group.outs : null
      side?.push({ instant, clock: eventClock })
      sourceByIdentityDay.set(key, group)
    }
    const sourceDifferences: string[] = []
    for (const employee of report.manualAttendanceRows) {
      const id = normalizeEmployeeNumber(employee.sourceEmployeeNumber)
      if (!id) continue
      for (const day of employee.days) {
        const group = sourceByIdentityDay.get(`${id}|${day.date}`)
        const sourceIn = group?.ins.sort((a, b) => a.instant - b.instant)[0]?.clock ?? null
        const sourceOut = group?.outs.sort((a, b) => a.instant - b.instant).at(-1)?.clock ?? null
        const generatedIn = day.inTime?.replace(/^\*+/, '') ?? null
        const generatedOut = day.outTime?.replace(/^\*+/, '') ?? null
        if (generatedIn !== sourceIn || generatedOut !== sourceOut) sourceDifferences.push(`${id} ${day.date}`)
      }
    }
    const expected = new Map<string, { ins: string[]; outs: string[] }>()
    for (const record of organized.records as ExcelAttendanceRecord[]) {
      if (!record.normalizedWorkDate || !record.employeeNumber) continue
      const key = `${normalizeEmployeeNumber(record.employeeNumber)}|${record.normalizedWorkDate}`
      const day = expected.get(key) ?? { ins: [], outs: [] }
      if (record.normalizedInAt) day.ins.push(record.normalizedInAt)
      if (record.normalizedOutAt) day.outs.push(record.normalizedOutAt)
      expected.set(key, day)
    }
    const differences: string[] = []
    let comparedDays = 0
    for (const employee of report.manualAttendanceRows) {
      const id = normalizeEmployeeNumber(employee.sourceEmployeeNumber)
      if (!id) continue
      for (const day of employee.days) {
        const expectedDay = expected.get(`${id}|${day.date}`)
        if (!expectedDay) continue
        comparedDays++
        const expectedIn = expectedDay.ins.sort().map(clock)[0] ?? null
        const expectedOut = expectedDay.outs.sort().map(clock).at(-1) ?? null
        const actualIn = day.inTime?.replace(/^\*+/, '') ?? null
        const actualOut = day.outTime?.replace(/^\*+/, '') ?? null
        if (actualIn !== expectedIn || actualOut !== expectedOut) differences.push(`${id} ${day.date}: prepared ${actualIn ?? 'blank'}/${actualOut ?? 'blank'}, manual ${expectedIn ?? 'blank'}/${expectedOut ?? 'blank'}`)
      }
    }
    console.log(`Source transformation verification in ${timezone}: ${sourceDifferences.length} mismatches between PDF-derived earliest IN/latest OUT and the generated attendance grid; ${comparedDays} employee-days compared with the supplied manual workbook; ${differences.length} manual workbook time differences, including ${differences.slice(0, 5).join('; ')}.`)
    expect(comparedDays).toBeGreaterThan(0)
    expect(sourceDifferences).toEqual([])
  })

  it.skipIf(!pdfPath)('previews and downloads the public temporary-preparation workflow from the real PDF', async () => {
    const bytes = await readFile(pdfPath!)
    const form = new FormData()
    form.set('file', new File([bytes], '14-18.pdf', { type: 'application/pdf' }))
    form.set('weekStart', '2026-09-14')
    form.set('timezone', 'America/Los_Angeles')
    form.set('mode', 'preview')
    const previewResponse = await prepareAttendanceRoute(new Request('http://localhost/api/prepare-attendance', { method: 'POST', body: form }))
    expect(previewResponse.status).toBe(200)
    const preview = await previewResponse.json()
    expect(preview.summary.sourceRecords).toBe(443)
    expect(preview.summary.employeeIdentities).toBe(58)
    expect(preview.period).toEqual({ from: '2026-09-14', to: '2026-09-20' })
    expect(preview.timezone).toBe('America/Los_Angeles')

    form.set('mode', 'download')
    const downloadResponse = await prepareAttendanceRoute(new Request('http://localhost/api/prepare-attendance', { method: 'POST', body: form }))
    expect(downloadResponse.status).toBe(200)
    expect(downloadResponse.headers.get('content-type')).toContain('spreadsheetml.sheet')
    expect(downloadResponse.headers.get('cache-control')).toContain('no-store')
    const workbook = new ExcelJS.Workbook()
    const outputBytes = Buffer.from(await downloadResponse.arrayBuffer())
    await workbook.xlsx.load(outputBytes as unknown as Parameters<typeof workbook.xlsx.load>[0])
    const sheet = workbook.getWorksheet('Attendance Sheet')!
    expect(sheet.getCell('A1').text).toBe('Weekly Employee Attendance Sheet')
    expect(sheet.getCell('A3').text).toContain('America/Los_Angeles')
    const mugabeRow = sheet.getRows(6, sheet.rowCount - 5)?.find((row) => row.getCell(1).text === 'MUGABE Jules')
    expect(mugabeRow?.getCell(8).text.replace(/^\*+/, '')).toBe('07:47:00')
    expect(mugabeRow?.getCell(9).text.replace(/^\*+/, '')).toBe('17:35:24')
    console.log(`Public route verification: real PDF -> preview (${preview.summary.sourceRecords} events, ${preview.summary.employeeIdentities} identities) -> in-memory XLSX; selected timezone ${preview.timezone}.`)
  })
})
