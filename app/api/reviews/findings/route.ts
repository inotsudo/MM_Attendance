import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'

function integerParam(value: string | null, fallback: number) {
  return value && /^\d+$/.test(value) ? Number(value) : fallback
}

export async function GET(request: Request) {
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const query = new URL(request.url).searchParams
  const importId = query.get('importId')
  const requestedRunId = query.get('runId')
  const offset = Math.min(1_000_000, integerParam(query.get('offset'), 0))
  const limit = Math.min(100, Math.max(1, integerParam(query.get('limit'), 50)))
  const supabase = await createSupabaseServerClient()
  let runQuery = supabase.from('attendance_analysis_runs').select('id, import_id, status, period_from, period_to, source_record_count, summary, started_at, completed_at').order('started_at', { ascending: false }).limit(1)
  if (requestedRunId) runQuery = supabase.from('attendance_analysis_runs').select('id, import_id, status, period_from, period_to, source_record_count, summary, started_at, completed_at').eq('id', requestedRunId).limit(1)
  else if (importId) runQuery = runQuery.eq('import_id', importId)
  const { data: runs, error: runError } = await runQuery
  if (runError) return NextResponse.json({ error: 'Attendance analysis history could not be loaded.' }, { status: 500 })
  const run = runs?.[0]
  if (!run) return NextResponse.json({ run: null, findings: [], page: { offset, limit, hasMore: false }, summary: null })

  let findingsQuery = supabase.from('attendance_review_findings')
    .select('id, analysis_run_id, import_id, employee_id, employee_number, employee_name, attendance_date, category, evidence_class, title, explanation, current_values, source_references, rules_version_id, calculation_id, status, decision_note, decided_by, decided_at, created_at')
    .eq('analysis_run_id', run.id).order('created_at', { ascending: false })
  const evidenceClass = query.get('evidenceClass')
  const status = query.get('status')
  if (['confirmed_inconsistency', 'potential_inconsistency', 'insufficient_evidence'].includes(evidenceClass ?? '')) findingsQuery = findingsQuery.eq('evidence_class', evidenceClass as 'confirmed_inconsistency' | 'potential_inconsistency' | 'insufficient_evidence')
  if (['pending', 'confirmed', 'rejected', 'investigation', 'approved', 'corrected', 'unresolved'].includes(status ?? '')) findingsQuery = findingsQuery.eq('status', status!)
  const { data: fetched, error } = await findingsQuery.range(offset, offset + limit)
  if (error) return NextResponse.json({ error: 'Attendance findings could not be loaded.' }, { status: 500 })
  const [confirmed, potential, insufficient, pendingApprovals, approved, rejected, investigations] = await Promise.all([
    supabase.from('attendance_review_findings').select('id', { count: 'exact', head: true }).eq('analysis_run_id', run.id).eq('evidence_class', 'confirmed_inconsistency'),
    supabase.from('attendance_review_findings').select('id', { count: 'exact', head: true }).eq('analysis_run_id', run.id).eq('evidence_class', 'potential_inconsistency'),
    supabase.from('attendance_review_findings').select('id', { count: 'exact', head: true }).eq('analysis_run_id', run.id).eq('evidence_class', 'insufficient_evidence'),
    supabase.from('attendance_correction_proposals').select('id', { count: 'exact', head: true }).eq('import_id', run.import_id).eq('status', 'pending'),
    supabase.from('attendance_correction_proposals').select('id', { count: 'exact', head: true }).eq('import_id', run.import_id).eq('status', 'applied'),
    supabase.from('attendance_correction_proposals').select('id', { count: 'exact', head: true }).eq('import_id', run.import_id).eq('status', 'rejected'),
    supabase.from('attendance_review_findings').select('id', { count: 'exact', head: true }).eq('analysis_run_id', run.id).in('status', ['investigation', 'unresolved', 'approved']),
  ])
  if ([confirmed, potential, insufficient, pendingApprovals, approved, rejected, investigations].some((result) => result.error)) return NextResponse.json({ error: 'Analysis overview could not be calculated.' }, { status: 500 })
  const pageRows = (fetched ?? []).slice(0, limit)
  const hasMore = (fetched ?? []).length > limit
  const findingIds = pageRows.map((row) => row.id)
  const calculationIds = [...new Set(pageRows.flatMap((row) => row.calculation_id ? [row.calculation_id] : []))]
  const ruleIds = [...new Set(pageRows.flatMap((row) => row.rules_version_id ? [row.rules_version_id] : []))]
  const [proposals, decisions, corrections, rules] = await Promise.all([
    findingIds.length ? supabase.from('attendance_correction_proposals').select('id, finding_id, affected_field, previous_value, proposed_value, proposed_calculation, explanation, confidence, status, generated_at, decided_by, decided_at, decision_note, application_error, resulting_calculation_id').in('finding_id', findingIds) : Promise.resolve({ data: [], error: null }),
    findingIds.length ? supabase.from('attendance_review_decisions').select('id, finding_id, proposal_id, action, reason, actor_user_id, created_at, details').in('finding_id', findingIds).order('created_at', { ascending: false }) : Promise.resolve({ data: [], error: null }),
    calculationIds.length ? supabase.from('attendance_corrections').select('id, daily_calculation_id, correction_type, previous_values, corrected_values, reason, corrected_at, proposal_id').in('daily_calculation_id', calculationIds).order('corrected_at', { ascending: false }) : Promise.resolve({ data: [], error: null }),
    ruleIds.length ? supabase.from('attendance_rule_versions').select('id, version, attendance_timezone, normal_start, grace_until, very_late_from, scheduled_end, overtime_from').in('id', ruleIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (proposals.error || decisions.error || corrections.error || rules.error) return NextResponse.json({ error: 'Finding evidence or decision history could not be loaded.' }, { status: 500 })
  const proposalByFinding = new Map((proposals.data ?? []).map((proposal) => [proposal.finding_id, proposal]))
  const rulesById = new Map((rules.data ?? []).map((rule) => [rule.id, rule]))
  return NextResponse.json({
    run,
    summary: {
      recordsAnalyzed: run.source_record_count,
      confirmedInconsistencies: confirmed.count ?? 0,
      potentialInconsistencies: potential.count ?? 0,
      insufficientEvidence: insufficient.count ?? 0,
      pendingApprovals: pendingApprovals.count ?? 0,
      approvedCorrections: approved.count ?? 0,
      rejectedProposals: rejected.count ?? 0,
      unresolvedInvestigations: investigations.count ?? 0,
    },
    findings: pageRows.map((finding) => ({
      ...finding,
      proposal: proposalByFinding.get(finding.id) ?? null,
      rule: finding.rules_version_id ? rulesById.get(finding.rules_version_id) ?? null : null,
      previousCorrections: (corrections.data ?? []).filter((correction) => correction.daily_calculation_id === finding.calculation_id),
      decisions: (decisions.data ?? []).filter((decision) => decision.finding_id === finding.id),
    })),
    page: { offset, limit, hasMore },
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}
