import { AttendanceApp } from '@/components/attendance-app'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { isSupabaseConfigured } from '@/lib/supabase/config'
import { redirect } from 'next/navigation'

export default async function Page() {
  if (!isSupabaseConfigured()) redirect('/login')
  if (!(await getAdministratorProfile())) redirect('/login')
  return <AttendanceApp />
}

