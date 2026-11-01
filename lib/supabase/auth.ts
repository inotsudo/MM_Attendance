import 'server-only'

import { createSupabaseServerClient } from './server'

export async function getAdministratorProfile() {
  const supabase = await createSupabaseServerClient()
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const userId = claimsData?.claims?.sub
  if (claimsError || typeof userId !== 'string') return null

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('id, full_name, role, is_active')
    .eq('id', userId)
    .maybeSingle()

  if (profileError || !profile || !profile.is_active || profile.role !== 'administrator') return null
  return profile
}
