'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CalendarDays, CheckCircle2, ChevronDown, CircleHelp, FileBarChart, FileCheck2, FileSpreadsheet, FileText, Fingerprint, LayoutDashboard, Menu, Search, Settings, SlidersHorizontal, Upload, Users, X } from 'lucide-react'
import { DEFAULT_ATTENDANCE_RULES, processAttendanceEvents } from '@/lib/attendance-engine'
import type { EmployeeOption, IdentityMatch, ImportWarning, PdfAttendanceRecord, ExcelAttendanceRecord } from '@/lib/imports/types'
import { IntelligentReview } from './intelligent-review'

const navItems = [
  { label: 'Dashboard', icon: LayoutDashboard },
  { label: 'Employees', icon: Users },
  { label: 'Import attendance', icon: Upload },
  { label: 'Attendance records', icon: CalendarDays },
  { label: 'Review & corrections', icon: CircleHelp },
  { label: 'Reports', icon: FileBarChart },
]

type ImportState = 'idle' | 'selected' | 'uploading' | 'previewing' | 'previewed' | 'confirming' | 'completed' | 'failed'
type ImportSummary = { fileName: string; format: string; message: string }
type ImportPreview = {
  importId: string
  fileName: string
  sourceType: 'ivms_pdf_original_records' | 'organized_excel'
  status: string
  summary: { totalRecords: number; uniqueEmployeeIdentifiers: number; dateRange: { from: string | null; to: string | null }; duplicateRecords: number; incompleteRecords: number; unmatchedIdentities: number; warningCount: number }
  warnings: ImportWarning[]
  matches: IdentityMatch[]
  employees: EmployeeOption[]
  records: Array<PdfAttendanceRecord | ExcelAttendanceRecord>
}
type OpenReviewItem = {
  id: string
  import_id: string
  daily_calculation_id: string | null
  originalFilename: string
  issue_code: string
  severity: 'info' | 'warning' | 'error'
  review_state: 'pending' | 'under_review' | 'confirmed' | 'corrected' | 'unresolved' | 'rejected'
  description: string
  evidence: unknown
  rawEvent: { source_page: number | null; source_row: number | null; source_employee_number: string | null; source_employee_name: string | null; source_department: string | null; source_timestamp_text: string; source_status: string | null; checkpoint: string | null } | null
  organizedEntry: { source_sheet: string | null; source_row: number; source_employee_number: string | null; source_employee_name: string | null; source_work_date_text: string; source_in_text: string | null; source_out_text: string | null } | null
}
type ReviewCalculation = {
  id: string
  employee_id: string
  attendance_date: string
  calculation_version: number
  first_recorded_at: string | null
  last_recorded_at: string | null
  arrival_classification: string
  overtime_evidence: boolean
  completeness: string
  employeeNumber: string
  employeeName: string
  currentFirstRecordedAt: string | null
  currentLastRecordedAt: string | null
  hasCorrection: boolean
}
type ReviewPage = { offset: number; limit: number; hasMore: boolean }
type CorrectionHistoryItem = {
  id: string
  daily_calculation_id: string
  correction_type: string
  previous_values: unknown
  corrected_values: unknown
  reason: string
  corrected_by: string
  correctedByName: string
  corrected_at: string
  attendanceDate: string | null
  employeeNumber: string
  employeeName: string
}
type ImportHistoryRow = {
  id: string
  original_filename: string
  source_type: 'ivms_pdf_original_records' | 'organized_excel'
  file_size_bytes: number
  uploaded_at: string
  processing_status: string
}
type AttendanceRuleRecord = {
  id: string
  version: number
  attendance_timezone: string
  effective_from: string
  normal_start: string
  grace_until: string
  very_late_from: string
  scheduled_end: string
  overtime_from: string
  policy: unknown
  reason: string
  created_at: string
}

