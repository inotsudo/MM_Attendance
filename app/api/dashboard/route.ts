import { NextResponse } from 'next/server'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { createSupabaseServerClient } from '@/lib/supabase/server'

function currentKigaliWeek() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const midnight = Date.parse(`${today}T00:00:00Z`)
  const day = new Date(midnight).getUTCDay()
  const from = new Date(midnight - ((day + 6) % 7) * 86_400_000).toISOString().slice(0, 10)
  const to = new Date(Date.parse(`${from}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10)
  return { from, to }
}

export async function GET() {
  if (!(await getAdministratorProfile())) return NextResponse.json({ error: 'Administrator access is required.' }, { status: 401 })
  const supabase = await createSupabaseServerClient()
  const { from, to } = currentKigaliWeek()
  const activeReviewStates = ['pending', 'under_review', 'unresolved'] as const
  const [employees, imports, reviewItems, calculations, recentImports] = await Promise.all([
    supabase.from('employees').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('attendance_imports').select('id', { count: 'exact', head: true }),
    supabase.from('attendance_review_items').select('id', { count: 'exact', head: true }).in('review_state', [...activeReviewStates]),
    supabase.from('daily_attendance_calculations').select('id', { count: 'exact', head: true }).gte('attendance_date', from).lte('attendance_date', to),
    supabase.from('attendance_imports').select('id, original_filename, source_type, uploaded_at, processing_status').order('uploaded_at', { ascending: false }).limit(5),
  ])
  if ([employees, imports, reviewItems, calculations, recentImports].some((result) => result.error)) return NextResponse.json({ error: 'Dashboard information could not be loaded.' }, { status: 503 })
  return NextResponse.json({
    week: { from, to },
    counts: { employees: employees.count ?? 0, imports: imports.count ?? 0, reviewItems: reviewItems.count ?? 0, calculatedDays: calculations.count ?? 0 },
    recentImports: recentImports.data ?? [],
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}
