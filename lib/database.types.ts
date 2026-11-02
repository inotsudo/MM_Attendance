export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type AppRole = 'administrator' | 'attendance_manager' | 'reviewer' | 'viewer'
export type AttendanceSourceType = 'ivms_pdf_original_records' | 'organized_excel'
export type ImportProcessingStatus = 'uploaded' | 'queued' | 'processing' | 'parsed' | 'needs_review' | 'completed' | 'failed'
export type EmployeeMatchMethod = 'employee_number' | 'exact_name' | 'manual'
export type EmployeeMatchStatus = 'matched' | 'suggested' | 'unmatched' | 'rejected'
export type ReviewItemStatus = 'open' | 'resolved' | 'dismissed'
export type AttendanceReviewState = 'pending' | 'under_review' | 'confirmed' | 'corrected' | 'unresolved' | 'rejected'
export type ArrivalClassification = 'before_start' | 'on_time' | 'late' | 'very_late' | 'no_event'
export type CalculationCompleteness = 'complete_evidence' | 'incomplete_evidence' | 'no_events'

type Table<Row, Required extends keyof Row = never> = {
  Row: Row
  Insert: Pick<Row, Required> & Partial<Omit<Row, Required>>
  Update: Partial<Row>
  Relationships: []
}

type UserProfile = { id: string; full_name: string | null; role: AppRole; is_active: boolean; created_at: string; updated_at: string }
type Department = { id: string; name: string; code: string | null; is_active: boolean; created_at: string; updated_at: string }
type Employee = { id: string; employee_number: string; full_name: string; department_id: string | null; is_active: boolean; created_at: string; updated_at: string }
type AttendanceImport = {
  id: string
  source_type: AttendanceSourceType
  original_filename: string
  storage_bucket: string
  storage_path: string
  file_type: string
  file_size_bytes: number
  sha256_checksum: string
  uploaded_by: string
  uploaded_at: string
  processing_status: ImportProcessingStatus
  processing_error: string | null
  processing_started_at: string | null
  processing_completed_at: string | null
  created_at: string
}
type RawFingerprintEvent = {
  id: string
  import_id: string
  source_page: number | null
  source_row: number | null
  source_event_identifier: string | null
  source_employee_number: string | null
  source_employee_name: string | null
  source_department: string | null
  source_timestamp_text: string
  normalized_timestamp: string | null
  source_status: string | null
  checkpoint: string | null
  raw_evidence: Json
  extracted_at: string
}
type OrganizedAttendanceEntry = {
  id: string
  import_id: string
  source_sheet: string | null
  source_row: number
  source_column: number
  source_employee_number: string | null
  source_employee_name: string | null
  source_department: string | null
  source_work_date_text: string
  normalized_work_date: string | null
  source_in_text: string | null
  normalized_in_at: string | null
  source_out_text: string | null
  normalized_out_at: string | null
  raw_evidence: Json
  extracted_at: string
}
type EmployeeMatchDecision = {
  id: string
  raw_fingerprint_event_id: string | null
  organized_attendance_entry_id: string | null
  employee_id: string | null
  match_status: EmployeeMatchStatus
  match_method: EmployeeMatchMethod | null
  confidence: number | null
  decided_by: string | null
  decision_note: string | null
  created_at: string
}
type AttendanceRuleVersion = {
  id: string
  version: number
  attendance_timezone: string
  effective_from: string
  normal_start: string
  grace_until: string
  very_late_from: string
  scheduled_end: string
  overtime_from: string
  policy: Json
  reason: string
  created_by: string
  created_at: string
}
type DailyAttendanceCalculation = {
  id: string
  employee_id: string | null
  attendance_date: string
  calculation_version: number
  rules_version_id: string
  first_recorded_at: string | null
  last_recorded_at: string | null
  recorded_event_count: number
  arrival_classification: ArrivalClassification
  overtime_evidence: boolean
  is_weekend: boolean
  completeness: CalculationCompleteness
  calculation_result: Json
  calculated_at: string
  calculated_by: string | null
}
type DailyAttendanceEvidence = {
  id: string
  daily_calculation_id: string
  raw_fingerprint_event_id: string | null
  organized_attendance_entry_id: string | null
  created_at: string
}
type AttendanceReviewItem = {
  id: string
  import_id: string
  daily_calculation_id: string | null
  raw_fingerprint_event_id: string | null
  organized_attendance_entry_id: string | null
  issue_code: string
  severity: 'info' | 'warning' | 'error'
  status: ReviewItemStatus
  review_state: AttendanceReviewState
  reviewed_by: string | null
  reviewed_at: string | null
  description: string
  evidence: Json
  resolution_note: string | null
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
}
type AttendanceCorrection = {
  id: string
  daily_calculation_id: string
  correction_type: string
  previous_values: Json
  corrected_values: Json
  reason: string
  corrected_by: string
  corrected_at: string
  proposal_id: string | null
  finding_id: string | null
  rules_version_id: string | null
}
type AttendanceAnalysisRun = {
  id: string; import_id: string; analyzed_by: string; status: string; period_from: string | null; period_to: string | null
  source_record_count: number; summary: Json; error_message: string | null; started_at: string; completed_at: string | null
}
type AttendanceReviewFinding = {
  id: string; analysis_run_id: string; import_id: string; employee_id: string | null; employee_number: string | null
  employee_name: string | null; attendance_date: string | null; category: string
  evidence_class: 'confirmed_inconsistency' | 'potential_inconsistency' | 'insufficient_evidence'
  title: string; explanation: string; current_values: Json; source_references: Json; rules_version_id: string | null
  calculation_id: string | null; status: string; decision_note: string | null; decided_by: string | null
  decided_at: string | null; created_at: string
}
type AttendanceCorrectionProposal = {
  id: string; finding_id: string; import_id: string; employee_id: string; attendance_date: string
  current_calculation_id: string; rules_version_id: string; affected_field: string; previous_value: Json
  proposed_value: Json; proposed_calculation: Json; source_references: Json; explanation: string; confidence: number
  status: string; generated_at: string; decided_by: string | null; decided_at: string | null; decision_note: string | null
  application_error: string | null; resulting_calculation_id: string | null
}
type AttendanceReviewDecision = { id: string; finding_id: string; proposal_id: string | null; action: string; reason: string; actor_user_id: string; created_at: string; details: Json }
type AttendanceCalculationSupersession = { id: string; previous_calculation_id: string; replacement_calculation_id: string; proposal_id: string; superseded_by: string; superseded_at: string }
type AuditHistory = {
  id: string
  actor_user_id: string | null
  action: string
  target_table: string
  target_id: string | null
  reason: string | null
  before_values: Json | null
  after_values: Json | null
  occurred_at: string
}