function EmptyState({ icon: Icon, title, description, action, onAction }: { icon: typeof Users; title: string; description: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><div className="empty-icon"><Icon /></div><h2>{title}</h2><p>{description}</p>{action && <button className="button primary" onClick={onAction}>{action}</button>}</div>
}

export function AttendanceApp() {
  const [active, setActive] = useState('Dashboard')
  const [mobileNav, setMobileNav] = useState(false)
  const [importState, setImportState] = useState<ImportState>('idle')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [matchSelections, setMatchSelections] = useState<Record<string, string | null>>({})
  const [importError, setImportError] = useState<string | null>(null)
  const [activeImportId, setActiveImportId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [employeeDraft, setEmployeeDraft] = useState({ id: '', name: '', department: '' })
  const [employeeDraftSaved, setEmployeeDraftSaved] = useState(false)
  const reportExportAction = useRef<(() => void) | null>(null)

  const title = active === 'Dashboard' ? 'Dashboard' : active
  const subtitle = active === 'Dashboard' ? 'Your attendance operations at a glance.' : `Manage ${active.toLowerCase()} across MM&RJD.`

  async function uploadFile(file: File) {
    let createdImportId: string | null = null
    let originalStored = false
    setSelectedFile(file)
    setImportState('selected')
    setImportSummary(null)
    const allowed = ['.xlsx', '.pdf']
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!allowed.includes(extension)) return
    setImportState('uploading')
    setImportError(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
      const initResponse = await fetch('/api/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, size: file.size, sha256 }),
      })
      const upload = await initResponse.json()
      if (!initResponse.ok) throw new Error(upload.error ?? 'The file could not be prepared for upload.')
      createdImportId = upload.importId
      setActiveImportId(upload.importId)

      if (!upload.stored) {
        const { createSupabaseBrowserClient } = await import('@/lib/supabase/client')
        const supabase = createSupabaseBrowserClient()
        const { error: uploadError } = await supabase.storage.from(upload.bucket).uploadToSignedUrl(upload.storagePath, upload.uploadToken, bytes, { contentType: extension === '.pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', upsert: false })
        if (uploadError) throw new Error(`Private file upload failed: ${uploadError.message}`)
      }
      originalStored = true

      setImportState('previewing')
      const previewResponse = await fetch(`/api/import/${upload.importId}/preview`, { method: 'POST' })
      const preview = await previewResponse.json()
      if (!previewResponse.ok) throw new Error(preview.error ?? 'The file was uploaded but could not be previewed.')
      setImportPreview(preview)
      setMatchSelections(Object.fromEntries((preview.matches as IdentityMatch[]).map((match) => [match.identityKey, match.selectedEmployeeId])))
      setImportSummary({ fileName: file.name, format: extension.slice(1).toUpperCase(), message: 'File uploaded privately and extracted. Review the preview before confirming.' })
      setImportState('previewed')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The import failed.'
      if (createdImportId) await fetch(`/api/import/${createdImportId}/failed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: message }) }).catch(() => undefined)
      const userMessage = originalStored
        ? `${message} The original file is saved privately. Download it from Uploaded original files below or select it again to retry.`
        : message
      setImportError(userMessage)
      setImportSummary({ fileName: file.name, format: extension.slice(1).toUpperCase(), message: userMessage })
      setImportState('failed')
    }
  }

  async function confirmImport() {
    if (!importPreview) return
    setImportState('confirming')
    setImportError(null)
    try {
      const response = await fetch(`/api/import/${importPreview.importId}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeByIdentity: matchSelections }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'The import could not be confirmed.')
      setImportSummary({ fileName: importPreview.fileName, format: importPreview.sourceType === 'ivms_pdf_original_records' ? 'PDF' : 'XLSX', message: result.alreadyCompleted ? 'This import was already processed.' : `Import ${result.status}: saved ${result.recordCount} source records, ${result.calculationCount} calculations, and ${result.reviewCount} review items.` })
      setActiveImportId(null)
      setImportState('completed')
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'The import could not be confirmed. You can safely retry.')
      setImportState('previewed')
    }
  }

  async function resumeImport(importId: string) {
    setActive('Import attendance')
    setActiveImportId(importId)
    setSelectedFile(null)
    setImportPreview(null)
    setImportSummary(null)
    setImportError(null)
    setImportState('previewing')
    try {
      const response = await fetch(`/api/import/${importId}/preview`, { method: 'POST' })
      const preview = await response.json()
      if (!response.ok) throw new Error(preview.error ?? 'The stored import could not be resumed.')
      setImportPreview(preview)
      setMatchSelections(Object.fromEntries((preview.matches as IdentityMatch[]).map((match) => [match.identityKey, match.selectedEmployeeId])))
      setImportSummary({ fileName: preview.fileName, format: preview.sourceType === 'ivms_pdf_original_records' ? 'PDF' : 'XLSX', message: 'Reopened the original file from private storage. Review the extracted records and matches before confirming.' })
      setImportState('previewed')
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'The stored import could not be resumed.')
      setImportState('failed')
    }
  }

  return <main className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}><div className="brand-lockup"><div className="brand-mark"><Fingerprint /></div><div><strong>MM&amp;RJD</strong><span>Attendance</span></div></div><nav aria-label="Primary navigation" className="primary-nav">{navItems.map(({ label, icon: Icon }) => <button key={label} className={`nav-item ${active === label ? 'active' : ''}`} onClick={() => { setActive(label); setMobileNav(false) }}><Icon className="nav-icon" /><span>{label}</span></button>)}</nav><div className="sidebar-bottom"><button className={`nav-item ${active === 'Settings' ? 'active' : ''}`} onClick={() => { setActive('Settings'); setMobileNav(false) }}><Settings className="nav-icon" /><span>Settings</span></button><div className="user-chip"><div className="avatar avatar-light">?</div><div><strong>Administrator</strong><span>MM&amp;RJD account</span></div><form action="/auth/signout" method="post" className="signout-form"><button type="submit" className="signout-button">Sign out</button></form></div></div></aside>
    {mobileNav && <button className="nav-scrim" aria-label="Close menu" onClick={() => setMobileNav(false)} />}
    <section className="workspace"><header className="topbar"><button className="menu-button" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu /></button><div className="crumb"><span>MM&amp;RJD</span><span>/</span><strong>{title}</strong></div><div className="top-actions"><button className="icon-button" aria-label="Help"><CircleHelp /></button></div></header><div className="content"><div className="page-heading"><div><p className="eyebrow">Attendance operations</p><h1>{title}</h1><p className="subtitle">{subtitle}</p></div><div className="heading-actions">{active === 'Import attendance' ? <button type="button" className="button secondary" onClick={() => setActive('Reports')} title="Choose a reporting week and download the attendance report as Excel or PDF"><FileBarChart /> Create attendance report</button> : active === 'Reports' ? <button type="button" className="button secondary" onClick={() => reportExportAction.current?.()}><ArrowDownToLine /> Export report</button> : <button type="button" className="button secondary" disabled title="Attendance report export is available from the Reports page."><ArrowDownToLine /> Export</button>}<button className="button primary" onClick={() => setActive('Import attendance')}><Upload /> Import attendance</button></div></div>
      {active === 'Dashboard' && <DashboardView onImport={() => setActive('Import attendance')} />}
      {active === 'Import attendance' && <ImportView importState={importState} selectedFile={selectedFile} summary={importSummary} preview={importPreview} selections={matchSelections} onSelection={(key, value) => setMatchSelections((current) => ({ ...current, [key]: value }))} onConfirm={confirmImport} error={importError} onFile={uploadFile} onResume={resumeImport} onReset={() => { setSelectedFile(null); setImportSummary(null); setImportPreview(null); setMatchSelections({}); setImportError(null); setActiveImportId(null); setImportState('idle') }} />}
      {active === 'Attendance records' && <RecordsView query={query} setQuery={setQuery} />}
      {active === 'Review & corrections' && <ReviewView />}
      {active === 'Reports' && <ReportsView exportAction={reportExportAction} />}
      {active === 'Employees' && <EmployeeView draft={employeeDraft} setDraft={setEmployeeDraft} saved={employeeDraftSaved} onSave={() => setEmployeeDraftSaved(true)} />}
      {active === 'Settings' && <SettingsView />}
    </div></section>
  </main>
}

function DashboardView({ onImport }: { onImport: () => void }) { return <><section className="overview-grid"><StatCard icon={<Users />} label="Employees matched" /><StatCard icon={<FileCheck2 />} label="Records imported" /><StatCard icon={<AlertTriangle />} label="Need review" /><StatCard icon={<FileBarChart />} label="Report status" value="Not generated" /></section><div className="dashboard-grid"><section className="panel upload-panel"><div className="panel-heading"><div><h2>Upload attendance file</h2><p>Import an iVMS-4200 export to get started.</p></div><Upload className="heading-icon" /></div><button className="empty-upload" onClick={onImport}><ArrowUpFromLine /><strong>No attendance files imported yet</strong><span>Choose an Excel or PDF export to begin.</span></button></section><section className="panel weekly-panel"><div className="panel-heading"><div><h2>Weekly overview</h2><p>Attendance status for the selected period.</p></div><CalendarDays className="heading-icon" /></div><EmptyState icon={FileBarChart} title="No attendance data" description="Import a file to see weekly summaries." /></section></div><section className="panel activity-panel"><div className="panel-heading"><div><h2>Recent attendance activity</h2><p>Processed records will appear here.</p></div></div><EmptyState icon={CalendarDays} title="No activity yet" description="There are no persisted attendance records." /></section></> }
function StatCard({ icon, label, value = '—', caption = 'No data available' }: { icon: React.ReactNode; label: string; value?: string; caption?: string }) { return <article className="stat-card"><div className="stat-icon">{icon}</div><span>{label}</span><strong>{value}</strong><small>{caption}</small></article> }

