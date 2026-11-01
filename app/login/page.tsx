import { redirect } from 'next/navigation'
import { LoginForm } from '@/components/login-form'
import { getAdministratorProfile } from '@/lib/supabase/auth'
import { isSupabaseConfigured } from '@/lib/supabase/config'

export default async function LoginPage() {
  if (!isSupabaseConfigured()) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">MM&amp;RJD attendance</p>
          <h1>Supabase setup required</h1>
          <p className="auth-description">Authentication is not configured yet. Add <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> to <code>.env.local</code> after creating the Supabase project.</p>
        </section>
      </main>
    )
  }

  if (await getAdministratorProfile()) redirect('/')

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyebrow">MM&amp;RJD attendance</p>
        <h1>Administrator sign in</h1>
        <p className="auth-description">Sign in with an account provisioned for this attendance system.</p>
        <LoginForm />
      </section>
    </main>
  )
}
