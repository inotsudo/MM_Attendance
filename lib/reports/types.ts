export type ReportEmployee = {
  id: string
  employeeNumber: string
  fullName: string
  department: string | null
}

export type ReportEvidence = {
  id: string
  importId: string
  sourceType: 'ivms_pdf_original_records' | 'organized_excel'
  employeeId: string | null
  employeeNumber: string | null
  employeeName: string | null
  department: string | null
  date: string | null
  timestamp: string | null
  sourceTimestampText: string | null
  sourceIn: string | null
  normalizedInAt: string | null
  sourceOut: string | null
  normalizedOutAt: string | null
  attendanceStatus: string | null
  checkpoint: string | null
  sourceSheet: string | null
  sourcePage: number | null
  sourceRow: number | null
}

export type ReportRule = {
  id: string
  version: number
  effectiveFrom: string
  normalStart: string
  graceUntil: string
  veryLateFrom: string
  scheduledEnd: string
  overtimeFrom: string
  timezone: string
  weekendOvertimeDays: Array<'Saturday' | 'Sunday'> | null
}

export type ReportCalculation = {
  id: string
  employeeId: string
  date: string
  version: number
  rulesVersionId: string
  firstRecordedAt: string | null
  lastRecordedAt: string | null
  recordedEventCount: number
  arrivalClassification: string
  overtimeEvidence: boolean
  weekend: boolean
  completeness: string
  calculatedAt: string
  engineVersion: number | null
  evidenceIds: string[]
  correctionCount: number
}

export type ReportCorrection = {
  id: string
  calculationId: string
  employeeId: string
  correctedAt: string
  correctedBy: string
  reason: string
  correctionType: string
}

export type ReportReviewItem = {
  id: string
  importId: string
  evidenceId: string | null
  issueCode: string
  severity: 'info' | 'warning' | 'error'
  description: string
  status: 'open' | 'resolved' | 'dismissed'
}

export type ReportImport = {
  id: string
  filename: string
  sourceType: string
  uploadedAt: string
  checksum: string
}

export type ReportException = {
  severity: 'info' | 'warning' | 'error'
  employeeNumber: string | null
  employeeName: string | null
  date: string | null
  source: string | null
  explanation: string
}

export type ReportDayCell = {
  date: string
  kind: 'calculated' | 'fingerprint_events' | 'organized_evidence' | 'stale' | 'no_records'
  firstRecorded: string | null
  lastRecorded: string | null
  inTimes: string[]
  outTimes: string[]
  sourceInValues: string[]
  sourceOutValues: string[]
  eventTimes: string[]
  classification: string
  completeness: string
  overtime: 'Yes' | 'No' | 'Unverified' | '—'
  recordCount: number
  notes: string[]
}

export type ReportEmployeeRow = {
  employee: ReportEmployee
  days: ReportDayCell[]
  totals: {
    calculatedDays: number
    evidenceDays: number
    lateDays: number
    veryLateDays: number
    overtimeDays: number
    incompleteDays: number
    noSourceRecordDays: number
    reviewExceptions: number
  }
}

export type AttendanceReport = {
  metadata: {
    reportId: string
    title: string
    organization: string
    generatedAt: string
    timezone: 'Africa/Kigali'
    periodStart: string
    periodEnd: string
    rosterBasis: string
  }
  dates: string[]
  rules: ReportRule[]
  imports: ReportImport[]
  employees: ReportEmployeeRow[]
  exceptions: ReportException[]
  fingerprintEvidence: ReportEvidence[]
  summary: {
    employeesIncluded: number
    activeEmployees: number
    attendanceDaysCalculated: number
    daysWithEvidence: number
    noSourceRecordDays: number
    lateDays: number
    veryLateDays: number
    verifiedOvertimeDays: number
    incompleteDays: number
    reviewExceptions: number
  }
}
