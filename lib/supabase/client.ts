'use client'

import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/lib/database.types'
import { getSupabasePublicConfig } from './config'

export function createSupabaseBrowserClient() {
  const { url, publishableKey } = getSupabasePublicConfig()
  return createBrowserClient<Database>(url, publishableKey)
}
