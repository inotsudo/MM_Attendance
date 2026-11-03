'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileCheck2, Fingerprint, Search, ShieldCheck } from 'lucide-react'

type ImportOption = { id: string; original_filename: string; source_type: string; processing_status: string }
type ReviewSource = { evidenceId?: string; file?: string; kind?: string; employeeId?: string | null; employeeName?: string | null; date?: string | null; time?: string | null; originalTime?: string | null; in?: string | null; out?: string | null; page?: number | null; sheet?: string | null; row?: number | null }
type Proposal = { id: string; affected_field: string; previous_value: Record<string, unknown>; proposed_value: Record<string, unknown>; explanation: string; confidence: number; status: string; application_error: string | null; decision_note: string | null }
type Finding = {
  id: string; employee_number: string | null; employee_name: string | null; attendance_date: string | null
  category: string; evidence_class: 'confirmed_inconsistency' | 'potential_inconsistency' | 'insufficient_evidence'
  title: string; explanation: string; current_values: Record<string, unknown>; source_references: { records?: ReviewSource[] }
  status: string; proposal: Proposal | null; rule: { version: number; attendance_timezone: string; normal_start: string; grace_until: string; very_late_from: string; scheduled_end: string; overtime_from: string } | null
  previousCorrections: Array<{ reason: string; corrected_at: string; correction_type: string }>
  decisions: Array<{ action: string; reason: string; created_at: string }>
}
type Summary = { recordsAnalyzed: number; confirmedInconsistencies: number; potentialInconsistencies: number; insufficientEvidence: number; pendingApprovals: number; approvedCorrections: number; rejectedProposals: number; unresolvedInvestigations: number }

const evidenceLabels = {
  confirmed_inconsistency: 'Confirmed issue',
  potential_inconsistency: 'Check evidence',
  insufficient_evidence: 'More evidence needed',
}

