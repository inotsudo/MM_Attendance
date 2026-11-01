-- MM&RJD attendance foundation. Apply with `supabase db push` after linking a project.
-- Source evidence and derived calculations are separate, append-only records.

create type public.app_role as enum (
  'administrator',
  'attendance_manager',
  'reviewer',
  'viewer'
);

create type public.attendance_source_type as enum (
  'ivms_pdf_original_records',
  'organized_excel'
);

create type public.import_processing_status as enum (
  'uploaded',
  'queued',
  'processing',
  'parsed',
  'needs_review',
  'completed',
  'failed'
);

create type public.employee_match_method as enum (
  'employee_number',
  'exact_name',
  'manual'
);

create type public.employee_match_status as enum (
  'matched',
  'suggested',
  'unmatched',
  'rejected'
);

create type public.review_item_status as enum (
  'open',
  'resolved',
  'dismissed'
);

create type public.arrival_classification as enum (
  'before_start',
  'on_time',
  'late',
  'very_late',
  'no_event'
);

create type public.calculation_completeness as enum (
  'complete_evidence',
  'incomplete_evidence',
  'no_events'
);

create table public.user_profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  full_name text,
  role public.app_role not null default 'viewer',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  code text unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  employee_number text not null unique,
  full_name text not null,
  department_id uuid references public.departments (id) on delete restrict,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.attendance_imports (
  id uuid primary key default gen_random_uuid(),
  source_type public.attendance_source_type not null,
  original_filename text not null,
  storage_bucket text not null default 'attendance-originals'
    check (storage_bucket = 'attendance-originals'),
  storage_path text not null unique,
  file_type text not null check (file_type in (
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel'
  )),
  file_size_bytes bigint not null check (file_size_bytes > 0 and file_size_bytes <= 26214400),
  sha256_checksum text not null check (sha256_checksum ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid not null references public.user_profiles (id) on delete restrict,
  uploaded_at timestamptz not null default now(),
  processing_status public.import_processing_status not null default 'uploaded',
  processing_error text,
  processing_started_at timestamptz,
  processing_completed_at timestamptz,
  created_at timestamptz not null default now(),
  check (
    (source_type = 'ivms_pdf_original_records'
      and lower(original_filename) like '%.pdf'
      and file_type = 'application/pdf')
    or
    (source_type = 'organized_excel'
      and (lower(original_filename) like '%.xlsx' or lower(original_filename) like '%.xls')
      and file_type in (
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel'
      ))
  )
);

create table public.raw_fingerprint_events (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.attendance_imports (id) on delete restrict,
  source_page integer check (source_page is null or source_page > 0),
  source_row integer check (source_row is null or source_row > 0),
  source_event_identifier text,
  source_employee_number text,
  source_employee_name text,
  source_department text,
  source_timestamp_text text not null,
  normalized_timestamp timestamptz,
  source_status text,
  checkpoint text,
  raw_evidence jsonb not null default '{}'::jsonb,
  extracted_at timestamptz not null default now(),
  unique (import_id, source_page, source_row)
);

create table public.organized_attendance_entries (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.attendance_imports (id) on delete restrict,
  source_sheet text,
  source_row integer not null check (source_row > 0),
  source_employee_number text,
  source_employee_name text,
  source_department text,
  source_work_date_text text not null,
  normalized_work_date date,
  source_in_text text,
  normalized_in_at timestamptz,
  source_out_text text,
  normalized_out_at timestamptz,
  raw_evidence jsonb not null default '{}'::jsonb,
  extracted_at timestamptz not null default now(),
  unique (import_id, source_sheet, source_row)
);

-- Match decisions are separate from extracted source evidence, so rematching never
-- edits either the PDF event or the Excel row.
create table public.employee_match_decisions (
  id uuid primary key default gen_random_uuid(),
  raw_fingerprint_event_id uuid references public.raw_fingerprint_events (id) on delete restrict,
  organized_attendance_entry_id uuid references public.organized_attendance_entries (id) on delete restrict,
  employee_id uuid references public.employees (id) on delete restrict,
  match_status public.employee_match_status not null,
  match_method public.employee_match_method,
  confidence numeric(5, 4) check (confidence is null or confidence between 0 and 1),
  decided_by uuid references public.user_profiles (id) on delete restrict,
  decision_note text,
  created_at timestamptz not null default now(),
  check (num_nonnulls(raw_fingerprint_event_id, organized_attendance_entry_id) = 1),
  check ((match_status = 'unmatched' and employee_id is null) or (match_status <> 'unmatched' and employee_id is not null))
);

create table public.attendance_rule_versions (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique check (version > 0),
  attendance_timezone text not null default 'Africa/Kigali',
  effective_from date not null,
  normal_start time not null,
  grace_until time not null,
  very_late_from time not null,
  scheduled_end time not null,
  overtime_from time not null,
  policy jsonb not null default '{}'::jsonb,
  reason text not null,
  created_by uuid not null references public.user_profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.daily_attendance_calculations (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees (id) on delete restrict,
  attendance_date date not null,
  calculation_version integer not null check (calculation_version > 0),
  rules_version_id uuid not null references public.attendance_rule_versions (id) on delete restrict,
  first_recorded_at timestamptz,
  last_recorded_at timestamptz,
  recorded_event_count integer not null default 0 check (recorded_event_count >= 0),
  arrival_classification public.arrival_classification not null,
  overtime_evidence boolean not null default false,
  is_weekend boolean not null,
  completeness public.calculation_completeness not null,
  calculation_result jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null default now(),
  calculated_by uuid references public.user_profiles (id) on delete restrict,
  unique (employee_id, attendance_date, calculation_version)
);

create table public.daily_attendance_evidence (
  id uuid primary key default gen_random_uuid(),
  daily_calculation_id uuid not null references public.daily_attendance_calculations (id) on delete restrict,
  raw_fingerprint_event_id uuid references public.raw_fingerprint_events (id) on delete restrict,
  organized_attendance_entry_id uuid references public.organized_attendance_entries (id) on delete restrict,
  created_at timestamptz not null default now(),
  check (num_nonnulls(raw_fingerprint_event_id, organized_attendance_entry_id) = 1),
  unique (daily_calculation_id, raw_fingerprint_event_id),
  unique (daily_calculation_id, organized_attendance_entry_id)
);

create table public.attendance_review_items (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.attendance_imports (id) on delete restrict,
  daily_calculation_id uuid references public.daily_attendance_calculations (id) on delete restrict,
  raw_fingerprint_event_id uuid references public.raw_fingerprint_events (id) on delete restrict,
  organized_attendance_entry_id uuid references public.organized_attendance_entries (id) on delete restrict,
  issue_code text not null,
  severity text not null default 'warning' check (severity in ('info', 'warning', 'error')),
  status public.review_item_status not null default 'open',
  description text not null,
  evidence jsonb not null default '{}'::jsonb,
  resolution_note text,
  resolved_by uuid references public.user_profiles (id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check (num_nonnulls(raw_fingerprint_event_id, organized_attendance_entry_id) <= 1),
  check ((status = 'open' and resolved_by is null and resolved_at is null) or (status <> 'open' and resolved_by is not null and resolved_at is not null))
);

create table public.attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  daily_calculation_id uuid not null references public.daily_attendance_calculations (id) on delete restrict,
  correction_type text not null,
  previous_values jsonb not null,
  corrected_values jsonb not null,
  reason text not null check (length(trim(reason)) > 0),
  corrected_by uuid not null references public.user_profiles (id) on delete restrict,
  corrected_at timestamptz not null default now()
);

create table public.audit_history (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.user_profiles (id) on delete set null,
  action text not null,
  target_table text not null,
  target_id uuid,
  reason text,
  before_values jsonb,
  after_values jsonb,
  occurred_at timestamptz not null default now()
);

create index attendance_imports_uploaded_at_idx on public.attendance_imports (uploaded_at desc);
create index attendance_imports_checksum_idx on public.attendance_imports (sha256_checksum);
create index raw_fingerprint_events_import_idx on public.raw_fingerprint_events (import_id);
create index raw_fingerprint_events_normalized_timestamp_idx on public.raw_fingerprint_events (normalized_timestamp);
create index organized_entries_import_idx on public.organized_attendance_entries (import_id);
create index daily_attendance_employee_date_idx on public.daily_attendance_calculations (employee_id, attendance_date desc);
create index attendance_review_open_idx on public.attendance_review_items (status, created_at desc) where status = 'open';
create index attendance_corrections_record_idx on public.attendance_corrections (daily_calculation_id, corrected_at desc);
create index audit_history_target_idx on public.audit_history (target_table, target_id, occurred_at desc);

create or replace function public.user_has_any_role(_roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.user_profiles as profile
    where profile.id = (select auth.uid())
      and profile.is_active
      and profile.role = any (_roles)
  );
$function$;

revoke all on function public.user_has_any_role(public.app_role[]) from public, anon;
grant execute on function public.user_has_any_role(public.app_role[]) to authenticated;

create or replace function public.prevent_attendance_evidence_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using errcode = '55000', message = 'Attendance source evidence and historical records are append-only';
end;
$function$;

revoke all on function public.prevent_attendance_evidence_mutation() from public, anon, authenticated;

create trigger raw_fingerprint_events_append_only
  before update or delete on public.raw_fingerprint_events
  for each row execute function public.prevent_attendance_evidence_mutation();
create trigger organized_attendance_entries_append_only
  before update or delete on public.organized_attendance_entries
  for each row execute function public.prevent_attendance_evidence_mutation();
create trigger employee_match_decisions_append_only
  before update or delete on public.employee_match_decisions
  for each row execute function public.prevent_attendance_evidence_mutation();
create trigger attendance_rule_versions_append_only
  before update or delete on public.attendance_rule_versions
  for each row execute function public.prevent_attendance_evidence_mutation();
create trigger daily_attendance_calculations_append_only
  before update or delete on public.daily_attendance_calculations
  for each row execute function public.prevent_attendance_evidence_mutation();
create trigger daily_attendance_evidence_append_only
  before update or delete on public.daily_attendance_evidence
  for each row execute function public.prevent_attendance_evidence_mutation();
create trigger attendance_corrections_append_only
  before update or delete on public.attendance_corrections
  for each row execute function public.prevent_attendance_evidence_mutation();
create trigger audit_history_append_only
  before update or delete on public.audit_history
  for each row execute function public.prevent_attendance_evidence_mutation();

create or replace function public.protect_import_file_metadata()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.source_type is distinct from old.source_type
    or new.original_filename is distinct from old.original_filename
    or new.storage_bucket is distinct from old.storage_bucket
    or new.storage_path is distinct from old.storage_path
    or new.file_type is distinct from old.file_type
    or new.file_size_bytes is distinct from old.file_size_bytes
    or new.sha256_checksum is distinct from old.sha256_checksum
    or new.uploaded_by is distinct from old.uploaded_by
    or new.uploaded_at is distinct from old.uploaded_at then
    raise exception using errcode = '55000', message = 'Original attendance import metadata is immutable';
  end if;
  return new;
end;
$function$;

revoke all on function public.protect_import_file_metadata() from public, anon, authenticated;
create trigger attendance_import_file_metadata_immutable
  before update on public.attendance_imports
  for each row execute function public.protect_import_file_metadata();

create or replace function public.write_audit_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  old_row jsonb;
  new_row jsonb;
  target jsonb;
begin
  if tg_op <> 'INSERT' then old_row := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then new_row := to_jsonb(new); end if;
  target := coalesce(new_row, old_row);

  insert into public.audit_history (
    actor_user_id, action, target_table, target_id, reason, before_values, after_values
  ) values (
    (select auth.uid()),
    lower(tg_op),
    tg_table_name,
    (target ->> 'id')::uuid,
    coalesce(new_row ->> 'reason', old_row ->> 'reason'),
    old_row,
    new_row
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

revoke all on function public.write_audit_history() from public, anon, authenticated;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

revoke all on function public.touch_updated_at() from public, anon, authenticated;

create trigger user_profiles_updated_at before update on public.user_profiles
  for each row execute function public.touch_updated_at();
create trigger departments_updated_at before update on public.departments
  for each row execute function public.touch_updated_at();
create trigger employees_updated_at before update on public.employees
  for each row execute function public.touch_updated_at();

create trigger user_profiles_audit after insert or update or delete on public.user_profiles
  for each row execute function public.write_audit_history();
create trigger departments_audit after insert or update or delete on public.departments
  for each row execute function public.write_audit_history();
create trigger employees_audit after insert or update or delete on public.employees
  for each row execute function public.write_audit_history();
create trigger attendance_imports_audit after insert or update or delete on public.attendance_imports
  for each row execute function public.write_audit_history();
create trigger attendance_review_items_audit after insert or update or delete on public.attendance_review_items
  for each row execute function public.write_audit_history();
create trigger attendance_corrections_audit after insert on public.attendance_corrections
  for each row execute function public.write_audit_history();
create trigger attendance_rule_versions_audit after insert on public.attendance_rule_versions
  for each row execute function public.write_audit_history();

alter table public.user_profiles enable row level security;
alter table public.departments enable row level security;
alter table public.employees enable row level security;
alter table public.attendance_imports enable row level security;
alter table public.raw_fingerprint_events enable row level security;
alter table public.organized_attendance_entries enable row level security;
alter table public.employee_match_decisions enable row level security;
alter table public.attendance_rule_versions enable row level security;
alter table public.daily_attendance_calculations enable row level security;
alter table public.daily_attendance_evidence enable row level security;
alter table public.attendance_review_items enable row level security;
alter table public.attendance_corrections enable row level security;
alter table public.audit_history enable row level security;

revoke all on public.user_profiles, public.departments, public.employees,
  public.attendance_imports, public.raw_fingerprint_events,
  public.organized_attendance_entries, public.employee_match_decisions,
  public.attendance_rule_versions, public.daily_attendance_calculations,
  public.daily_attendance_evidence, public.attendance_review_items,
  public.attendance_corrections, public.audit_history from anon, authenticated;

grant select on public.user_profiles to authenticated;
grant select, insert, update, delete on public.departments, public.employees to authenticated;
grant select, insert, update on public.attendance_imports to authenticated;
grant select, insert on public.raw_fingerprint_events,
  public.organized_attendance_entries, public.employee_match_decisions,
  public.attendance_rule_versions, public.daily_attendance_calculations,
  public.daily_attendance_evidence, public.attendance_corrections to authenticated;
grant select, insert, update on public.attendance_review_items to authenticated;
grant select on public.audit_history to authenticated;

create policy profiles_read_self_or_admin on public.user_profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.user_has_any_role(array['administrator']::public.app_role[])));

create policy departments_admin_access on public.departments
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::public.app_role[])));
create policy employees_admin_access on public.employees
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::public.app_role[])));
create policy attendance_imports_admin_access on public.attendance_imports
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::public.app_role[])));
create policy raw_fingerprint_events_admin_access on public.raw_fingerprint_events
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::public.app_role[])));
create policy organized_attendance_entries_admin_access on public.organized_attendance_entries
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::public.app_role[])));
create policy employee_match_decisions_admin_access on public.employee_match_decisions
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::public.app_role[])));
create policy attendance_rule_versions_admin_access on public.attendance_rule_versions
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::public.app_role[])));
create policy daily_attendance_calculations_admin_access on public.daily_attendance_calculations
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::public.app_role[])));
create policy daily_attendance_evidence_admin_access on public.daily_attendance_evidence
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::public.app_role[])));
create policy attendance_review_items_admin_access on public.attendance_review_items
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::app_role[])));
create policy attendance_corrections_admin_access on public.attendance_corrections
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::app_role[])));
create policy audit_history_admin_read on public.audit_history
  for select to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attendance-originals',
  'attendance-originals',
  false,
  26214400,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy attendance_originals_admin_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'attendance-originals'
    and (select public.user_has_any_role(array['administrator']::public.app_role[]))
    and exists (
      select 1
      from public.attendance_imports as import
      where import.storage_bucket = storage.objects.bucket_id
        and import.storage_path = storage.objects.name
    )
  );

create policy attendance_originals_admin_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'attendance-originals'
    and (select public.user_has_any_role(array['administrator']::public.app_role[]))
    and exists (
      select 1
      from public.attendance_imports as import
      where import.storage_bucket = storage.objects.bucket_id
        and import.storage_path = storage.objects.name
    )
  );
