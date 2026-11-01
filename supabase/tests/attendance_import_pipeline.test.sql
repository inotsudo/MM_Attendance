begin;
select plan(6);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
  'import-test@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);
insert into public.user_profiles (id, full_name, role, is_active)
values ('10000000-0000-0000-0000-000000000001', 'Import Test', 'administrator', true);
insert into public.attendance_imports (
  id, source_type, original_filename, storage_path, file_type,
  file_size_bytes, sha256_checksum, uploaded_by, processing_status
) values (
  '20000000-0000-0000-0000-000000000001', 'ivms_pdf_original_records',
  'fixture.pdf', '10000000-0000-0000-0000-000000000001/20000000-0000-0000-0000-000000000001/fixture.pdf',
  'application/pdf', 100, repeat('a', 64), '10000000-0000-0000-0000-000000000001', 'parsed'
);
insert into public.employees (employee_number, full_name)
values ('EMP-X', 'Fixture Person');

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select ok(
  (public.confirm_attendance_import(
    '20000000-0000-0000-0000-000000000001',
    '[{"sourceIndex":1,"sourcePage":1,"sourceRow":1,"employeeNumber":"EMP-X","employeeName":"Fixture Person","sourceTimestamp":"2026-09-14 08:00:00","normalizedTimestamp":"2026-09-14T06:00:00Z","fields":{"personId":"EMP-X"},"rawText":"fixture event"}]'::jsonb,
    '[{"employeeId":null,"method":null,"note":"test unmatched"}]'::jsonb,
    '[{"sourceIndex":1,"code":"unmatched_employee","severity":"warning","message":"Fixture identity remains unmatched.","evidence":{}}]'::jsonb,
    '[]'::jsonb
  ) ->> 'status' = 'needs_review'),
  'confirmation persists source evidence and leaves unresolved identities for review'
);
select is(
  (select count(*)::integer from public.raw_fingerprint_events where import_id = '20000000-0000-0000-0000-000000000001'),
  1,
  'confirmation stores one raw PDF event'
);
select ok(
  (public.confirm_attendance_import(
    '20000000-0000-0000-0000-000000000001',
    '[{"sourceIndex":1,"sourcePage":1,"sourceRow":1,"employeeNumber":"EMP-X","employeeName":"Fixture Person","sourceTimestamp":"2026-09-14 08:00:00","normalizedTimestamp":"2026-09-14T06:00:00Z","fields":{"personId":"EMP-X"},"rawText":"fixture event"}]'::jsonb,
    '[{"employeeId":null,"method":null,"note":"test unmatched"}]'::jsonb,
    '[{"sourceIndex":1,"code":"unmatched_employee","severity":"warning","message":"Fixture identity remains unmatched.","evidence":{}}]'::jsonb,
    '[]'::jsonb
  ) ->> 'alreadyCompleted' = 'true'),
  'repeated confirmation is recognized as already persisted'
);
select is(
  (select count(*)::integer from public.raw_fingerprint_events where import_id = '20000000-0000-0000-0000-000000000001'),
  1,
  'repeated confirmation does not duplicate raw evidence'
);
select ok(
  (public.resolve_attendance_review_item(
    (select id from public.attendance_review_items where import_id = '20000000-0000-0000-0000-000000000001' limit 1),
    'Verified against the employee register.',
    (select id from public.employees where employee_number = 'EMP-X')
  ) ->> 'status' = 'resolved'),
  'review resolution can append an explicit employee match'
);
select is(
  (select count(*)::integer from public.employee_match_decisions where match_method = 'manual' and employee_id = (select id from public.employees where employee_number = 'EMP-X')),
  1,
  'manual identity resolution remains in match history'
);

select * from finish();
rollback;
