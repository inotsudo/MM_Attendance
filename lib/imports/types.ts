export type ImportSourceType = 'ivms_pdf_original_records' | 'organized_excel'

export type ImportWarning = {
  code: string
  message: string
  severity: 'warning' | 'error'
  sourceIndex?: number
  page?: number
  sheet?: string
  row?: number
}

export type PdfAttendanceRecord = {
  sourceIndex: number
  sourcePage: number
  sourceRow: number
  identityKey: string
  employeeNumber: string | null
  employeeName: string | null
  department: string | null
  sourceTimestamp: string
  normalizedTimestamp: string | null
  attendanceStatus: string | null
  checkpoint: string | null
  fields: Record<string, string | null>
  rawText: string
  warnings: ImportWarning[]
}

export type ExcelAttendanceRecord = {
  sourceIndex: number
  sourceSheet: string
  sourceRow: number
  sourceColumn: number
  identityKey: string
  employeeNumber: string | null
  employeeName: string | null
  department: string | null
  sourceWorkDate: string
  normalizedWorkDate: string | null
  sourceIn: string | null
  normalizedInAt: string | null
  sourceOut: string | null
  normalizedOutAt: string | null
  rawValues: Record<string, string | number | boolean | null>
  warnings: ImportWarning[]
}

export type ParsedAttendanceImport = {
  sourceType: ImportSourceType
  records: Array<PdfAttendanceRecord | ExcelAttendanceRecord>
  warnings: ImportWarning[]
}

export type EmployeeOption = { id: string; employeeNumber: string; fullName: string }

export type IdentityMatch = {
  identityKey: string
  sourceEmployeeNumber: string | null
  sourceEmployeeName: string | null
  recordCount: number
  matchStatus: 'matched' | 'suggested' | 'unmatched' | 'conflict'
  selectedEmployeeId: string | null
  reason: string
  candidates: EmployeeOption[]
}
