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
    { id: 'calc-mon', employeeId: 'emp-1', date: '2026-10-26', version: 1, rulesVersionId: 'rule-1', firstRecordedAt: '2026-10-26T06:00:00.000Z', lastRecordedAt: '2026-10-26T17:30:00.000Z', recordedEventCount: 2, arrivalClassification: 'on_time', overtimeEvidence: true, weekend: false, completeness: 'complete_evidence', calculatedAt: '2026-11-01T08:20:00Z', engineVersion: 2, evidenceIds: ['entry-mon-in', 'entry-mon-out'], correctionCount: 0 },
    { id: 'calc-tue', employeeId: 'emp-1', date: '2026-10-27', version: 1, rulesVersionId: 'rule-1', firstRecordedAt: '2026-10-27T07:30:00.000Z', lastRecordedAt: '2026-10-27T07:30:00.000Z', recordedEventCount: 1, arrivalClassification: 'very_late', overtimeEvidence: false, weekend: false, completeness: 'incomplete_evidence', calculatedAt: '2026-11-01T08:20:00Z', engineVersion: 2, evidenceIds: ['entry-tue'], correctionCount: 0 },
    { id: 'calc-sat', employeeId: 'emp-1', date: '2026-10-31', version: 1, rulesVersionId: 'rule-1', firstRecordedAt: '2026-10-31T06:00:00.000Z', lastRecordedAt: '2026-10-31T18:00:00.000Z', recordedEventCount: 2, arrivalClassification: 'on_time', overtimeEvidence: false, weekend: true, completeness: 'complete_evidence', calculatedAt: '2026-11-01T08:20:00Z', engineVersion: 2, evidenceIds: ['entry-sat-in', 'entry-sat-out'], correctionCount: 0 },
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
  })

  it('suppresses stale calculations when rules, engine version or source coverage differ', () => {
    const input = structuredClone(reportInput)
    input.rules[0].id = 'rule-new'
    const report = buildAttendanceReport(input)
    expect(report.employees[0].days[0].kind).toBe('stale')
    expect(report.employees[0].days[0].classification).toBe('—')
    expect(report.exceptions.some((item) => item.explanation.includes('outdated'))).toBe(true)
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
    expect(text).toContain('No active employees')
    expect(text).toContain('No review exceptions')
  })

  it('opens and inspects the generated Excel workbook and PDF contents', async () => {
    const report = buildAttendanceReport(reportInput)
    const workbookBytes = await createAttendanceWorkbook(report)
    await writeFile('/tmp/mmrjd-weekly-report-fixture.xlsx', Buffer.from(workbookBytes))
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(workbookBytes) as unknown as Parameters<typeof workbook.xlsx.load>[0])
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Weekly Attendance', 'Attendance Summary', 'Review & Exceptions', 'Report Metadata'])
    const weekly = workbook.getWorksheet('Weekly Attendance')!
    expect(weekly.getCell('A1').text).toContain('Weekly Employee Attendance Report')
    expect(weekly.getCell('A2').text).toContain('2026-10-26 to 2026-11-01')
    expect(weekly.getCell('A6').text).toBe('Employee ID')
    expect(weekly.getCell('A8').text).toBe('TEST-001')
    expect(weekly.getCell('D6').text).toContain('Mon 26 Oct')
    expect(weekly.getCell('D7').text).toBe('IN')
    expect(weekly.getCell('E7').text).toBe('OUT')
    expect(weekly.getCell('D8').text).toBe('*08:00:00')
    expect(weekly.getCell('E8').text).toBe('19:30')
    expect(weekly.getCell('G8').text).toBe('09:30')
    expect(weekly.getCell('I8').text).toContain('Very late')
    expect(weekly.getCell('J8').text).toBe('')
    expect(weekly.getCell('K8').text).toBe('')
    expect(weekly.getCell('L8').text).toBe('Direction unknown')
    expect(weekly.getCell('Y8').value).toBe(3)
    expect(weekly.getCell('AB8').value).toBe(1)
    expect(weekly.getCell('T8').text).toBe('20:00')
    expect(weekly.getCell('AF8').value).toBe('Not assessed')
    expect(weekly.views[0]).toMatchObject({ state: 'frozen', ySplit: 7, xSplit: 3 })
    expect(weekly.autoFilter).toBeDefined()
    expect(weekly.pageSetup.orientation).toBe('landscape')
    expect(weekly.pageSetup.fitToWidth).toBe(2)
    expect(weekly.pageSetup.printTitlesColumn).toBe('A:C')
    expect((weekly as unknown as { conditionalFormattings: Array<{ rules: unknown[] }> }).conditionalFormattings[0].rules).toHaveLength(1)
    const summary = workbook.getWorksheet('Attendance Summary')!
    expect(summary.getCell('A4').text).toBe('TEST-001')
    expect(summary.getCell('H4').value).toBe(1)
    expect(summary.getCell('J4').value).toBe(3)
    expect(summary.getCell('K4').value).toBe('Not assessed')
    const review = workbook.getWorksheet('Review & Exceptions')!
    expect(review.getColumn(1).values).toContain('Original fingerprint events (direction is not inferred)')
    expect(review.getColumn(1).values).toContain('TEST-001')
    const metadata = workbook.getWorksheet('Report Metadata')!
    expect(metadata.getColumn(2).values).toContain('report-fixture-20261026')
    expect(metadata.getColumn(1).values).toContain('import-pdf')

    const pdfBytes = createAttendancePdf(report)
    const pdfPath = '/tmp/mmrjd-weekly-report-fixture.pdf'
    await mkdir('/tmp', { recursive: true })
    await writeFile(pdfPath, pdfBytes)
    const pdf = await getDocument({ data: new Uint8Array(pdfBytes) }).promise
    expect(pdf.numPages).toBeGreaterThanOrEqual(3)
    const text: string[] = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      text.push(content.items.map((item) => 'str' in item ? item.str : '').join(' '))
    }
    const extracted = text.join('\n')
    expect(extracted).toContain('MM&RJD')
    expect(extracted).toContain('2026-10-26 to 2026-11-01')
    expect(extracted).toContain('TEST-001')
    expect(extracted).toContain('Alice Example')
    expect(extracted).toContain('Very late')
    expect(extracted).toContain('Direction unknown')
    expect(extracted).toContain('Page 1 of')
    expect(extracted).toContain('fixture-original-records.pdf')
    expect(extracted).not.toContain('TEST-999')
  })

  it('denies unauthenticated report export before querying report data', async () => {
    authMocks.getAdministratorProfile.mockResolvedValueOnce(null)
    authMocks.loadAttendanceReportInput.mockClear()
    const { GET } = await import('../../app/api/reports/weekly/route')
    const response = await GET(new Request('http://localhost/api/reports/weekly?from=2026-10-26&to=2026-11-01&format=pdf'))
    expect(response.status).toBe(401)
    expect(authMocks.loadAttendanceReportInput).not.toHaveBeenCalled()

    authMocks.getAdministratorProfile.mockResolvedValueOnce({ id: 'admin-1' })
    const invalidWeek = await GET(new Request('http://localhost/api/reports/weekly?from=2026-10-27&to=2026-11-02&format=pdf'))
    expect(invalidWeek.status).toBe(400)
    expect(authMocks.loadAttendanceReportInput).not.toHaveBeenCalled()
  })

  it('serves Excel report requests as a real XLSX attachment', async () => {
    authMocks.getAdministratorProfile.mockResolvedValueOnce({ id: 'admin-1' })
    authMocks.loadAttendanceReportInput.mockResolvedValueOnce(reportInput)
    const { GET } = await import('../../app/api/reports/weekly/route')
    const response = await GET(new Request('http://localhost/api/reports/weekly?from=2026-10-26&to=2026-11-01&format=xlsx'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(response.headers.get('content-disposition')).toMatch(/\.xlsx"/)
    const bytes = Buffer.from(await response.arrayBuffer())
    expect([...bytes.subarray(0, 2)]).toEqual([0x50, 0x4b])
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0])
    expect(workbook.getWorksheet('Weekly Attendance')?.getCell('F8').text).toBeTruthy()
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Weekly Attendance', 'Attendance Summary', 'Review & Exceptions', 'Report Metadata'])
  })
})
