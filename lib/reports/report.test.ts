import { mkdir, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
vi.mock('server-only', () => ({}))
import { buildAttendanceReport } from './dataset'
import { createAttendanceWorkbook } from './excel'
import { createAttendancePdf } from './pdf'
import type { BuildAttendanceReportInput } from './dataset'

const authMocks = vi.hoisted(() => ({ getAdministratorProfile: vi.fn(), loadAttendanceReportInput: vi.fn() }))
vi.mock('@/lib/supabase/auth', () => ({ getAdministratorProfile: authMocks.getAdministratorProfile }))
vi.mock('./data', () => ({ loadAttendanceReportInput: authMocks.loadAttendanceReportInput }))

const reportInput: BuildAttendanceReportInput = {
  reportId: 'report-fixture-20261026',
  generatedAt: '2026-11-01T10:00:00.000Z',
  from: '2026-10-26',
  to: '2026-11-01',
  employees: [
    { id: 'emp-1', employeeNumber: 'TEST-001', fullName: 'Alice Example', department: 'Operations' },
    { id: 'emp-2', employeeNumber: 'TEST-002', fullName: 'Bob Example', department: null },
  ],
  rules: [{ id: 'rule-1', version: 4, effectiveFrom: '2026-01-01', normalStart: '08:00', graceUntil: '08:30', veryLateFrom: '09:30', scheduledEnd: '17:30', overtimeFrom: '19:30', timezone: 'Africa/Kigali', weekendOvertimeDays: null }],
  imports: [
    { id: 'import-excel', filename: 'fixture-attendance.xlsx', sourceType: 'organized_excel', uploadedAt: '2026-11-01T08:00:00Z', checksum: 'a'.repeat(64) },
    { id: 'import-pdf', filename: 'fixture-original-records.pdf', sourceType: 'ivms_pdf_original_records', uploadedAt: '2026-11-01T08:10:00Z', checksum: 'b'.repeat(64) },
  ],
  evidence: [
    { id: 'entry-mon-in', importId: 'import-excel', sourceType: 'organized_excel', employeeId: 'emp-1', employeeNumber: 'TEST-001', employeeName: 'Alice Example', department: 'Operations', date: '2026-10-26', timestamp: null, sourceTimestampText: null, sourceIn: '*08:00:00', normalizedInAt: '2026-10-26T06:00:00.000Z', sourceOut: null, normalizedOutAt: null, attendanceStatus: null, checkpoint: null, sourceSheet: 'October', sourcePage: null, sourceRow: 8 },
    { id: 'entry-mon-out', importId: 'import-excel', sourceType: 'organized_excel', employeeId: 'emp-1', employeeNumber: 'TEST-001', employeeName: 'Alice Example', department: 'Operations', date: '2026-10-26', timestamp: null, sourceTimestampText: null, sourceIn: null, normalizedInAt: null, sourceOut: '19:30', normalizedOutAt: '2026-10-26T17:30:00.000Z', attendanceStatus: null, checkpoint: null, sourceSheet: 'October', sourcePage: null, sourceRow: 8 },
    { id: 'entry-tue', importId: 'import-excel', sourceType: 'organized_excel', employeeId: 'emp-1', employeeNumber: 'TEST-001', employeeName: 'Alice Example', department: 'Operations', date: '2026-10-27', timestamp: null, sourceTimestampText: null, sourceIn: '09:30', normalizedInAt: '2026-10-27T07:30:00.000Z', sourceOut: null, normalizedOutAt: null, attendanceStatus: null, checkpoint: null, sourceSheet: 'October', sourcePage: null, sourceRow: 8 },
    { id: 'pdf-wed-1', importId: 'import-pdf', sourceType: 'ivms_pdf_original_records', employeeId: 'emp-1', employeeNumber: 'TEST-001', employeeName: 'Alice Example', department: 'Operations', date: '2026-10-28', timestamp: '2026-10-28T06:00:00.000Z', sourceTimestampText: '2026-10-28 08:00:00', sourceIn: null, normalizedInAt: null, sourceOut: null, normalizedOutAt: null, attendanceStatus: 'Check-In', checkpoint: 'Main entrance', sourceSheet: null, sourcePage: 2, sourceRow: 14 },
    { id: 'pdf-wed-2', importId: 'import-pdf', sourceType: 'ivms_pdf_original_records', employeeId: 'emp-1', employeeNumber: 'TEST-001', employeeName: 'Alice Example', department: 'Operations', date: '2026-10-28', timestamp: '2026-10-28T15:30:00.000Z', sourceTimestampText: '2026-10-28 17:30:00', sourceIn: null, normalizedInAt: null, sourceOut: null, normalizedOutAt: null, attendanceStatus: 'Check-Out', checkpoint: 'Main entrance', sourceSheet: null, sourcePage: 3, sourceRow: 20 },
    { id: 'entry-sat-in', importId: 'import-excel', sourceType: 'organized_excel', employeeId: 'emp-1', employeeNumber: 'TEST-001', employeeName: 'Alice Example', department: 'Operations', date: '2026-10-31', timestamp: null, sourceTimestampText: null, sourceIn: '08:00', normalizedInAt: '2026-10-31T06:00:00.000Z', sourceOut: null, normalizedOutAt: null, attendanceStatus: null, checkpoint: null, sourceSheet: 'October', sourcePage: null, sourceRow: 12 },
    { id: 'entry-sat-out', importId: 'import-excel', sourceType: 'organized_excel', employeeId: 'emp-1', employeeNumber: 'TEST-001', employeeName: 'Alice Example', department: 'Operations', date: '2026-10-31', timestamp: null, sourceTimestampText: null, sourceIn: null, normalizedInAt: null, sourceOut: '20:00', normalizedOutAt: '2026-10-31T18:00:00.000Z', attendanceStatus: null, checkpoint: null, sourceSheet: 'October', sourcePage: null, sourceRow: 12 },
  ],
  calculations: [
    { id: 'calc-mon', employeeId: 'emp-1', date: '2026-10-26', version: 1, rulesVersionId: 'rule-1', firstRecordedAt: '2026-10-26T06:00:00.000Z', lastRecordedAt: '2026-10-26T17:30:00.000Z', recordedEventCount: 2, arrivalClassification: 'on_time', overtimeEvidence: true, weekend: false, completeness: 'complete_evidence', calculatedAt: '2026-11-01T08:20:00Z', engineVersion: 3, evidenceIds: ['entry-mon-in', 'entry-mon-out'], correctionCount: 0 },
    { id: 'calc-tue', employeeId: 'emp-1', date: '2026-10-27', version: 1, rulesVersionId: 'rule-1', firstRecordedAt: '2026-10-27T07:30:00.000Z', lastRecordedAt: '2026-10-27T07:30:00.000Z', recordedEventCount: 1, arrivalClassification: 'very_late', overtimeEvidence: false, weekend: false, completeness: 'incomplete_evidence', calculatedAt: '2026-11-01T08:20:00Z', engineVersion: 3, evidenceIds: ['entry-tue'], correctionCount: 0 },
    { id: 'calc-sat', employeeId: 'emp-1', date: '2026-10-31', version: 1, rulesVersionId: 'rule-1', firstRecordedAt: '2026-10-31T06:00:00.000Z', lastRecordedAt: '2026-10-31T18:00:00.000Z', recordedEventCount: 2, arrivalClassification: 'on_time', overtimeEvidence: false, weekend: true, completeness: 'complete_evidence', calculatedAt: '2026-11-01T08:20:00Z', engineVersion: 3, evidenceIds: ['entry-sat-in', 'entry-sat-out'], correctionCount: 0 },
  ],
  corrections: [],
  reviews: [
    { id: 'review-1', importId: 'import-pdf', evidenceId: 'pdf-wed-1', issueCode: 'pdf_direction_not_assumed', severity: 'warning', description: 'Fingerprint source does not establish direction.', status: 'open' },
    { id: 'review-2', importId: 'import-pdf', evidenceId: 'pdf-wed-2', issueCode: 'duplicate_event', severity: 'warning', description: 'Duplicate source event flagged for inspection.', status: 'open' },
  ],
}

describe('attendance report dataset and actual exports', () => {
  it('preserves the period, roster, incomplete evidence and direction-unknown fingerprint events', () => {
    const report = buildAttendanceReport(reportInput)
    expect(report.dates).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'])
    expect(report.summary.employeesIncluded).toBe(2)
    expect(report.summary.attendanceDaysCalculated).toBe(3)
    expect(report.summary.noSourceRecordDays).toBe(10)
    expect(report.summary.lateDays).toBe(0)
    expect(report.summary.veryLateDays).toBe(1)
    expect(report.summary.verifiedOvertimeDays).toBe(1)
    expect(report.employees[0].days[1].completeness).toBe('Incomplete evidence')
    expect(report.employees[0].days[2].kind).toBe('fingerprint_events')
    expect(report.employees[0].days[2].eventTimes).toEqual(['08:00', '17:30'])
    expect(report.employees[0].days[2].classification).toBe('—')
    expect(report.employees[0].days[5].overtime).toBe('Unverified')
    expect(report.employees[0].days[5].classification).toBe('On time')
    expect(report.employees[1].days).toHaveLength(7)
    expect(report.employees[1].days.every((day) => day.kind === 'no_records')).toBe(true)
    expect(report.employees[1].totals.noSourceRecordDays).toBe(7)
    expect(report.employees[1].days.every((day) => day.classification === '—')).toBe(true)
    expect(report.exceptions.some((item) => item.explanation.includes('not a verified absence'))).toBe(false)
    expect(report.summary.reviewExceptions).toBeGreaterThan(0)
    expect(report.imports.map((item) => item.id)).toContain('import-pdf')
    expect(report.rules.map((rule) => rule.id)).toContain('rule-1')
    expect(report.diagnostics).toMatchObject({ sourceRecordsFound: 7, validSourceRecords: 7, invalidSourceRecords: 0, matchedEmployees: 1, unmatchedRecords: 0, employeesIncluded: 2, calculatedEmployeeDays: 3, incompleteEmployeeDays: 2 })
  })

  it('suppresses stale calculations when rules, engine version or source coverage differ', () => {
    const input = structuredClone(reportInput)
    input.rules[0].id = 'rule-new'
    const report = buildAttendanceReport(input)
    expect(report.employees[0].days[0].kind).toBe('stale')
    expect(report.employees[0].days[0].classification).toBe('—')
    expect(report.exceptions.some((item) => item.explanation.includes('outdated'))).toBe(true)
  })

  it('uses persisted v3 calculations for iVMS noon direction, earliest IN, latest OUT and report colors', async () => {
    const input = structuredClone(reportInput)
    input.calculations.push({ id: 'calc-wed-pdf', employeeId: 'emp-1', date: '2026-10-28', version: 1, rulesVersionId: 'rule-1', firstRecordedAt: '2026-10-28T06:00:00.000Z', lastRecordedAt: '2026-10-28T15:30:00.000Z', recordedEventCount: 2, arrivalClassification: 'on_time', overtimeEvidence: false, weekend: false, completeness: 'complete_evidence', calculatedAt: '2026-11-01T08:20:00Z', engineVersion: 3, evidenceIds: ['pdf-wed-1', 'pdf-wed-2'], correctionCount: 0 })
    const report = buildAttendanceReport(input)
    const day = report.employees[0].days[2]
    expect(day.kind).toBe('calculated')
    expect(day.inTimes).toEqual(['08:00'])
    expect(day.outTimes).toEqual(['17:30'])
    expect(day.classification).toBe('On time')
    expect(day.completeness).toBe('Evidence complete')
    expect(day.outStatus).toBe('normal')

    const bytes = await createAttendanceWorkbook(report)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0])
    const attendance = workbook.getWorksheet('Attendance Sheet')!
    expect(attendance.getCell('F6').text).toBe('*08:00:00')
    expect(attendance.getCell('G6').text).toBe('*17:30:00')
    expect(attendance.getCell('P6').value).toBe(5)
    expect((attendance.getCell('E6').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFF0000')
    expect((attendance.getCell('C6').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF8EE07E')
    expect((attendance.getCell('D6').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFC000')
  })

  it('identifies historical correction actions instead of exporting the old classification as current', () => {
    const input = structuredClone(reportInput)
    input.corrections = [{ id: 'correction-1', calculationId: 'calc-mon', employeeId: 'emp-1', correctedAt: '2026-11-01T09:00:00Z', correctedBy: 'admin-profile-1', reason: 'Manager confirmed a corrected record.', correctionType: 'arrival_time' }]
    const report = buildAttendanceReport(input)
    expect(report.employees[0].days[0].kind).toBe('stale')
    expect(report.employees[0].days[0].classification).toBe('—')
    expect(report.exceptions.some((item) => item.explanation.includes('Manager confirmed'))).toBe(true)
  })

  it('generates a truthful empty-week report without creating blank trailing pages', async () => {
    const input = structuredClone(reportInput)
    input.employees = []
    input.evidence = []
    input.calculations = []
    input.corrections = []
    input.reviews = []
    input.imports = []
    input.rules = []
    const report = buildAttendanceReport(input)
    expect(report.summary.employeesIncluded).toBe(0)
    expect(report.summary.attendanceDaysCalculated).toBe(0)
    const pdf = await getDocument({ data: new Uint8Array(createAttendancePdf(report)) }).promise
    expect(pdf.numPages).toBe(1)
    const page = await pdf.getPage(1)
    const content = await page.getTextContent()
    const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ')
    expect(text).toContain('No source employee records were found')
    expect(text).toContain('Reporting period: 2026-10-26 to 2026-11-01')
  })

  it('creates the manual attendance grid and inspects the generated PDF contents', async () => {
    const report = buildAttendanceReport(reportInput)
    const workbookBytes = await createAttendanceWorkbook(report)
    await writeFile('/tmp/attendance-weekly-report-fixture.xlsx', Buffer.from(workbookBytes))
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(workbookBytes) as unknown as Parameters<typeof workbook.xlsx.load>[0])
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Attendance Sheet'])
    const attendance = workbook.getWorksheet('Attendance Sheet')!
    expect(attendance.getCell('A1').text).toBe('Weekly Employee Attendance Sheet')
    expect(attendance.getCell('A3').text).toContain('Reporting period: 2026-10-26 to 2026-11-01')
    expect(attendance.getCell('A4').text).toBe('Employees Names')
    expect(attendance.getCell('D2').text).toBe('October–November')
    expect(attendance.getCell('L2').text).toBe('2026')
    expect(attendance.getCell('B4').text).toBe('26/Oct')
    expect(attendance.getCell('B4').alignment?.textRotation).toBe(90)
    expect(attendance.getCell('B5').text).toBe('IN')
    expect(attendance.getCell('C5').text).toBe('OUT')
    expect(attendance.getCell('A6').text).toBe('Alice Example')
    expect(attendance.getCell('B6').text).toBe('*08:00:00')
    expect(attendance.getCell('C6').text).toBe('19:30')
    expect(attendance.getCell('D6').text).toBe('09:30')
    expect(attendance.getCell('F6').text).toBe('*08:00:00')
    expect(attendance.getCell('G6').text).toBe('*17:30:00')
    expect(attendance.getCell('P6').value).toBe(5)
    expect((attendance.getCell('C6').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF8EE07E')
    expect((attendance.getCell('D6').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFC000')
    expect((attendance.getCell('E6').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFF0000')
    expect((attendance.getCell('B6').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFFFFF')
    expect((attendance.getCell('F6').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFFFFF')
    expect((attendance.getCell('G6').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFFFFF')
    expect((attendance.getCell('N6').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFD9E2F3')
    expect((attendance.getCell('O6').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFD9E2F3')
    let veryLateLegendRow: ExcelJS.Row | undefined
    attendance.eachRow((row) => { if (row.getCell(2).text === 'very late') veryLateLegendRow = row })
    expect(veryLateLegendRow?.getCell(1)?.fill?.type).toBe('pattern')
    expect(attendance.views[0]).toMatchObject({ state: 'frozen', ySplit: 5, xSplit: 1 })
    expect(attendance.pageSetup.orientation).toBe('landscape')
    expect(attendance.pageSetup.fitToWidth).toBe(1)
    expect(attendance.pageSetup.printArea).toMatch(/^A1:/)

    const pdfBytes = createAttendancePdf(report)
    const pdfPath = '/tmp/attendance-weekly-report-fixture.pdf'
    await mkdir('/tmp', { recursive: true })
    await writeFile(pdfPath, pdfBytes)
    const pdf = await getDocument({ data: new Uint8Array(pdfBytes) }).promise
    expect(pdf.numPages).toBe(1)
    const text: string[] = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      text.push(content.items.map((item) => 'str' in item ? item.str : '').join(' '))
    }
    const extracted = text.join('\n')
    expect(extracted).toContain('Weekly Employee Attendance Report')
    expect(extracted).toContain('2026-10-26 to 2026-11-01')
    expect(extracted).toContain('Alice Example')
    expect(extracted).toContain('Mon 26 Oct')
    expect(extracted).toContain('no of absent')
    expect(extracted).toContain('Late')
    expect(extracted).toContain('Page 1 of')
    expect(extracted).toContain('*08:00:00')
    expect(extracted).toContain('*17:30:00')
    expect(extracted).not.toContain('TEST-999')
  })

  it('shows source identities in the manual grid even when they are not linked to roster employees', async () => {
    const input = structuredClone(reportInput)
    input.employees = []
    input.evidence = input.evidence.filter((item) => item.sourceType === 'ivms_pdf_original_records').map((item) => ({ ...item, employeeId: null }))
    input.calculations = []
    input.corrections = []
    input.reviews = input.reviews.filter((item) => item.importId === 'import-pdf')
    input.imports = input.imports.filter((item) => item.id === 'import-pdf')
    const report = buildAttendanceReport(input)
    const bytes = await createAttendanceWorkbook(report)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0])
    const attendance = workbook.getWorksheet('Attendance Sheet')!
    expect(report.summary.employeesIncluded).toBe(0)
    expect(attendance.getCell('A4').text).toBe('Employees Names')
    expect(attendance.getCell('A6').text).toBe('Alice Example')
    expect(attendance.getCell('F6').text).toBe('*08:00:00')
    expect(attendance.getCell('G6').text).toBe('*17:30:00')
  })

  it('denies unauthenticated report export before querying report data', async () => {
    authMocks.getAdministratorProfile.mockResolvedValueOnce(null)
    authMocks.loadAttendanceReportInput.mockClear()
    const { GET } = await import('../../app/api/reports/weekly/route')
    const response = await GET(new Request('http://localhost/api/reports/weekly?importId=00000000-0000-4000-8000-000000000001&from=2026-10-26&to=2026-11-01&format=pdf'))
    expect(response.status).toBe(401)
    expect(authMocks.loadAttendanceReportInput).not.toHaveBeenCalled()

    authMocks.getAdministratorProfile.mockResolvedValueOnce({ id: 'admin-1' })
    const invalidWeek = await GET(new Request('http://localhost/api/reports/weekly?importId=00000000-0000-4000-8000-000000000001&from=2026-10-27&to=2026-11-02&format=pdf'))
    expect(invalidWeek.status).toBe(400)
    expect(authMocks.loadAttendanceReportInput).not.toHaveBeenCalled()

    authMocks.getAdministratorProfile.mockResolvedValueOnce({ id: 'admin-1' })
    const missingImport = await GET(new Request('http://localhost/api/reports/weekly?from=2026-10-26&to=2026-11-01&format=pdf'))
    expect(missingImport.status).toBe(400)
    expect((await missingImport.json()).error).toContain('Select a processed attendance import')
    expect(authMocks.loadAttendanceReportInput).not.toHaveBeenCalled()
  })

  it('serves Excel report requests as a real XLSX attachment', async () => {
    authMocks.getAdministratorProfile.mockResolvedValueOnce({ id: 'admin-1' })
    authMocks.loadAttendanceReportInput.mockResolvedValueOnce(reportInput)
    const { GET } = await import('../../app/api/reports/weekly/route')
    const response = await GET(new Request('http://localhost/api/reports/weekly?importId=00000000-0000-4000-8000-000000000001&from=2026-10-26&to=2026-11-01&format=xlsx'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(response.headers.get('content-disposition')).toMatch(/\.xlsx"/)
    expect(response.headers.get('X-Report-Source-Records')).toBe('7')
    expect(response.headers.get('X-Report-Employees')).toBe('2')
    expect(authMocks.loadAttendanceReportInput).toHaveBeenCalledWith('2026-10-26', '2026-11-01', '00000000-0000-4000-8000-000000000001', expect.any(String), expect.any(String))
    const bytes = Buffer.from(await response.arrayBuffer())
    expect([...bytes.subarray(0, 2)]).toEqual([0x50, 0x4b])
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0])
    expect(workbook.getWorksheet('Attendance Sheet')?.getCell('A4').text).toBe('Employees Names')
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Attendance Sheet'])
  })

  it('serves PDF report requests as a readable PDF attachment', async () => {
    authMocks.getAdministratorProfile.mockResolvedValueOnce({ id: 'admin-1' })
    authMocks.loadAttendanceReportInput.mockResolvedValueOnce(reportInput)
    const { GET } = await import('../../app/api/reports/weekly/route')
    const response = await GET(new Request('http://localhost/api/reports/weekly?importId=00000000-0000-4000-8000-000000000001&from=2026-10-26&to=2026-11-01&format=pdf'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toMatch(/\.pdf"/)
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toContain('%PDF-1.')
    const pdf = await getDocument({ data: bytes }).promise
    expect(pdf.numPages).toBeGreaterThan(0)
    const page = await pdf.getPage(1)
    const content = await page.getTextContent()
    const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ')
    expect(text).toContain('Weekly Employee Attendance Report')
    expect(text).toContain('Alice Example')
  })
})
