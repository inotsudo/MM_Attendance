import { describe, expect, it } from 'vitest'
import { analyzeAttendanceCalculation, comparePdfAndExcelEvidence, type AnalysisCalculation, type AnalysisEvidence, type AnalysisRule } from './attendance-analysis'

const rule: AnalysisRule = {
  id: 'rule-current', version: 4, effectiveFrom: '2026-09-01', timezone: 'Africa/Kigali',
  normalStart: '08:00', graceUntil: '08:30', veryLateFrom: '09:30', scheduledEnd: '17:30', overtimeFrom: '19:30',
  weekendOvertimeDays: null,
}

function calculation(overrides: Partial<AnalysisCalculation> = {}): AnalysisCalculation {
  return {
    id: 'calc-1', employeeId: 'employee-1', employeeNumber: 'EMP-1', employeeName: 'Amina Test',
    attendanceDate: '2026-09-14', version: 1, rulesVersionId: rule.id, arrivalClassification: 'late',
    firstRecordedAt: '2026-09-14T06:12:00.000Z', lastRecordedAt: '2026-09-14T15:30:00.000Z',
    recordedEventCount: 2, overtimeEvidence: false, weekend: false, completeness: 'complete_evidence',
    calculationResult: { engineVersion: 3 }, ...overrides,
  }
}

function excelEvidence(overrides: Partial<AnalysisEvidence> = {}): AnalysisEvidence {
  return {
    id: 'entry-1', sourceType: 'organized_excel', importId: 'import-1', filename: 'week.xlsx',
    employeeNumber: 'EMP-1', employeeName: 'Amina Test', department: 'HR', date: '2026-09-14', timestamp: null,
    sourceIn: '08:12', sourceOut: '17:30', normalizedInAt: '2026-09-14T06:12:00.000Z',
    normalizedOutAt: '2026-09-14T15:30:00.000Z', matchedEmployeeId: 'employee-1', ...overrides,
  }
}