export type Database = {
  public: {
    Tables: {
      user_profiles: Table<UserProfile, 'id'>
      departments: Table<Department, 'name'>
      employees: Table<Employee, 'employee_number' | 'full_name'>
      attendance_imports: Table<AttendanceImport, 'source_type' | 'original_filename' | 'storage_path' | 'file_type' | 'file_size_bytes' | 'sha256_checksum' | 'uploaded_by'>
      raw_fingerprint_events: Table<RawFingerprintEvent, 'import_id' | 'source_timestamp_text'>
      organized_attendance_entries: Table<OrganizedAttendanceEntry, 'import_id' | 'source_row' | 'source_work_date_text'>
      employee_match_decisions: Table<EmployeeMatchDecision, 'match_status'>
      attendance_rule_versions: Table<AttendanceRuleVersion, 'version' | 'effective_from' | 'normal_start' | 'grace_until' | 'very_late_from' | 'scheduled_end' | 'overtime_from' | 'reason' | 'created_by'>
      daily_attendance_calculations: Table<DailyAttendanceCalculation, 'attendance_date' | 'calculation_version' | 'rules_version_id' | 'arrival_classification' | 'is_weekend' | 'completeness'>
      daily_attendance_evidence: Table<DailyAttendanceEvidence, 'daily_calculation_id'>
      attendance_review_items: Table<AttendanceReviewItem, 'import_id' | 'issue_code' | 'description'>
      attendance_corrections: Table<AttendanceCorrection, 'daily_calculation_id' | 'correction_type' | 'previous_values' | 'corrected_values' | 'reason' | 'corrected_by'>
      attendance_analysis_runs: Table<AttendanceAnalysisRun, 'import_id' | 'analyzed_by'>
      attendance_review_findings: Table<AttendanceReviewFinding, 'analysis_run_id' | 'import_id' | 'category' | 'evidence_class' | 'title' | 'explanation'>
      attendance_correction_proposals: Table<AttendanceCorrectionProposal, 'finding_id' | 'import_id' | 'employee_id' | 'attendance_date' | 'current_calculation_id' | 'rules_version_id' | 'affected_field' | 'previous_value' | 'proposed_value' | 'proposed_calculation' | 'source_references' | 'explanation' | 'confidence'>
      attendance_review_decisions: Table<AttendanceReviewDecision, 'finding_id' | 'action' | 'reason' | 'actor_user_id'>
      attendance_calculation_supersessions: Table<AttendanceCalculationSupersession, 'previous_calculation_id' | 'replacement_calculation_id' | 'proposal_id' | 'superseded_by'>
      audit_history: Table<AuditHistory, 'action' | 'target_table'>
    }
    Views: Record<string, never>
    Functions: {
      user_has_any_role: { Args: { _roles: AppRole[] }; Returns: boolean }
      confirm_attendance_import: {
        Args: { p_import_id: string; p_records: Json; p_matches: Json; p_review_items: Json; p_calculations: Json }
        Returns: Json
      }
      resolve_attendance_review_item: {
        Args: { p_review_item_id: string; p_resolution_note: string; p_employee_id?: string | null }
        Returns: Json
      }
      update_attendance_review_item: {
        Args: { p_review_item_id: string; p_next_state: AttendanceReviewState; p_note: string; p_employee_id?: string | null }
        Returns: Json
      }
      persist_attendance_analysis: {
        Args: { p_import_id: string; p_period_from: string | null; p_period_to: string | null; p_source_record_count: number; p_summary: Json; p_findings: Json }
        Returns: Json
      }
      decide_attendance_finding: { Args: { p_finding_id: string; p_action: string; p_reason: string }; Returns: Json }
      apply_attendance_correction_proposal: { Args: { p_proposal_id: string }; Returns: Json }
      mark_attendance_proposal_application_failed: { Args: { p_proposal_id: string; p_error: string }; Returns: undefined }
    }
    Enums: {
      app_role: AppRole
      attendance_source_type: AttendanceSourceType
      import_processing_status: ImportProcessingStatus
      employee_match_method: EmployeeMatchMethod
      employee_match_status: EmployeeMatchStatus
      review_item_status: ReviewItemStatus
      arrival_classification: ArrivalClassification
      calculation_completeness: CalculationCompleteness
    }
    CompositeTypes: Record<string, never>
  }
}