export function IntelligentReview() {
  const [imports, setImports] = useState<ImportOption[]>([])
  const [importId, setImportId] = useState('')
  const [findings, setFindings] = useState<Finding[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [search, setSearch] = useState('')
  const [classFilter, setClassFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [busyFinding, setBusyFinding] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [page, setPage] = useState({ offset: 0, limit: 50, hasMore: false })

  useEffect(() => {
    let active = true
    fetch('/api/import', { cache: 'no-store' }).then(async (response) => {
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Uploaded files could not be loaded.')
      if (active) {
        const available = (result.imports ?? []).filter((item: ImportOption) => ['completed', 'needs_review'].includes(item.processing_status))
        setImports(available)
        setImportId((current) => current || available[0]?.id || '')
      }
    }).catch((issue) => { if (active) setError(issue instanceof Error ? issue.message : 'Uploaded files could not be loaded.') })
    return () => { active = false }
  }, [])

  async function loadFindings(selectedImportId: string, offset = 0, append = false) {
    if (!selectedImportId) { setFindings([]); setSummary(null); return }
    setLoading(true)
    const params = new URLSearchParams({ importId: selectedImportId, offset: String(offset), limit: '50' })
    if (classFilter) params.set('evidenceClass', classFilter)
    if (statusFilter) params.set('status', statusFilter)
    try {
      const response = await fetch(`/api/reviews/findings?${params}`, { cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Analysis findings could not be loaded.')
      setFindings((current) => append ? [...current, ...(result.findings ?? [])] : (result.findings ?? []))
      setSummary(result.summary ?? null)
      setPage(result.page ?? { offset: 0, limit: 50, hasMore: false })
      setError('')
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'Analysis findings could not be loaded.') }
    finally { setLoading(false) }
  }

  useEffect(() => { void loadFindings(importId) }, [importId, classFilter, statusFilter])

  async function runAnalysis() {
    if (!importId) return
    setAnalyzing(true); setError(''); setNotice('')
    try {
      const response = await fetch('/api/reviews/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'The attendance file could not be analyzed.')
      await loadFindings(importId)
      setNotice(`Analysis saved. ${result.summary?.findingCount ?? 0} findings and ${result.summary?.proposalCount ?? 0} evidence-based proposals were recorded.`)
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The attendance file could not be analyzed.') }
    finally { setAnalyzing(false) }
  }

  async function decide(finding: Finding, action: 'approved' | 'rejected' | 'investigation' | 'confirmed') {
    const reason = notes[finding.id]?.trim() ?? ''
    if (reason.length < 3) { setError('Add a short reason before saving this decision.'); return }
    setBusyFinding(finding.id); setError(''); setNotice('')
    try {
      const response = await fetch(`/api/reviews/findings/${finding.id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, reason }) })
      const result = await response.json()
      if (!response.ok && response.status !== 202) throw new Error(result.error ?? 'The review decision could not be saved.')
      setNotice(result.error ?? (action === 'approved' ? 'Correction approved and recalculated. Reports now use the new calculation.' : 'Decision saved to the review history.'))
      await loadFindings(importId)
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The review decision could not be saved.') }
    finally { setBusyFinding(null) }
  }

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return findings
    return findings.filter((item) => [item.employee_number, item.employee_name, item.attendance_date, item.category, item.title, item.explanation].some((value) => value?.toLowerCase().includes(term)))
  }, [findings, search])

  const selectedImport = imports.find((item) => item.id === importId)
  const cards: Array<[keyof Summary, string, string]> = [
    ['recordsAnalyzed', 'Records analyzed', 'saved source records'],
    ['confirmedInconsistencies', 'Confirmed issues', 'supported by values and rules'],
    ['potentialInconsistencies', 'Possible issues', 'need evidence review'],
    ['pendingApprovals', 'Awaiting decision', 'correction proposals'],
  ]
  const additionalCards: Array<[keyof Summary, string, string]> = [
    ['insufficientEvidence', 'Need more evidence', 'no automatic correction'],
    ['approvedCorrections', 'Corrections applied', 'new calculations saved'],
    ['rejectedProposals', 'Rejected proposals', 'kept in history'],
    ['unresolvedInvestigations', 'Investigation', 'open follow-up'],
  ]

  return <section className="panel intelligent-review">
    <div className="panel-heading"><div><h2>Attendance analysis</h2><p>The system compares saved source rows with current calculations and rules. You decide whether a correction is applied.</p></div><ShieldCheck className="heading-icon" /></div>
    {error && <p role="alert" className="form-notice">{error}</p>}{notice && <p role="status" className="form-notice">{notice}</p>}
    <div className="filters"><label className="field-label">Attendance file<select value={importId} onChange={(event) => setImportId(event.target.value)}><option value="">Choose a processed file</option>{imports.map((item) => <option key={item.id} value={item.id}>{item.original_filename} · {item.source_type === 'ivms_pdf_original_records' ? 'iVMS PDF' : 'Excel'}</option>)}</select></label><button className="button primary" disabled={!importId || analyzing} onClick={() => void runAnalysis()}>{analyzing ? 'Analyzing saved records…' : 'Analyze attendance'}</button></div>
    {selectedImport && <p className="subtitle">Analysis uses persisted records from {selectedImport.original_filename}. Source files remain unchanged.</p>}
    {summary && <><div className="overview-grid import-preview-stats">{cards.map(([key, label, caption], index) => <div className="stat-card" key={key}><div className="stat-icon">{index === 1 ? <CheckCircle2 /> : index === 2 || index === 3 ? <AlertTriangle /> : <Fingerprint />}</div><div><span>{label}</span><strong>{summary[key]}</strong><small>{caption}</small></div></div>)}</div><details className="review-secondary analysis-totals"><summary>More analysis totals</summary><div className="overview-grid import-preview-stats">{additionalCards.map(([key, label, caption]) => <div className="stat-card" key={key}><div className="stat-icon"><FileCheck2 /></div><div><span>{label}</span><strong>{summary[key]}</strong><small>{caption}</small></div></div>)}</div></details></>}
    <div className="filters"><label className="search-field"><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search employee, date, or issue" /></label><label className="field-label">Evidence<select value={classFilter} onChange={(event) => setClassFilter(event.target.value)}><option value="">All evidence levels</option><option value="confirmed_inconsistency">Confirmed issue</option><option value="potential_inconsistency">Possible issue</option><option value="insufficient_evidence">Insufficient evidence</option></select></label><label className="field-label">Decision status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All decisions</option><option value="pending">Awaiting review</option><option value="approved">Approved, applying</option><option value="investigation">Investigation</option><option value="corrected">Corrected</option><option value="rejected">Rejected</option><option value="confirmed">Confirmed, no change</option><option value="superseded">Replaced by newer analysis</option></select></label></div>
    {loading && findings.length === 0 ? <p className="subtitle">Loading saved findings…</p> : !summary ? <div className="empty-state"><div className="empty-icon"><Fingerprint /></div><h3>No analysis yet</h3><p>Choose an uploaded file and analyze its saved attendance records.</p></div> : visible.length === 0 ? <div className="empty-state"><div className="empty-icon"><CheckCircle2 /></div><h3>No findings match these filters</h3><p>Try another search or run a fresh analysis on the selected file.</p></div> : <div className="review-list">{visible.map((finding) => {
      const current = finding.current_values ?? {}
      const sources = finding.source_references?.records ?? []
      const previous = finding.proposal?.previous_value?.value ?? current.arrivalClassification ?? '—'
      const proposed = finding.proposal?.proposed_value?.value ?? 'No correction proposed'
      const final = ['rejected', 'corrected', 'superseded', 'confirmed'].includes(finding.status)
      const proposalCanApply = Boolean(finding.proposal && ['pending', 'failed', 'approved'].includes(finding.proposal.status))
      return <article className="review-card" key={finding.id}>
        <div className="review-card-heading"><strong>{finding.title}</strong><span className={`review-severity ${finding.evidence_class === 'confirmed_inconsistency' ? 'error' : finding.evidence_class === 'potential_inconsistency' ? 'warning' : 'info'}`}>{evidenceLabels[finding.evidence_class]}</span></div>
        <p>{finding.employee_name ?? 'Employee not matched'}{finding.employee_number ? ` · ${finding.employee_number}` : ''}{finding.attendance_date ? ` · ${finding.attendance_date}` : ''}</p>
        <p>{finding.explanation}</p>
        {finding.proposal && <div className="table-wrap"><table><thead><tr><th>Attendance detail</th><th>Current</th><th>Suggested</th></tr></thead><tbody><tr><td>{finding.proposal.affected_field.replaceAll('_', ' ')}</td><td>{String(previous).replaceAll('_', ' ')}</td><td>{String(proposed).replaceAll('_', ' ')}</td></tr></tbody></table><details className="review-evidence"><summary>Why this change is suggested</summary><p className="subtitle">{finding.proposal.explanation} · Evidence confidence {Math.round(finding.proposal.confidence * 100)}%.</p></details></div>}
        {finding.rule && <details className="review-evidence"><summary>Attendance rule used</summary><p className="review-source">Version {finding.rule.version} · {finding.rule.attendance_timezone} · Normal start {finding.rule.normal_start} · Late {finding.rule.grace_until} · Very late {finding.rule.very_late_from} · Overtime {finding.rule.overtime_from}</p></details>}
        <details className="review-evidence"><summary>Source evidence ({sources.length})</summary>{sources.map((source, index) => <p className="review-source" key={source.evidenceId ?? index}><strong>{source.kind ?? 'Source'}:</strong> {source.file ?? 'Source file'} · {source.employeeName ?? source.employeeId ?? 'Unmatched'}{source.date ? ` · ${source.date}` : ''}{source.time ? ` · ${source.time}` : ''}{source.in ? ` · IN ${source.in}` : ''}{source.out ? ` · OUT ${source.out}` : ''}{source.page ? ` · page ${source.page}` : ''}{source.sheet ? ` · ${source.sheet}` : ''}{source.row ? ` · row ${source.row}` : ''}</p>)}</details>
        {finding.previousCorrections.length > 0 && <details className="review-evidence"><summary>Previous correction history ({finding.previousCorrections.length})</summary>{finding.previousCorrections.map((correction, index) => <p className="review-source" key={`${correction.corrected_at}-${index}`}>{correction.correction_type.replaceAll('_', ' ')} · {correction.reason} · {new Date(correction.corrected_at).toLocaleString()}</p>)}</details>}
        {finding.decisions.length > 0 && <details className="review-evidence"><summary>Decision history ({finding.decisions.length})</summary>{finding.decisions.map((decision) => <p className="review-source" key={`${decision.created_at}-${decision.action}`}>{decision.action.replaceAll('_', ' ')} · {decision.reason} · {new Date(decision.created_at).toLocaleString()}</p>)}</details>}
        {!final && <><label className="field-label">Decision note (required)<textarea rows={2} value={notes[finding.id] ?? ''} onChange={(event) => setNotes((currentNotes) => ({ ...currentNotes, [finding.id]: event.target.value }))} placeholder="Briefly explain your decision" /></label><div className="heading-actions">{proposalCanApply && <button className="button primary" disabled={busyFinding === finding.id} onClick={() => void decide(finding, 'approved')}>{busyFinding === finding.id ? 'Applying…' : finding.proposal?.status === 'failed' || finding.proposal?.status === 'approved' ? 'Retry correction' : 'Approve correction'}</button>}<details className="review-action-menu"><summary>Other decisions</summary><div><button className="button secondary" disabled={busyFinding === finding.id} onClick={() => void decide(finding, 'investigation')}>Investigate</button><button className="button secondary" disabled={busyFinding === finding.id} onClick={() => void decide(finding, 'confirmed')}>Confirm, no change</button><button className="button secondary" disabled={busyFinding === finding.id} onClick={() => void decide(finding, 'rejected')}>Reject finding</button></div></details></div></>}
        {finding.status === 'approved' && finding.proposal?.application_error && <p role="alert" className="form-notice">Approval is recorded. Recalculation failed: {finding.proposal.application_error}</p>}
        {finding.status === 'corrected' && <p className="form-notice">Correction applied. The official report now uses the new calculation version.</p>}
      </article>
    })}</div>}
    {page.hasMore && <button className="button secondary" disabled={loading} onClick={() => void loadFindings(importId, findings.length, true)}>Load more findings</button>}
  </section>
}