describe('attendance review analysis', () => {
  it('proposes a rule-supported correction when organized IN time and saved classification disagree', () => {
    const findings = analyzeAttendanceCalculation({ calculation: calculation(), evidence: [excelEvidence()], rule, engineVersion: 3 })
    const finding = findings.find((item) => item.category === 'arrival_classification_mismatch')
    expect(finding?.evidenceClass).toBe('confirmed_inconsistency')
    expect(finding?.proposal?.previousValue).toEqual({ value: 'late' })
    expect(finding?.proposal?.proposedValue).toEqual({ value: 'on_time' })
    expect(finding?.sourceReferences.evidenceIds).toEqual(['entry-1'])
  })

  it('proposes the configured very-late classification from a verified 09:45 Excel IN value', () => {
    const evidence = excelEvidence({
      sourceIn: '09:45', normalizedInAt: '2026-09-14T07:45:00.000Z',
      sourceOut: '17:30', normalizedOutAt: '2026-09-14T15:30:00.000Z',
    })
    const findings = analyzeAttendanceCalculation({
      calculation: calculation({ arrivalClassification: 'on_time' }), evidence: [evidence], rule, engineVersion: 3,
    })
    const finding = findings.find((item) => item.category === 'arrival_classification_mismatch')
    expect(finding?.evidenceClass).toBe('confirmed_inconsistency')
    expect(finding?.proposal?.proposedValue).toEqual({ value: 'very_late' })
  })

  it('does not propose a late-arrival correction from a PDF event classified as OUT', () => {
    const evidence = excelEvidence({
      id: 'event-1', sourceType: 'ivms_pdf_original_records', timestamp: '2026-09-14T11:45:00.000Z',
      normalizedInAt: null, normalizedOutAt: null, sourceIn: null, sourceOut: null,
    })
    const findings = analyzeAttendanceCalculation({ calculation: calculation(), evidence: [evidence], rule, engineVersion: 3 })
    const finding = findings.find((item) => item.category === 'arrival_classification_mismatch')
    expect(finding?.evidenceClass).toBe('insufficient_evidence')
    expect(finding?.proposal).toBeNull()
  })

  it('flags an IN-only workbook record without inventing an OUT time', () => {
    const evidence = excelEvidence({ normalizedOutAt: null, sourceOut: null })
    const findings = analyzeAttendanceCalculation({ calculation: calculation(), evidence: [evidence], rule, engineVersion: 3 })
    const incomplete = findings.find((item) => item.category === 'incomplete_attendance_evidence')
    expect(incomplete?.evidenceClass).toBe('insufficient_evidence')
    expect(incomplete?.proposal).toBeNull()
  })

  it('reports duplicate source times without removing or rewriting either source record', () => {
    const duplicate = excelEvidence({ id: 'entry-duplicate' })
    const findings = analyzeAttendanceCalculation({
      calculation: calculation({ arrivalClassification: 'on_time' }),
      evidence: [excelEvidence(), duplicate], rule, engineVersion: 3,
    })
    const finding = findings.find((item) => item.category === 'duplicate_fingerprint_events')
    expect(finding?.evidenceClass).toBe('potential_inconsistency')
    expect(finding?.sourceReferences.evidenceIds).toEqual(['entry-1', 'entry-duplicate'])
    expect(finding?.proposal).toBeNull()
  })

  it('refuses proposals when the linked source has a conflicting employee match', () => {
    const evidence = excelEvidence({ matchedEmployeeId: 'employee-2' })
    const findings = analyzeAttendanceCalculation({ calculation: calculation(), evidence: [evidence], rule, engineVersion: 3 })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.category).toBe('conflicting_employee_match')
    expect(findings[0]?.proposal).toBeNull()
  })

  it('reports a PDF and workbook discrepancy without choosing either source', () => {
    const pdfIn: AnalysisEvidence = { ...excelEvidence(), id: 'pdf-in', importId: 'pdf-import', sourceType: 'ivms_pdf_original_records', filename: 'ivms.pdf', timestamp: '2026-09-14T06:12:00.000Z', sourceTimestampText: '2026-09-14 08:12:00', normalizedInAt: null, normalizedOutAt: null, sourceIn: null, sourceOut: null }
    const pdfOut: AnalysisEvidence = { ...pdfIn, id: 'pdf-out', timestamp: '2026-09-14T15:30:00.000Z', sourceTimestampText: '2026-09-14 17:30:00' }
    const workbook: AnalysisEvidence = excelEvidence({ normalizedInAt: '2026-09-14T06:15:00.000Z' })
    const findings = comparePdfAndExcelEvidence({ selectedImportId: 'import-1', records: [pdfIn, pdfOut, workbook], calculations: [calculation()] })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.category).toBe('pdf_excel_time_discrepancy')
    expect(findings[0]?.evidenceClass).toBe('potential_inconsistency')
    expect(findings[0]?.proposal).toBeNull()
    expect(findings[0]?.sourceReferences.evidenceIds).toEqual(['entry-1', 'pdf-in', 'pdf-out'])
  })

  it('does not report matching PDF and workbook values as an inconsistency', () => {
    const pdfIn: AnalysisEvidence = { ...excelEvidence(), id: 'pdf-in', importId: 'pdf-import', sourceType: 'ivms_pdf_original_records', filename: 'ivms.pdf', timestamp: '2026-09-14T06:12:00.000Z', sourceTimestampText: '2026-09-14 08:12:00', normalizedInAt: null, normalizedOutAt: null, sourceIn: null, sourceOut: null }
    const pdfOut: AnalysisEvidence = { ...pdfIn, id: 'pdf-out', timestamp: '2026-09-14T15:30:00.000Z', sourceTimestampText: '2026-09-14 17:30:00' }
    const findings = comparePdfAndExcelEvidence({ selectedImportId: 'import-1', records: [pdfIn, pdfOut, excelEvidence()], calculations: [calculation()] })
    expect(findings).toHaveLength(0)
  })
})