function kigaliClock(value: string | null) {
  if (!value) return ''
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value))
}

function correctionValueTimes(value: unknown): { firstRecordedAt: string | null; lastRecordedAt: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { firstRecordedAt: null, lastRecordedAt: null }
  const values = value as { firstRecordedAt?: unknown; lastRecordedAt?: unknown }
  return {
    firstRecordedAt: typeof values.firstRecordedAt === 'string' ? values.firstRecordedAt : null,
    lastRecordedAt: typeof values.lastRecordedAt === 'string' ? values.lastRecordedAt : null,
  }
}

function reviewIssueTitle(code: string) {
  const labels: Record<string, string> = {
    unmatched_employee: 'Employee not matched',
    conflicting_employee: 'Employee details conflict',
    missing_employee_id: 'Employee ID missing',
    invalid_timestamp: 'Date or time needs review',
    duplicate_event: 'Possible duplicate fingerprint event',
    single_event: 'Only one fingerprint event recorded',
    missing_in: 'Arrival time missing',
    missing_out: 'Departure time missing',
    direction_unknown: 'Fingerprint direction needs review',
    attendance_rules_missing: 'Attendance rules not configured',
    attendance_rules_unavailable: 'Attendance rules unavailable',
  }
  return labels[code] ?? code.replaceAll('_', ' ')
}

