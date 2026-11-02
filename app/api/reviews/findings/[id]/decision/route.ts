import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'

const actions = ['approved', 'rejected', 'investigation', 'confirmed'] as const

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const { id } = await context.params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'The finding ID is invalid.' }, { status: 400 })
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Choose a review decision and provide a reason.' }, { status: 400 }) }
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const action = input.action
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (typeof action !== 'string' || !actions.includes(action as typeof actions[number])) return NextResponse.json({ error: 'Choose approve, reject, investigate, or confirm.' }, { status: 400 })
  if (reason.length < 3 || reason.length > 1000) return NextResponse.json({ error: 'Enter a reason of 3 to 1000 characters.' }, { status: 400 })

  const supabase = await createSupabaseServerClient()
  const { data: decision, error: decisionError } = await supabase.rpc('decide_attendance_finding', {
    p_finding_id: id, p_action: action, p_reason: reason,
  })
  if (decisionError) return NextResponse.json({ error: decisionError.message || 'The decision could not be saved.' }, { status: 422 })
  if (action !== 'approved') return NextResponse.json({ decision }, { headers: { 'Cache-Control': 'private, no-store' } })

  const { data: proposal, error: proposalError } = await supabase.from('attendance_correction_proposals').select('id').eq('finding_id', id).maybeSingle()
  if (proposalError || !proposal) return NextResponse.json({ error: 'Approval was saved, but its proposal could not be queued for recalculation.' }, { status: 202 })
  const { data: applied, error: applicationError } = await supabase.rpc('apply_attendance_correction_proposal', { p_proposal_id: proposal.id })
  if (applicationError) {
    const { error: recordFailureError } = await supabase.rpc('mark_attendance_proposal_application_failed', { p_proposal_id: proposal.id, p_error: applicationError.message })
    return NextResponse.json({
      error: 'Approval was saved, but recalculation did not complete. The existing report calculation remains active; retry this proposal after resolving the issue.',
      applicationStatus: recordFailureError ? 'approved_retry_required' : 'failed',
    }, { status: 202, headers: { 'Cache-Control': 'private, no-store' } })
  }
  return NextResponse.json({ decision, application: applied }, { headers: { 'Cache-Control': 'private, no-store' } })
}
