'use client'

import { useState, type FormEvent } from 'react'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

export function LoginForm() {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)
    const formData = new FormData(event.currentTarget)
    try {
      const supabase = createSupabaseBrowserClient()
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: String(formData.get('email') ?? '').trim(),
        password: String(formData.get('password') ?? ''),
      })
      if (signInError) throw signInError
      window.location.assign('/')
    } catch {
      setError('Sign-in failed. Check your credentials and try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="auth-form" onSubmit={signIn}>
      <label className="field-label">Administrator email<input name="email" type="email" autoComplete="username" required /></label>
      <label className="field-label">Password<input name="password" type="password" autoComplete="current-password" required /></label>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="button primary" type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
      <p className="auth-help">Accounts are created by an administrator. Public registration is disabled.</p>
    </form>
  )
}