function ReviewView() {
  const [items, setItems] = useState<OpenReviewItem[]>([])
  const [employees, setEmployees] = useState<EmployeeOption[]>([])
  const [corrections, setCorrections] = useState<CorrectionHistoryItem[]>([])
  const [itemsPage, setItemsPage] = useState<ReviewPage>({ offset: 0, limit: 50, hasMore: false })
  const [historyPage, setHistoryPage] = useState<ReviewPage>({ offset: 0, limit: 25, hasMore: false })
  const [drafts, setDrafts] = useState<Record<string, { note: string; employeeId: string; reviewState: string }>>({})
  const [stateFilter, setStateFilter] = useState('active')
  const [savingReviewId, setSavingReviewId] = useState<string | null>(null)
  const [queueLoading, setQueueLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function refreshItems(offset = 0, append = false) {
    setQueueLoading(true)
    try {
      const response = await fetch(`/api/reviews?offset=${offset}&limit=50&state=${stateFilter}&includeEmployees=${offset === 0}`, { cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Review items could not be loaded.')
      setItems((current) => append ? [...current, ...(result.items ?? [])] : (result.items ?? []))
      if (offset === 0) setEmployees(result.employees ?? [])
      setItemsPage(result.page)
      setError(null)
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Review items could not be loaded.')
    } finally { setQueueLoading(false) }
  }

  async function refreshHistory(offset = 0, append = false) {
    setHistoryLoading(true)
    setHistoryLoaded(true)
    try {
      const response = await fetch(`/api/reviews/corrections?view=history&offset=${offset}&limit=25`, { cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Attendance correction history could not be loaded.')
      setCorrections((current) => append ? [...current, ...(result.corrections ?? [])] : (result.corrections ?? []))
      setHistoryPage(result.page)
      setError(null)
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Attendance correction history could not be loaded.')
    } finally { setHistoryLoading(false) }
  }

  useEffect(() => {
    void refreshItems()
  }, [stateFilter])

  async function resolve(item: OpenReviewItem) {
    const draft = drafts[item.id]
    if (!draft?.note.trim()) { setError('Add a short note explaining the decision.'); return }
    setSavingReviewId(item.id)
    try {
      const response = await fetch(`/api/reviews/${item.id}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: draft.note, employeeId: draft.employeeId || null, reviewState: draft.reviewState || 'under_review' }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Review item could not be resolved.')
      setNotice(result.alreadyUpdated ? 'This review item was already updated.' : result.requiresReprocessing ? 'Employee match saved. This item stays open until attendance is recalculated from the matched source evidence.' : 'Review decision saved to the audit history.')
      await refreshItems()
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'Review item could not be resolved.') }
    finally { setSavingReviewId(null) }
  }

  return <section className="panel review-page">
    <div className="panel-heading"><div><h2>Reviews &amp; corrections</h2><p>Resolve attendance questions and keep a clear record of each decision.</p></div><CircleHelp className="heading-icon" /></div>
    {error && <p role="alert" className="form-notice">{error}</p>}
    {notice && <p role="status" className="form-notice">{notice}</p>}
    <IntelligentReview />
    <details className="review-secondary"><summary>Import validation notes</summary>
    <div className="filters"><label className="field-label">Show<select value={stateFilter} onChange={(event) => { setStateFilter(event.target.value); setItems([]); }}><option value="active">Open items</option><option value="pending">Needs review</option><option value="under_review">In progress</option><option value="unresolved">Unresolved</option><option value="confirmed">Confirmed</option><option value="corrected">Corrected</option><option value="rejected">Rejected</option><option value="all">All items</option></select></label></div>
    {queueLoading && items.length === 0 ? <p className="subtitle">Loading persisted review items…</p> : items.length === 0 ? <EmptyState icon={CircleHelp} title="No records require review" description="There are no open persisted attendance review items." /> : <div className="review-list">{items.map((item) => {
      const draft = drafts[item.id] ?? { note: '', employeeId: '', reviewState: 'under_review' }
      const source = item.rawEvent ?? item.organizedEntry
      const canMatch = ['unmatched_employee', 'conflicting_employee', 'missing_employee_id'].includes(item.issue_code) && Boolean(item.rawEvent || item.organizedEntry)
      const sourceId = item.rawEvent?.source_employee_number ?? item.organizedEntry?.source_employee_number
      const sourceName = item.rawEvent?.source_employee_name ?? item.organizedEntry?.source_employee_name
      return <article className="review-card" key={item.id}>
        <div className="review-card-heading"><strong>{reviewIssueTitle(item.issue_code)}</strong><span className={`review-severity ${item.severity}`}>{item.review_state.replaceAll('_', ' ')}</span></div>
        <p>{item.description}</p>
        <p className="subtitle">{sourceName ?? 'Employee not identified'}{sourceId ? ` · ID ${sourceId}` : ''}</p>
        <details className="review-evidence"><summary>View source details</summary><p className="review-source">{item.originalFilename}{item.rawEvent ? ` · Page ${item.rawEvent.source_page ?? '—'}, row ${item.rawEvent.source_row ?? '—'} · ${item.rawEvent.source_timestamp_text}` : ''}{item.organizedEntry ? ` · ${item.organizedEntry.source_sheet ?? 'Workbook'} · ${item.organizedEntry.source_work_date_text} · IN ${item.organizedEntry.source_in_text ?? 'blank'} · OUT ${item.organizedEntry.source_out_text ?? 'blank'}` : ''}</p></details>
        <label className="field-label">Decision<select value={draft.reviewState} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, reviewState: event.target.value } }))}><option value="under_review">Mark in progress</option><option value="confirmed">Confirm</option><option value="unresolved">Needs follow-up</option><option value="rejected">Reject item</option><option value="pending">Return to queue</option></select></label>
        {canMatch && <label className="field-label">Employee match<select value={draft.employeeId} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, employeeId: event.target.value, reviewState: event.target.value ? 'confirmed' : 'under_review' } }))}><option value="">No match selected</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeNumber} · {employee.fullName}</option>)}</select></label>}
        <label className="field-label">Note<textarea rows={2} value={draft.note} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, note: event.target.value } }))} placeholder="Briefly explain the decision" /></label>
        <button className="button secondary" disabled={!draft.note.trim() || savingReviewId === item.id} onClick={() => void resolve(item)}>{savingReviewId === item.id ? 'Saving…' : 'Save decision'}</button>
      </article>
    })}</div>}
    {!queueLoading && <p className="subtitle">Showing {items.length} open review items{itemsPage.hasMore ? ' loaded; more are available.' : ' total.'}</p>}
    {itemsPage.hasMore && <button className="button secondary" disabled={queueLoading} onClick={() => void refreshItems(items.length, true)}>{queueLoading ? 'Loading review items…' : 'Load more review items'}</button>}
    </details>
    <details className="review-secondary">
      <summary>Correction history</summary>
      <div className="panel-heading"><div><h2>Correction history</h2><p>Actions are loaded in pages so the full audit history remains available.</p></div></div>
      {!historyLoaded ? <button className="button secondary" disabled={historyLoading} onClick={() => void refreshHistory()}>{historyLoading ? 'Loading history…' : 'Load correction history'}</button> : historyLoading && corrections.length === 0 ? <p className="subtitle">Loading correction history…</p> : corrections.length === 0 ? <p className="subtitle">No attendance corrections have been recorded.</p> : <div className="review-list">{corrections.map((correction) => {
        const before = correctionValueTimes(correction.previous_values)
        const after = correctionValueTimes(correction.corrected_values)
        const beforeClass = correction.previous_values && typeof correction.previous_values === 'object' && 'value' in correction.previous_values ? String(correction.previous_values.value) : null
        const afterClass = correction.corrected_values && typeof correction.corrected_values === 'object' && 'value' in correction.corrected_values ? String(correction.corrected_values.value) : null
        return <article className="review-card" key={correction.id}>
          <div className="review-card-heading"><strong>{correction.employeeName} · {correction.attendanceDate ?? 'Date unavailable'}</strong><span className="review-severity warning">{correction.correction_type.replaceAll('_', ' ')}</span></div>
          <p className="review-source">{beforeClass !== null && afterClass !== null ? `Arrival classification: ${beforeClass.replaceAll('_', ' ')} → ${afterClass.replaceAll('_', ' ')}` : `Before: IN ${kigaliClock(before.firstRecordedAt) || 'Missing'} / OUT ${kigaliClock(before.lastRecordedAt) || 'Missing'} · After: IN ${kigaliClock(after.firstRecordedAt) || 'Missing'} / OUT ${kigaliClock(after.lastRecordedAt) || 'Missing'}`}</p>
          <p>{correction.reason}</p>
          <p className="subtitle">Recorded by {correction.correctedByName} · {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Kigali' }).format(new Date(correction.corrected_at))} (Africa/Kigali)</p>
        </article>
      })}</div>}
      {historyLoaded && !historyLoading && <p className="subtitle">Showing {corrections.length} correction actions{historyPage.hasMore ? ' loaded; more are available.' : ' total.'}</p>}
      {historyLoaded && historyPage.hasMore && <button className="button secondary" disabled={historyLoading} onClick={() => void refreshHistory(corrections.length, true)}>{historyLoading ? 'Loading history…' : 'Load more correction history'}</button>}
    </details>
  </section>
}

function ImportView({ importState, selectedFile, summary, preview, selections, onSelection, onConfirm, error, onFile, onResume, onReset }: {
  importState: ImportState
  selectedFile: File | null
  summary: ImportSummary | null
  preview: ImportPreview | null
  selections: Record<string, string | null>
  onSelection: (key: string, value: string | null) => void
  onConfirm: () => void
  error: string | null
  onFile: (file: File) => void
  onResume: (importId: string) => void
  onReset: () => void
}) {
  const activeStep = ['idle', 'selected', 'uploading', 'failed'].includes(importState) ? 1 : ['previewing', 'previewed'].includes(importState) ? 2 : 3
  const blockingIssueCodes = new Set(['month_label_conflict', 'year_label_conflict', 'ambiguous_work_date', 'invalid_work_date', 'date_year_missing', 'duplicate_date_heading', 'duplicate_date_direction'])
  const confirmationBlocked = Boolean(preview && (
    preview.warnings.some((warning) => blockingIssueCodes.has(warning.code))
    || preview.records.some((record) => record.warnings.some((warning) => blockingIssueCodes.has(warning.code)))
  ))
  return <section className="panel import-page">
    <div className="import-intro"><div className="large-icon"><Upload /></div><div><h2>Import an iVMS-4200 export</h2><p>Original files stay private. Review extracted records and employee matches before confirming.</p></div></div>
    {importState === 'idle' || importState === 'failed' ? <label className={`dropzone large-dropzone ${importState === 'failed' ? 'failed' : ''}`}>
      <input type="file" accept=".xlsx,.pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(file) }} />
      <ArrowUpFromLine className="drop-icon" /><strong>{importState === 'failed' ? 'Choose a supported or corrected file to retry' : 'Drop Excel or PDF file here'}</strong><span>{error ?? 'Choose an iVMS Original Records PDF or organized XLSX attendance workbook (up to 25 MiB).'}</span><button type="button" className="button primary">Choose file</button>
    </label> : <div className="dropzone large-dropzone import-progress">
      {importState === 'confirming' ? <FileCheck2 className="drop-icon" /> : importState === 'previewing' || importState === 'uploading' ? <ArrowUpFromLine className="drop-icon" /> : <CheckCircle2 className="drop-icon success" />}
      <strong>{importState === 'uploading' ? 'Uploading original file privately…' : importState === 'previewing' ? 'Extracting records and preparing preview…' : importState === 'confirming' ? 'Saving source evidence and calculations…' : summary?.message ?? `File selected: ${selectedFile?.name ?? preview?.fileName}`}</strong>
      {(importState === 'previewed' || importState === 'completed') && <button type="button" className="button secondary small" onClick={onReset}>{importState === 'completed' ? 'Start another import' : 'Choose another file'}</button>}
    </div>}
    {error && importState !== 'failed' && <p role="alert" className="form-notice">{error}</p>}
    {preview && <>
      <div className="steps">{['Validate', 'Extract and preview', 'Process and save'].map((label, index) => <div key={label} className={`step ${activeStep >= index + 1 ? 'active' : ''}`}><b>{index + 1}</b><span>{label}</span></div>)}</div>
      <section className="panel import-preview">
        <div className="panel-heading"><div><h2>Extraction preview</h2><p>{preview.fileName} · {preview.sourceType === 'ivms_pdf_original_records' ? 'iVMS PDF Original Records' : 'Organized Excel attendance'}</p></div><FileCheck2 className="heading-icon" /></div>
        <div className="overview-grid import-preview-stats">
          <StatCard icon={<FileCheck2 />} label="Extracted records" value={String(preview.summary.totalRecords)} caption="from this file" />
          <StatCard icon={<Users />} label="Employee IDs" value={String(preview.summary.uniqueEmployeeIdentifiers)} caption="unique source IDs" />
          <StatCard icon={<AlertTriangle />} label="Duplicates" value={String(preview.summary.duplicateRecords)} caption="within this file" />
          <StatCard icon={<CircleHelp />} label="Incomplete / flagged" value={String(preview.summary.incompleteRecords)} caption="records need inspection" />
        </div>
        <p className="subtitle">Date range: {preview.summary.dateRange.from ?? 'Unknown'} – {preview.summary.dateRange.to ?? 'Unknown'} · Unmatched/conflicting identities: {preview.summary.unmatchedIdentities} · Warnings: {preview.summary.warningCount}</p>
        {preview.warnings.map((warning, index) => <p className="form-notice" key={`${warning.code}-${index}`}>{warning.message}</p>)}
        {confirmationBlocked && <p role="alert" className="form-notice">Confirmation is blocked until the workbook date or column layout is corrected. Fix the source headings or layout, then upload the corrected file. The original remains saved privately.</p>}
        <h3>Employee identity review</h3>
        <div className="table-wrap"><table><thead><tr><th>Source employee ID</th><th>Source name</th><th>Records</th><th>Identity match</th><th>Reason</th></tr></thead><tbody>
          {preview.matches.map((match) => <tr key={match.identityKey}><td>{match.sourceEmployeeNumber ?? 'Missing'}</td><td>{match.sourceEmployeeName ?? 'Missing'}</td><td>{match.recordCount}</td><td><select aria-label={`Match employee ${match.sourceEmployeeName ?? match.sourceEmployeeNumber ?? match.identityKey}`} value={selections[match.identityKey] ?? ''} onChange={(event) => onSelection(match.identityKey, event.target.value || null)}><option value="">Leave unmatched for review</option>{preview.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeNumber} · {employee.fullName}</option>)}</select></td><td>{match.reason}</td></tr>)}
        </tbody></table></div>
        <h3>Extracted source records</h3>
        <div className="table-wrap"><table><thead><tr>{preview.sourceType === 'ivms_pdf_original_records' ? <><th>Page / row</th><th>Person ID</th><th>Name</th><th>Department</th><th>Source time</th><th>Attendance status</th><th>Checkpoint</th><th>Other source fields</th><th>Issues</th></> : <><th>Sheet / row</th><th>Employee ID</th><th>Name</th><th>Resolved date</th><th>Source date heading</th><th>IN</th><th>OUT</th><th>Issues</th></>}</tr></thead><tbody>
          {preview.records.slice(0, 100).map((record) => 'sourcePage' in record ? <tr key={record.sourceIndex}><td>{record.sourcePage} / {record.sourceRow}</td><td>{record.employeeNumber ?? '—'}</td><td>{record.employeeName ?? '—'}</td><td>{record.department ?? '—'}</td><td>{record.sourceTimestamp}</td><td>{record.attendanceStatus ?? '—'}</td><td>{record.checkpoint ?? '—'}</td><td>{Object.entries(record.fields).filter(([key]) => !['personId', 'name', 'department', 'time', 'attendanceStatus', 'attendanceCheckPoint'].includes(key)).map(([key, value]) => `${key}: ${value ?? '—'}`).join(' · ') || '—'}</td><td>{record.warnings.map((warning) => warning.code).join(', ') || '—'}</td></tr> : <tr key={record.sourceIndex}><td>{record.sourceSheet} / {record.sourceRow}</td><td>{record.employeeNumber ?? '—'}</td><td>{record.employeeName ?? '—'}</td><td>{record.normalizedWorkDate ?? 'Unresolved'}</td><td>{record.sourceWorkDate || '—'}</td><td>{record.sourceIn ?? '—'}</td><td>{record.sourceOut ?? '—'}</td><td>{record.warnings.map((warning) => warning.code).join(', ') || '—'}</td></tr>)}
        </tbody></table></div>
        {preview.records.length > 100 && <p className="subtitle">Showing the first 100 of {preview.records.length} extracted records. All records are retained for confirmation.</p>}
        {importState === 'completed' ? <p role="status" className="form-notice">{summary?.message}</p> : <div className="heading-actions"><button className="button primary" onClick={onConfirm} disabled={importState !== 'previewed' || confirmationBlocked}><FileCheck2 /> Confirm and save import</button></div>}
      </section>
    </>}
    {!preview && <div className="steps">{['Validate', 'Extract and preview', 'Process and save'].map((label, index) => <div key={label} className={`step ${activeStep >= index + 1 ? 'active' : ''}`}><b>{index + 1}</b><span>{label}</span></div>)}</div>}
    <ImportHistory refreshKey={`${importState}:${summary?.message ?? ''}`} onResume={onResume} />
  </section>
}

function ImportHistory({ refreshKey, onResume }: { refreshKey: string; onResume: (importId: string) => void }) {
  const [imports, setImports] = useState<ImportHistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setLoading(true)
    fetch('/api/import', { cache: 'no-store' })
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error ?? 'Import history could not be loaded.')
        if (current) { setImports(result.imports); setError(null) }
      })
      .catch((issue) => { if (current) setError(issue instanceof Error ? issue.message : 'Import history could not be loaded.') })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [refreshKey])

  return <section className="panel import-history">
    <div className="panel-heading"><div><h2>Uploaded original files</h2><p>Private source files remain available here, including files that still need review or retry.</p></div><a className="button secondary small" href="/api/import?format=xlsx" download title="Download an Excel workbook of uploaded source files"><ArrowDownToLine /> Export import log</a></div>
    {error && <p role="alert" className="form-notice">{error}</p>}
    {loading ? <p className="subtitle">Loading import history…</p> : imports.length === 0 ? <p className="subtitle">No files have been uploaded yet.</p> : <div className="table-wrap"><table><thead><tr><th>Original file</th><th>Type</th><th>Uploaded</th><th>Size</th><th>Processing status</th><th>File</th></tr></thead><tbody>
      {imports.map((item) => <tr key={item.id}><td>{item.original_filename}</td><td>{item.source_type === 'ivms_pdf_original_records' ? 'iVMS PDF' : 'Attendance XLSX'}</td><td>{new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Kigali' }).format(new Date(item.uploaded_at))}</td><td>{formatFileSize(item.file_size_bytes)}</td><td><span className={`import-status ${item.processing_status}`}>{item.processing_status.replaceAll('_', ' ')}</span></td><td className="heading-actions"><a className="button secondary small" href={`/api/import/${item.id}/download`}><ArrowDownToLine /> Download original</a>{['parsed', 'needs_review', 'completed', 'failed'].includes(item.processing_status) && <button className="button secondary small" type="button" onClick={() => onResume(item.id)}>Resume / check</button>}</td></tr>)}
    </tbody></table></div>}
  </section>
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
function RecordsView({ query, setQuery }: { query: string; setQuery: (value: string) => void }) { const normalizedQuery = useMemo(() => query.trim().toLowerCase(), [query]); return <section className="panel records-page"><div className="filters"><div className="search-field"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search persisted employees or IDs" /></div><button className="filter-button"><SlidersHorizontal /> Filters <ChevronDown /></button><button className="button secondary"><CalendarDays /> This week</button></div><div className="table-meta"><span>{normalizedQuery ? '0 matching persisted records' : '0 persisted records'}</span></div><EmptyState icon={CalendarDays} title="No attendance records available" description="Import and process an attendance file to populate this register." /></section> }
function EmployeeView({ draft, setDraft, saved, onSave }: { draft: { id: string; name: string; department: string }; setDraft: (draft: { id: string; name: string; department: string }) => void; saved: boolean; onSave: () => void }) { const valid = draft.id.trim() && draft.name.trim() && draft.department.trim(); return <section className="form-grid"><section className="panel form-card"><div className="panel-heading"><div><h2>Register employee</h2><p>Create a draft employee record for backend persistence later.</p></div><Users className="heading-icon" /></div><label className="field-label">Employee ID<input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="e.g. EMP-001" /></label><label className="field-label">Full name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Employee name" /></label><label className="field-label">Department<input value={draft.department} onChange={(event) => setDraft({ ...draft, department: event.target.value })} placeholder="Department" /></label><button className="button primary" disabled={!valid} onClick={onSave}>Save employee draft</button>{saved && <p className="form-notice">Draft captured locally only. No database is connected, so it has not been saved.</p>}</section><section className="panel"><EmptyState icon={Users} title="No persisted employees" description="Registered employees will appear here after the backend is connected." /></section></section> }
function ReportsView({ exportAction }: { exportAction: { current: (() => void) | null } }) {
  const initialWeek = useMemo(() => currentKigaliWeek(), [])
  const [weekStart, setWeekStart] = useState(initialWeek.from)
  const [importId, setImportId] = useState('')
  const [imports, setImports] = useState<ImportHistoryRow[]>([])
  const [importsError, setImportsError] = useState<string | null>(null)
  const [format, setFormat] = useState<'pdf' | 'xlsx'>('pdf')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [download, setDownload] = useState<{ url: string; filename: string; generatedAt: string; message: string } | null>(null)
  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url) }, [download])
  const weekEnd = addDays(weekStart, 6)
  const validWeek = Boolean(weekStart) && new Date(`${weekStart}T00:00:00Z`).getUTCDay() === 1

  useEffect(() => {
    let current = true
    fetch('/api/import', { cache: 'no-store' })
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error ?? 'Processed imports could not be loaded.')
        if (current) { setImports(result.imports ?? []); setImportsError(null) }
      })
      .catch((issue) => { if (current) setImportsError(issue instanceof Error ? issue.message : 'Processed imports could not be loaded.') })
    return () => { current = false }
  }, [])

  async function generate() {
    if (!validWeek || !importId) return
    setGenerating(true)
    setError(null)
    try {
      const response = await fetch(`/api/reports/weekly?importId=${encodeURIComponent(importId)}&from=${encodeURIComponent(weekStart)}&to=${encodeURIComponent(weekEnd)}&format=${format}`, { cache: 'no-store' })
      if (!response.ok) {
        const result = await response.json().catch(() => null)
        throw new Error(result?.error ?? 'The report could not be generated.')
      }
      const blob = await response.blob()
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      const signature = new Uint8Array(await blob.slice(0, format === 'pdf' ? 5 : 4).arrayBuffer())
      const isValidFile = format === 'pdf'
        ? contentType.includes('application/pdf') && new TextDecoder().decode(signature) === '%PDF-'
        : contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') && signature[0] === 0x50 && signature[1] === 0x4b
      if (!isValidFile) throw new Error(`The server response was not a valid ${format === 'pdf' ? 'PDF' : 'Excel workbook'}. No file was downloaded; retry or contact support if this persists.`)
      const url = URL.createObjectURL(blob)
      const filename = `MMRJD-weekly-attendance-${weekStart}-to-${weekEnd}.${format}`
      const sourceRecords = Number(response.headers.get('X-Report-Source-Records') ?? '0')
      const employees = Number(response.headers.get('X-Report-Employees') ?? '0')
      const calculatedDays = Number(response.headers.get('X-Report-Calculated-Days') ?? '0')
      const exceptions = Number(response.headers.get('X-Report-Exceptions') ?? '0')
      const validation = response.headers.get('X-Report-Validation') ?? 'requires_review'
      const validationLabel = validation === 'ready_for_export' ? 'Ready for export' : validation === 'ready_with_disclosed_issues' ? 'Ready with disclosed issues' : 'Requires review'
      const contents = sourceRecords === 0
        ? 'No attendance records from the selected import fall within this reporting week. An explicitly empty report was generated.'
        : `${sourceRecords} source records, ${employees} matched employees, and ${calculatedDays} calculated employee-days included.`
      const message = `${validationLabel} · ${exceptions} review exceptions · ${contents}`
      setDownload({ url, filename, generatedAt: new Date().toISOString(), message })
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'The report could not be generated.')
    } finally {
      setGenerating(false)
    }
  }

  useEffect(() => {
    exportAction.current = () => { void generate() }
    return () => { exportAction.current = null }
  }, [weekStart, format, importId])

  return <section className="reports-grid">
    <section className="panel report-builder">
      <div className="panel-heading"><div><h2>Prepare weekly report</h2><p>Generate from confirmed attendance evidence and current persisted calculations.</p></div><FileBarChart className="heading-icon" /></div>
      {importsError && <p role="alert" className="form-notice">{importsError}</p>}
      <label className="field-label">Attendance import<select value={importId} onChange={(event) => setImportId(event.target.value)}><option value="">Select a processed import</option>{imports.map((item) => <option key={item.id} value={item.id} disabled={!['completed', 'needs_review'].includes(item.processing_status)}>{item.original_filename} · {item.source_type === 'ivms_pdf_original_records' ? 'iVMS PDF' : 'Attendance XLSX'} · {item.processing_status.replaceAll('_', ' ')}</option>)}</select></label>
      <p className="subtitle">The report uses only the selected import. Uploaded or failed files must be processed before they can be reported.</p>
      <label className="field-label">Week starting Monday<input type="date" value={weekStart} onChange={(event) => setWeekStart(event.target.value)} /></label>
      <p className="subtitle">Reporting period: {weekStart || '—'} to {weekEnd || '—'} (Africa/Kigali)</p>
      {!validWeek && <p role="alert" className="form-notice">Choose a Monday to generate a complete Monday-to-Sunday report.</p>}
      <label className="field-label">Format<select value={format} onChange={(event) => setFormat(event.target.value as 'pdf' | 'xlsx')}><option value="pdf">PDF</option><option value="xlsx">Excel workbook</option></select></label>
      <button className="button primary" onClick={generate} disabled={!validWeek || !importId || generating}>{generating ? 'Generating report…' : <><FileText /> Download {format === 'pdf' ? 'PDF' : 'Excel'} report</>}</button>
      {error && <p role="alert" className="form-notice">{error}</p>}
      {download && <p role="status" className="form-notice">Report generated: {download.message} <a href={download.url} download={download.filename}>Download again: {download.filename}</a> · {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Kigali' }).format(new Date(download.generatedAt))} (Africa/Kigali)</p>}
      <p className="subtitle">Days without imported records are not classified as absences. Fingerprint events remain direction-unknown. Stale calculations are shown as requiring review.</p>
    </section>
    <section className="panel"><div className="panel-heading"><div><h2>Report contents</h2><p>Both formats use the same persisted report dataset and include provenance.</p></div><FileCheck2 className="heading-icon" /></div>
      <ul><li>Weekly employee attendance and supported totals</li><li>Review exceptions and source fingerprint evidence</li><li>Report period, generation ID, timezone, rule version and source import references</li></ul>
    </section>
  </section>
}

function currentKigaliWeek() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const time = Date.parse(`${today}T00:00:00Z`)
  const day = new Date(time).getUTCDay()
  const monday = new Date(time - ((day + 6) % 7) * 86_400_000).toISOString().slice(0, 10)
  return { from: monday }
}

function addDays(value: string, days: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return ''
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}
function kigaliToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function weekendSetting(rule: AttendanceRuleRecord | undefined): { mode: string; days: Array<'Saturday' | 'Sunday'> } {
  if (!rule || !rule.policy || typeof rule.policy !== 'object' || !('weekendOvertimeDays' in rule.policy)) return { mode: 'unconfigured', days: [] }
  const days = (rule.policy as { weekendOvertimeDays?: unknown }).weekendOvertimeDays
  if (!Array.isArray(days)) return { mode: 'unconfigured', days: [] }
  const validDays = days.filter((day): day is 'Saturday' | 'Sunday' => day === 'Saturday' || day === 'Sunday')
  return { mode: validDays.length ? 'configured' : 'none', days: validDays }
}

function SettingsView() {
  const today = useMemo(kigaliToday, [])
  const [rules, setRules] = useState<AttendanceRuleRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [form, setForm] = useState<{
    normalStart: string
    graceUntil: string
    veryLateFrom: string
    scheduledEnd: string
    overtimeFrom: string
    effectiveFrom: string
    reason: string
    weekendMode: string
    weekendDays: Array<'Saturday' | 'Sunday'>
  }>({
    normalStart: DEFAULT_ATTENDANCE_RULES.normalStart,
    graceUntil: DEFAULT_ATTENDANCE_RULES.graceUntil,
    veryLateFrom: DEFAULT_ATTENDANCE_RULES.veryLateFrom,
    scheduledEnd: DEFAULT_ATTENDANCE_RULES.scheduledEnd,
    overtimeFrom: DEFAULT_ATTENDANCE_RULES.overtimeFrom,
    effectiveFrom: today,
    reason: '',
    weekendMode: 'unconfigured',
    weekendDays: [] as Array<'Saturday' | 'Sunday'>,
  })

  useEffect(() => {
    let active = true
    fetch('/api/settings/attendance-rules', { cache: 'no-store' })
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error ?? 'Attendance settings could not be loaded.')
        if (!active) return
        const records = (result.rules ?? []) as AttendanceRuleRecord[]
        setRules(records)
        const current = records.filter((rule) => rule.effective_from <= today).sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.version - a.version)[0]
        if (current) {
          const weekend = weekendSetting(current)
          setForm((value) => ({
            ...value,
            normalStart: current.normal_start.slice(0, 5),
            graceUntil: current.grace_until.slice(0, 5),
            veryLateFrom: current.very_late_from.slice(0, 5),
            scheduledEnd: current.scheduled_end.slice(0, 5),
            overtimeFrom: current.overtime_from.slice(0, 5),
            weekendMode: weekend.mode,
            weekendDays: weekend.days,
          }))
        }
        setError(null)
      })
      .catch((issue) => { if (active) setError(issue instanceof Error ? issue.message : 'Attendance settings could not be loaded.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [today])

  const activeRule = rules.filter((rule) => rule.effective_from <= today).sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.version - a.version)[0]
  const pendingRules = rules.filter((rule) => rule.effective_from > today).sort((a, b) => a.effective_from.localeCompare(b.effective_from))

  async function saveRules(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    setNotice(null)
    const weekendOvertimeDays = form.weekendMode === 'unconfigured' ? null : form.weekendMode === 'none' ? [] : form.weekendDays
    try {
      const response = await fetch('/api/settings/attendance-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          normalStart: form.normalStart,
          graceUntil: form.graceUntil,
          veryLateFrom: form.veryLateFrom,
          scheduledEnd: form.scheduledEnd,
          overtimeFrom: form.overtimeFrom,
          effectiveFrom: form.effectiveFrom,
          reason: form.reason,
          weekendOvertimeDays,
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'The new attendance rule version could not be saved.')
      const saved = result.rule as AttendanceRuleRecord
      setRules((previous) => [saved, ...previous.filter((rule) => rule.id !== saved.id)])
      setForm((value) => ({ ...value, reason: '' }))
      setNotice(`Rule version ${saved.version} saved. It takes effect ${saved.effective_from}; earlier versions remain in the audit history.`)
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'The new attendance rule version could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const changeTime = (key: 'normalStart' | 'graceUntil' | 'veryLateFrom' | 'scheduledEnd' | 'overtimeFrom', value: string) => setForm((current) => ({ ...current, [key]: value }))
  const toggleWeekend = (day: 'Saturday' | 'Sunday') => setForm((current) => ({
    ...current,
    weekendMode: 'configured',
    weekendDays: current.weekendDays.includes(day) ? current.weekendDays.filter((item) => item !== day) : [...current.weekendDays, day],
  }))
  const orderedTimes = [form.normalStart, form.graceUntil, form.veryLateFrom, form.scheduledEnd, form.overtimeFrom].map((value) => {
    const [hour, minute] = value.split(':').map(Number)
    return hour * 60 + minute
  })
  const timesValid = orderedTimes.every((value) => Number.isFinite(value)) && orderedTimes.every((value, index) => index === 0 || orderedTimes[index - 1] < value)

  return <section className="settings-grid">
    <section className="panel settings-card">
      <div className="panel-heading"><div><h2>Attendance rules</h2><p>Each save creates an auditable rule version used by future processing.</p></div><SlidersHorizontal className="heading-icon" /></div>
      {loading && <p className="form-notice">Loading saved attendance rules…</p>}
      {error && <p role="alert" className="form-notice">{error}</p>}
      {!loading && !activeRule && !error && <p className="form-notice">No attendance rule version is effective today. These values are defaults for the form only. Save a version before expecting imports to create calculated attendance.</p>}
      {activeRule && <p className="form-notice">Active rule version {activeRule.version}, effective {activeRule.effective_from}. Updates are appended as new versions.</p>}
      <form className="settings-card" onSubmit={saveRules}>
        {([
          ['normalStart', 'Normal working start'],
          ['graceUntil', 'Late threshold'],
          ['veryLateFrom', 'Very late threshold'],
          ['scheduledEnd', 'Scheduled working end'],
          ['overtimeFrom', 'Overtime threshold'],
        ] as const).map(([key, label]) => <label className="field-label" key={key}>{label}<input type="time" step={60} required value={form[key]} onChange={(event) => changeTime(key, event.target.value)} /></label>)}
        <label className="field-label">Effective from<input type="date" required value={form.effectiveFrom} onChange={(event) => setForm((current) => ({ ...current, effectiveFrom: event.target.value }))} /></label>
        <label className="field-label">Reason for this rule version<input required minLength={5} maxLength={500} value={form.reason} onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))} placeholder="For example: HR approved the revised weekly attendance policy" /></label>
        <label className="field-label">Weekend overtime policy<select value={form.weekendMode} onChange={(event) => setForm((current) => ({ ...current, weekendMode: event.target.value, weekendDays: event.target.value === 'configured' ? current.weekendDays : [] }))}><option value="unconfigured">Not configured (requires review)</option><option value="none">No weekend overtime</option><option value="configured">Overtime applies on selected days</option></select></label>
        {form.weekendMode === 'configured' && <div className="report-options"><label><input type="checkbox" checked={form.weekendDays.includes('Saturday')} onChange={() => toggleWeekend('Saturday')} />Saturday</label><label><input type="checkbox" checked={form.weekendDays.includes('Sunday')} onChange={() => toggleWeekend('Sunday')} />Sunday</label></div>}
        <button className="button primary" type="submit" disabled={loading || saving || !timesValid || form.reason.trim().length < 5 || (form.weekendMode === 'configured' && form.weekendDays.length === 0)}>{saving ? 'Saving rule version…' : 'Save new rule version'}</button>
      </form>
      {notice && <p role="status" className="form-notice">{notice}</p>}
      {pendingRules.length > 0 && <div><h3>Scheduled versions</h3>{pendingRules.map((rule) => <p className="subtitle" key={rule.id}>Version {rule.version} · effective {rule.effective_from} · {rule.reason}</p>)}</div>}
      {rules.length > 0 && <div><h3>Recent rule history</h3>{rules.slice(0, 5).map((rule) => <p className="subtitle" key={rule.id}>Version {rule.version} · {rule.effective_from} · {rule.normal_start.slice(0, 5)} / {rule.grace_until.slice(0, 5)} / {rule.very_late_from.slice(0, 5)} / {rule.scheduled_end.slice(0, 5)} / {rule.overtime_from.slice(0, 5)} · {rule.reason}</p>)}</div>}
    </section>
    <section className="panel settings-card">
      <div className="panel-heading"><div><h2>Organization and access</h2><p>System settings currently defined for this workspace.</p></div><Settings className="heading-icon" /></div>
      <div className="setting-row"><span><strong>Organization timezone</strong><small>Attendance dates and event grouping use this timezone.</small></span><strong>Africa/Kigali</strong></div>
      <div className="setting-row"><span><strong>Application access</strong><small>Protected by Supabase Auth and administrator profile checks.</small></span><strong>Administrator</strong></div>
      <div className="setting-row"><span><strong>Original attendance files</strong><small>Source imports are stored in the private attendance-originals bucket.</small></span><strong>Private</strong></div>
      <p className="form-notice">These organization and access values are managed by the application configuration. They are shown here for reference and are not editable on this page.</p>
    </section>
  </section>
}
