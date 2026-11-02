# Supabase foundation setup

The application uses Supabase Auth, PostgreSQL, and private Storage from the existing Next.js project. The gitignored `.env.local` in this workspace contains the project's URL and publishable key; neither value is committed. No service-role key is needed for this foundation.

## Local application configuration

Copy `.env.example` to `.env.local`, then set:

- `NEXT_PUBLIC_SUPABASE_URL` — Project URL from Supabase Project Settings → API.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — publishable key from the same page.

These are the only application variables currently required. They are safe to expose to browser code when the database and Storage RLS policies are applied. Never put a secret/service-role key in a `NEXT_PUBLIC_` variable. The server client also uses the publishable key and the signed-in user's cookie session, so database requests remain subject to RLS.

Set the same two variables in Vercel's Development, Preview, and Production environments after the project exists. Redeploy after changing deployment variables.

## Apply the migration to a Supabase project

The migrations in `supabase/migrations/` create the schema, private bucket and attendance import pipeline. Both were applied to the linked remote project on 2026-11-01. `supabase migration list --linked` reports the local and remote versions as matching.

1. Use the project reference from the configured project URL and retain the database password securely.
2. Install or use the Supabase CLI, then authenticate with `supabase login`.
3. Link this checkout with `supabase link --project-ref <PROJECT_REF>`; the CLI may request the database password.
4. Review pending migrations with `supabase migration list --linked` before applying changes with `supabase db push`.
5. Verify the resulting schema, policies and bucket in the Dashboard. Run `supabase start` before `supabase test db` when the local database is not running.

Do not run the migration twice manually in the SQL Editor after `db push`; it is a versioned migration and is intended to be applied once by the CLI.

## Provision the initial administrator

1. In Supabase Authentication settings, keep **Allow new users to sign up** disabled. Keep the site URL and redirect allow-list restricted to the deployed application and required local development URL.
2. Create/invite the initial administrator account from the Supabase Dashboard. Do not create a public registration page or put the password in this repository.
3. If the profile has not already been created, copy that Auth user's UUID from the Dashboard and add the application profile from the SQL Editor, replacing the placeholders:

```sql
insert into public.user_profiles (id, full_name, role)
values ('<AUTH_USER_UUID>'::uuid, '<ADMINISTRATOR_NAME>', 'administrator');
```

No employee, department, attendance, import, or default rule records are seeded. Additional staff roles are represented by the `app_role` enum and profile role column, but current RLS access is administrator-only.

## Current live verification status (2026-11-01)

- The remote migration history contains `20261101000100`, `20261101000200`, and `20261101000300`, matching the local migrations.
- The live database has all 13 foundation tables, RLS and the private `attendance-originals` bucket. The import migration added the Excel source-column field, unique checksum index and administrator-only confirmation RPC.
- The confirmation RPC is executable by `authenticated`, not `anon`.
- The live project has one active administrator, zero active employees, and zero attendance rule versions. Public registration has been disabled.

## Database and authentication verification

With the remote project linked and migrations applied:

- Run `supabase start` then `supabase test db`; the local foundation and import pipeline suites pass 28 assertions in this workspace.
- Sign in at `/login` with the provisioned account and confirm `/` loads.
- Sign out and confirm `/` redirects to `/login`.
- Confirm a signed-in Auth user with no active administrator profile cannot load the attendance app or its API.
- In the SQL Editor, verify the `attendance-originals` bucket has `public = false`, its MIME and size restrictions, and the policies shown in the migration.
- Attempt unauthenticated reads and uploads to the bucket; both must be denied. Confirm an administrator can access only an object whose path has a corresponding import metadata row.

The live migration, schema, RLS setup, disabled public signup, and administrator profile are confirmed. Administrator sign-in and live file upload/read have not been exercised as part of import implementation; no test files or attendance records were uploaded to production. The project URL and key values are intentionally omitted from this document.

## Attendance import pipeline (2026-11-01)

