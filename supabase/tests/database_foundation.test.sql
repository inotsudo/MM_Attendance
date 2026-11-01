begin;
select plan(22);

select has_table('public', 'user_profiles', 'administrator profiles table exists');
select has_table('public', 'departments', 'departments table exists');
select has_table('public', 'employees', 'employees table exists');
select has_table('public', 'attendance_imports', 'attendance imports table exists');
select has_table('public', 'raw_fingerprint_events', 'raw PDF fingerprint events have their own table');
select has_table('public', 'organized_attendance_entries', 'organized Excel entries have a separate table');
select has_table('public', 'daily_attendance_calculations', 'daily calculations table exists');
select has_table('public', 'attendance_review_items', 'review items table exists');
select has_table('public', 'attendance_corrections', 'correction history table exists');
select has_table('public', 'attendance_rule_versions', 'versioned attendance rules table exists');
select has_table('public', 'audit_history', 'audit history table exists');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.raw_fingerprint_events'::regclass),
  'raw fingerprint events have RLS enabled'
);
select ok(
  (select not public from storage.buckets where id = 'attendance-originals'),
  'attendance source bucket is private'
);
select ok(
  (select count(*) = 13 from pg_class where relnamespace = 'public'::regnamespace and relrowsecurity),
  'RLS is enabled on every foundation table'
);
select ok(
  not has_table_privilege('anon', 'public.employees', 'select'),
  'anonymous role has no employee table grant'
);
select ok(
  has_table_privilege('authenticated', 'public.raw_fingerprint_events', 'insert')
    and not has_table_privilege('authenticated', 'public.raw_fingerprint_events', 'update'),
  'authenticated clients can append but not rewrite source evidence'
);
select ok(
  not has_table_privilege('authenticated', 'public.attendance_corrections', 'update'),
  'correction history cannot be rewritten'
);
select ok(
  (select count(*) = 2 from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and policyname in ('attendance_originals_admin_upload', 'attendance_originals_admin_read')),
  'private import storage has only the scoped read and upload policies'
);
select has_column('public', 'organized_attendance_entries', 'source_column', 'Excel evidence retains its source column for cell-level idempotency');
select ok(
  to_regprocedure('public.confirm_attendance_import(uuid,jsonb,jsonb,jsonb,jsonb)') is not null,
  'administrator import confirmation RPC exists'
);
select ok(
  exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'attendance_imports_checksum_unique_idx' and indexdef ilike '%unique%'),
  'duplicate uploads are protected by a unique checksum index'
);

set local role authenticated;
select is((select count(*) from public.departments), 0::bigint, 'authenticated user without an active profile sees no department rows');
reset role;

select * from finish();
rollback;
