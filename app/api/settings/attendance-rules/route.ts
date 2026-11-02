import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

const TIME_FIELDS = ['normalStart', 'graceUntil', 'veryLateFrom', 'scheduledEnd', 'overtimeFrom'] as const
type TimeField = (typeof TIME_FIELDS)[number]

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function timeMinutes(value: string) {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export async function GET() {
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.from('attendance_rule_versions')
    .select('id, version, attendance_timezone, effective_from, normal_start, grace_until, very_late_from, scheduled_end, overtime_from, policy, reason, created_at')
    .order('effective_from', { ascending: false })
    .order('version', { ascending: false })
    .limit(50)
  if (error) return NextResponse.json({ error: 'Attendance rule versions could not be loaded. Check that the foundation migration is applied.' }, { status: 503 })
  return NextResponse.json({ rules: data ?? [] }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: Request) {
  const administrator = await getAdministratorProfile()
  if (!administrator) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await request.json() as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Send valid JSON rule settings.' }, { status: 400 })
  }

  const times = {} as Record<TimeField, string>
  for (const field of TIME_FIELDS) {
    if (!validTime(body[field])) return NextResponse.json({ error: `Enter ${field} as a valid 24-hour time.` }, { status: 400 })
    times[field] = body[field]
  }
  if (!(timeMinutes(times.normalStart) < timeMinutes(times.graceUntil)
    && timeMinutes(times.graceUntil) < timeMinutes(times.veryLateFrom)
    && timeMinutes(times.veryLateFrom) <= timeMinutes(times.scheduledEnd)
    && timeMinutes(times.scheduledEnd) < timeMinutes(times.overtimeFrom))) {
    return NextResponse.json({ error: 'Times must be ordered: normal start, late threshold, very late threshold, scheduled end, then overtime threshold.' }, { status: 400 })
  }
  if (!validDate(body.effectiveFrom)) return NextResponse.json({ error: 'Choose a valid effective date.' }, { status: 400 })
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length < 5 || reason.length > 500) return NextResponse.json({ error: 'Enter a reason between 5 and 500 characters for this new rule version.' }, { status: 400 })
  const weekends = body.weekendOvertimeDays
  if (weekends !== null && (!Array.isArray(weekends) || weekends.some((day) => day !== 'Saturday' && day !== 'Sunday'))) {
    return NextResponse.json({ error: 'Weekend overtime must be unconfigured (null) or a list containing Saturday and/or Sunday.' }, { status: 400 })
  }

  const supabase = await createSupabaseServerClient()
  const { data: latest, error: latestError } = await supabase.from('attendance_rule_versions')
    .select('version')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestError) return NextResponse.json({ error: 'The existing rule version could not be read.' }, { status: 503 })

  const nextVersion = (latest?.version ?? 0) + 1
  const { data, error } = await supabase.from('attendance_rule_versions').insert({
    version: nextVersion,
    attendance_timezone: 'Africa/Kigali',
    effective_from: body.effectiveFrom,
    normal_start: times.normalStart,
    grace_until: times.graceUntil,
    very_late_from: times.veryLateFrom,
    scheduled_end: times.scheduledEnd,
    overtime_from: times.overtimeFrom,
    policy: { weekendOvertimeDays: weekends },
    reason,
    created_by: administrator.id,
  }).select('id, version, attendance_timezone, effective_from, normal_start, grace_until, very_late_from, scheduled_end, overtime_from, policy, reason, created_at').single()
  if (error) {
    const conflict = error.code === '23505'
    return NextResponse.json({ error: conflict ? 'Another rule version was saved at the same time. Reload settings and retry.' : 'The new rule version could not be saved.' }, { status: conflict ? 409 : 503 })
  }
  return NextResponse.json({ rule: data }, { status: 201, headers: { 'Cache-Control': 'private, no-store' } })
}