Migration `20261101000200_attendance_import_pipeline.sql` adds a unique checksum index, cell-level Excel provenance, and an administrator-only transactional `confirm_attendance_import` RPC. It saves source evidence, match decisions, review items and eligible calculations atomically. Repeated confirmation does not duplicate evidence.

Migration `20261101000300_attendance_review_resolution.sql` adds an administrator-only review resolution RPC. The Review page loads persisted open issues and can record a resolution note and an explicit employee match as append-only match history.

The Next.js import flow creates private signed uploads, checks the uploaded file's size, checksum and signature, parses the stored source for preview, supports explicit employee matching, and persists confirmation through the RPC. It needs no service-role key or additional environment variables. iVMS PDF events remain immutable raw events; version 3 calculations derive the earliest pre-noon event as IN and latest post-noon event as OUT in `Africa/Kigali`. An event at exactly noon remains unresolved. Persisted calculations require a matched employee and an effective versioned `Africa/Kigali` rule. The Excel `Attendance Sheet` export mirrors the manual layout, grouping visible rows by source identity and using the source name even when a roster match is pending. The organized workbook's month label is advisory when it conflicts with actual date headings; the parser warns and uses the date headings plus year. Weekly exports use the reference legend (yellow late, orange very late, red missing counterpart, green verified overtime); the absent count is the number of red cells, and dates with no source events are not counted as absent without a work calendar.

Actual local sample files were parsed without copying employee data into the repository: the iVMS Original Records PDF produced 450 events across 8 pages; the organized Excel workbook produced 455 daily employee rows. The workbook date headings resolve to September 2026 despite a conflicting July month label; the parser follows the headings and flags the mismatch. Set `MMRJD_TEST_IVMS_PDF` and `MMRJD_TEST_ATTENDANCE_XLSX` to local sample paths to rerun those integration tests. A redacted PDF fixture and generated XLSX structures run in the ordinary test suite.

## Data model notes

- `raw_fingerprint_events` stores source PDF text and location separately from its optional normalized `timestamptz` value.
- `organized_attendance_entries` stores original Excel date/time cells separately from normalized dates and timestamps.
- Both source tables are append-only. Employee match decisions live in their own historical table and do not rewrite source evidence.
- `daily_attendance_calculations` stores versioned derived results and points to a specific rule version. `daily_attendance_evidence` links each result to source evidence.
- Corrections are append-only records with previous and corrected values, reason, actor, and timestamp. Existing calculations are not overwritten.
- `attendance_imports` stores the original filename, bucket/path, MIME type, size, SHA-256 checksum, uploader, upload time, and processing status. The original-file metadata is immutable; only processing state may change.
- Database and upload timestamps use `timestamptz`; attendance rule versions default to the organization timezone `Africa/Kigali`.

## Intelligent review and correction workflow (2026-11-02)

Local migrations `20261102000100_professional_review_lifecycle.sql` and `20261102000200_intelligent_attendance_review.sql` add explicit review states, persisted analysis runs, evidence-classified findings, correction proposals, immutable administrator decisions, and calculation supersession links. Analysis recalculates from rows linked to a saved calculation; PDF and organized Excel source rows remain unchanged. Approval is recorded before applying a proposal. The database rechecks the employee/date calculation, current rule version, linked evidence and source-derived arrival classification inside the application transaction. It writes a new calculation version and preserves the previous one. Failed application remains visible and retryable.

The review interface uses persisted findings and proposal states. The report loader includes open analysis findings as validation exceptions and selects the latest current calculation. Direct attendance-time edits are disabled. These migrations have **not been verified against or applied to the live project** in this workspace. The Supabase CLI currently has no access token here; sign in with `supabase login`, inspect `supabase migration list --linked`, then apply the pending migrations with `supabase db push`. Do not create credentials in this repository. After application, run the local database tests and exercise one authorized analysis, approval, rejection, recalculation, and report-validation flow in a non-production project before using the workflow for HR decisions.
