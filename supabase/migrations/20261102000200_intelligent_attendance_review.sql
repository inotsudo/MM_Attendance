-- Persisted, evidence-backed attendance analysis and administrator decisions.
-- Source records remain immutable; approved proposals create a new calculation.

create table public.attendance_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.attendance_imports (id) on delete restrict,
  analyzed_by uuid not null references public.user_profiles (id) on delete restrict,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  period_from date,
  period_to date,
  source_record_count integer not null default 0 check (source_record_count >= 0),
  summary jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  check (period_to is null or period_from is null or period_to >= period_from)
);

create table public.attendance_review_findings (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.attendance_analysis_runs (id) on delete restrict,
  import_id uuid not null references public.attendance_imports (id) on delete restrict,
  employee_id uuid references public.employees (id) on delete restrict,
  employee_number text,
  employee_name text,
  attendance_date date,
  category text not null,
  evidence_class text not null check (evidence_class in ('confirmed_inconsistency', 'potential_inconsistency', 'insufficient_evidence')),
  title text not null,
  explanation text not null,
  current_values jsonb not null default '{}'::jsonb,
  source_references jsonb not null default '{}'::jsonb,
  rules_version_id uuid references public.attendance_rule_versions (id) on delete restrict,
  calculation_id uuid references public.daily_attendance_calculations (id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected', 'investigation', 'approved', 'corrected', 'unresolved', 'superseded')),
  decision_note text,
  decided_by uuid references public.user_profiles (id) on delete restrict,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check ((decided_by is null and decided_at is null) or (decided_by is not null and decided_at is not null))
);

create table public.attendance_correction_proposals (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null unique references public.attendance_review_findings (id) on delete restrict,
  import_id uuid not null references public.attendance_imports (id) on delete restrict,
  employee_id uuid not null references public.employees (id) on delete restrict,
  attendance_date date not null,
  current_calculation_id uuid not null references public.daily_attendance_calculations (id) on delete restrict,
  rules_version_id uuid not null references public.attendance_rule_versions (id) on delete restrict,
  affected_field text not null,
  previous_value jsonb not null,
  proposed_value jsonb not null,
  proposed_calculation jsonb not null,
  source_references jsonb not null,
  explanation text not null,
  confidence numeric(5,4) not null check (confidence >= 0 and confidence <= 1),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'investigation', 'confirmed', 'applied', 'failed', 'superseded')),
  generated_at timestamptz not null default now(),
  decided_by uuid references public.user_profiles (id) on delete restrict,
  decided_at timestamptz,
  decision_note text,
  application_error text,
  resulting_calculation_id uuid references public.daily_attendance_calculations (id) on delete restrict,
  check ((decided_by is null and decided_at is null) or (decided_by is not null and decided_at is not null))
);

alter table public.attendance_corrections
  add column proposal_id uuid unique references public.attendance_correction_proposals (id) on delete restrict,
  add column finding_id uuid references public.attendance_review_findings (id) on delete restrict,
  add column rules_version_id uuid references public.attendance_rule_versions (id) on delete restrict;

create table public.attendance_review_decisions (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.attendance_review_findings (id) on delete restrict,
  proposal_id uuid references public.attendance_correction_proposals (id) on delete restrict,
  action text not null check (action in ('approved', 'rejected', 'investigation', 'confirmed', 'application_failed', 'application_applied')),
  reason text not null check (length(trim(reason)) >= 3),
  actor_user_id uuid not null references public.user_profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);

create table public.attendance_calculation_supersessions (
  id uuid primary key default gen_random_uuid(),
  previous_calculation_id uuid not null references public.daily_attendance_calculations (id) on delete restrict,
  replacement_calculation_id uuid not null unique references public.daily_attendance_calculations (id) on delete restrict,
  proposal_id uuid not null unique references public.attendance_correction_proposals (id) on delete restrict,
  superseded_by uuid not null references public.user_profiles (id) on delete restrict,
  superseded_at timestamptz not null default now(),
  unique (previous_calculation_id, replacement_calculation_id)
);

create index attendance_analysis_import_idx on public.attendance_analysis_runs (import_id, started_at desc);
create index attendance_findings_status_idx on public.attendance_review_findings (status, created_at desc);
create index attendance_findings_employee_date_idx on public.attendance_review_findings (employee_id, attendance_date desc);
create index attendance_proposals_status_idx on public.attendance_correction_proposals (status, generated_at desc);
create index attendance_decisions_finding_idx on public.attendance_review_decisions (finding_id, created_at desc);
create index attendance_supersessions_previous_idx on public.attendance_calculation_supersessions (previous_calculation_id);

alter table public.attendance_analysis_runs enable row level security;
alter table public.attendance_review_findings enable row level security;
alter table public.attendance_correction_proposals enable row level security;
alter table public.attendance_review_decisions enable row level security;
alter table public.attendance_calculation_supersessions enable row level security;

create policy attendance_analysis_admin_access on public.attendance_analysis_runs
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::public.app_role[])));
create policy attendance_findings_admin_access on public.attendance_review_findings
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::public.app_role[])));
create policy attendance_proposals_admin_access on public.attendance_correction_proposals
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::public.app_role[])));
create policy attendance_decisions_admin_read on public.attendance_review_decisions
  for select to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])));
create policy attendance_decisions_admin_insert on public.attendance_review_decisions
  for insert to authenticated
  with check ((select public.user_has_any_role(array['administrator']::public.app_role[])) and actor_user_id = (select auth.uid()));
create policy attendance_supersessions_admin_access on public.attendance_calculation_supersessions
  for all to authenticated
  using ((select public.user_has_any_role(array['administrator']::public.app_role[])))
  with check ((select public.user_has_any_role(array['administrator']::public.app_role[])) and superseded_by = (select auth.uid()));

revoke all on public.attendance_analysis_runs, public.attendance_review_findings,
  public.attendance_correction_proposals, public.attendance_review_decisions,
  public.attendance_calculation_supersessions from anon, authenticated;
grant select on public.attendance_analysis_runs, public.attendance_review_findings,
  public.attendance_correction_proposals, public.attendance_review_decisions,
  public.attendance_calculation_supersessions to authenticated;
revoke insert on public.attendance_corrections from authenticated;

create trigger attendance_analysis_runs_audit after insert or update on public.attendance_analysis_runs
  for each row execute function public.write_audit_history();
create trigger attendance_review_findings_audit after insert or update on public.attendance_review_findings
  for each row execute function public.write_audit_history();
create trigger attendance_correction_proposals_audit after insert or update on public.attendance_correction_proposals
  for each row execute function public.write_audit_history();
create trigger attendance_review_decisions_append_only
  before update or delete on public.attendance_review_decisions
  for each row execute function public.prevent_attendance_evidence_mutation();
create trigger attendance_calculation_supersessions_append_only
  before update or delete on public.attendance_calculation_supersessions
  for each row execute function public.prevent_attendance_evidence_mutation();
create trigger attendance_calculation_supersessions_audit after insert on public.attendance_calculation_supersessions
  for each row execute function public.write_audit_history();

create or replace function public.persist_attendance_analysis(
  p_import_id uuid,
  p_period_from date,
  p_period_to date,
  p_source_record_count integer,
  p_summary jsonb,
  p_findings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_run_id uuid;
  v_finding_id uuid;
  v_finding jsonb;
  v_proposal jsonb;
  v_finding_count integer := 0;
  v_proposal_count integer := 0;
  v_owner uuid;
begin
  if not (select public.user_has_any_role(array['administrator']::public.app_role[])) then
    raise exception using errcode = '42501', message = 'Administrator access is required.';
  end if;
  if p_source_record_count < 0 or jsonb_typeof(p_findings) <> 'array' then
    raise exception using errcode = '22023', message = 'The attendance analysis payload is invalid.';
  end if;
  select uploaded_by into v_owner from public.attendance_imports where id = p_import_id;
  if v_owner is distinct from (select auth.uid()) then
    raise exception using errcode = '42501', message = 'Import is not owned by the signed-in administrator.';
  end if;

  update public.attendance_correction_proposals set status = 'superseded'
  where import_id = p_import_id and status in ('pending', 'investigation');
  update public.attendance_review_findings set status = 'superseded'
  where import_id = p_import_id and status in ('pending', 'investigation', 'unresolved');

  insert into public.attendance_analysis_runs (import_id, analyzed_by, status, period_from, period_to, source_record_count, summary, completed_at)
  values (p_import_id, (select auth.uid()), 'completed', p_period_from, p_period_to, p_source_record_count, coalesce(p_summary, '{}'::jsonb), now())
  returning id into v_run_id;

  for v_finding in select value from jsonb_array_elements(p_findings)
  loop
    insert into public.attendance_review_findings (
      analysis_run_id, import_id, employee_id, employee_number, employee_name,
      attendance_date, category, evidence_class, title, explanation,
      current_values, source_references, rules_version_id, calculation_id
    ) values (
      v_run_id, p_import_id, nullif(v_finding ->> 'employeeId', '')::uuid,
      nullif(v_finding ->> 'employeeNumber', ''), nullif(v_finding ->> 'employeeName', ''),
      nullif(v_finding ->> 'attendanceDate', '')::date,
      v_finding ->> 'category', v_finding ->> 'evidenceClass', v_finding ->> 'title', v_finding ->> 'explanation',
      coalesce(v_finding -> 'currentValues', '{}'::jsonb), coalesce(v_finding -> 'sourceReferences', '{}'::jsonb),
      nullif(v_finding ->> 'rulesVersionId', '')::uuid, nullif(v_finding ->> 'calculationId', '')::uuid
    ) returning id into v_finding_id;
    v_finding_count := v_finding_count + 1;

    v_proposal := v_finding -> 'proposal';
    if v_proposal is not null and jsonb_typeof(v_proposal) = 'object' then
      insert into public.attendance_correction_proposals (
        finding_id, import_id, employee_id, attendance_date, current_calculation_id,
        rules_version_id, affected_field, previous_value, proposed_value,
        proposed_calculation, source_references, explanation, confidence
      ) values (
        v_finding_id, p_import_id, (v_finding ->> 'employeeId')::uuid,
        (v_finding ->> 'attendanceDate')::date, (v_finding ->> 'calculationId')::uuid,
        (v_finding ->> 'rulesVersionId')::uuid, v_proposal ->> 'affectedField',
        coalesce(v_proposal -> 'previousValue', '{}'::jsonb), coalesce(v_proposal -> 'proposedValue', '{}'::jsonb),
        coalesce(v_proposal -> 'proposedCalculation', '{}'::jsonb),
        coalesce(v_finding -> 'sourceReferences', '{}'::jsonb),
        v_proposal ->> 'explanation', (v_proposal ->> 'confidence')::numeric
      );
      v_proposal_count := v_proposal_count + 1;
    end if;
  end loop;

  return jsonb_build_object('runId', v_run_id, 'findingCount', v_finding_count, 'proposalCount', v_proposal_count);
end;
$function$;

create or replace function public.decide_attendance_finding(
  p_finding_id uuid,
  p_action text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_finding public.attendance_review_findings%rowtype;
  v_proposal public.attendance_correction_proposals%rowtype;
  v_owner uuid;
  v_proposal_id uuid;
begin
  if not (select public.user_has_any_role(array['administrator']::public.app_role[])) then
    raise exception using errcode = '42501', message = 'Administrator access is required.';
  end if;
  if p_action not in ('approved', 'rejected', 'investigation', 'confirmed') then
    raise exception using errcode = '22023', message = 'Unsupported review decision.';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 or length(trim(p_reason)) > 1000 then
    raise exception using errcode = '22023', message = 'Enter a reason of 3 to 1000 characters.';
  end if;

  select * into v_finding from public.attendance_review_findings where id = p_finding_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Attendance finding not found.'; end if;
  select uploaded_by into v_owner from public.attendance_imports where id = v_finding.import_id;
  if v_owner is distinct from (select auth.uid()) then
    raise exception using errcode = '42501', message = 'Finding is not owned by the signed-in administrator.';
  end if;
  if v_finding.status in ('corrected', 'rejected', 'superseded') then
    raise exception using errcode = '55000', message = 'This finding already has a final decision.';
  end if;

  if p_action = 'approved' then
    select * into v_proposal from public.attendance_correction_proposals where finding_id = p_finding_id for update;
    if not found or v_proposal.status not in ('pending', 'failed', 'investigation', 'approved') then
      raise exception using errcode = '55000', message = 'There is no pending proposal to approve.';
    end if;
    update public.attendance_correction_proposals set status = 'approved', decided_by = (select auth.uid()),
      decided_at = now(), decision_note = trim(p_reason), application_error = null where id = v_proposal.id;
    update public.attendance_review_findings set status = 'approved', decided_by = (select auth.uid()),
      decided_at = now(), decision_note = trim(p_reason) where id = p_finding_id;
  elsif p_action = 'rejected' then
    update public.attendance_correction_proposals set status = 'rejected', decided_by = (select auth.uid()),
      decided_at = now(), decision_note = trim(p_reason) where finding_id = p_finding_id and status in ('pending', 'investigation', 'confirmed', 'approved', 'failed');
    update public.attendance_review_findings set status = 'rejected', decided_by = (select auth.uid()),
      decided_at = now(), decision_note = trim(p_reason) where id = p_finding_id;
  else
    update public.attendance_review_findings set status = p_action, decided_by = (select auth.uid()),
      decided_at = now(), decision_note = trim(p_reason) where id = p_finding_id;
    update public.attendance_correction_proposals set status = p_action, decided_by = (select auth.uid()),
      decided_at = now(), decision_note = trim(p_reason) where finding_id = p_finding_id and status in ('pending', 'investigation');
  end if;

  select id into v_proposal_id from public.attendance_correction_proposals where finding_id = p_finding_id;
  insert into public.attendance_review_decisions (finding_id, proposal_id, action, reason, actor_user_id)
  values (p_finding_id, v_proposal_id, p_action, trim(p_reason), (select auth.uid()));

  return jsonb_build_object('status', p_action, 'requiresApplication', p_action = 'approved');
end;
$function$;

create or replace function public.apply_attendance_correction_proposal(p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_proposal public.attendance_correction_proposals%rowtype;
  v_finding public.attendance_review_findings%rowtype;
  v_current public.daily_attendance_calculations%rowtype;
  v_calc jsonb;
  v_new_calculation_id uuid;
  v_next_version integer;
  v_latest_version integer;
  v_source_ids uuid[];
  v_current_source_ids uuid[];
  v_owner uuid;
  v_correction_id uuid;
  v_current_rule_id uuid;
  v_rule public.attendance_rule_versions%rowtype;
  v_first_recorded timestamptz;
  v_last_recorded timestamptz;
  v_first_in timestamptz;
  v_last_out timestamptz;
  v_event_count integer;
  v_weekend boolean;
  v_overtime boolean;
  v_completeness text;
  v_arrival_classification text;
  v_weekday text;
  v_review_issues jsonb := '[]'::jsonb;
  v_source_event_ids jsonb;
  v_arrival_minutes integer;
  v_normal_start_minutes integer;
  v_grace_minutes integer;
  v_very_late_minutes integer;
begin
  if not (select public.user_has_any_role(array['administrator']::public.app_role[])) then
    raise exception using errcode = '42501', message = 'Administrator access is required.';
  end if;
  select * into v_proposal from public.attendance_correction_proposals where id = p_proposal_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Correction proposal not found.'; end if;
  if v_proposal.status = 'applied' then
    return jsonb_build_object('status', 'applied', 'calculationId', v_proposal.resulting_calculation_id, 'alreadyApplied', true);
  end if;
  if v_proposal.status <> 'approved' then
    raise exception using errcode = '55000', message = 'Approve the proposal before applying it.';
  end if;
  select uploaded_by into v_owner from public.attendance_imports where id = v_proposal.import_id;
  if v_owner is distinct from (select auth.uid()) then
    raise exception using errcode = '42501', message = 'Proposal is not owned by the signed-in administrator.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_proposal.employee_id::text || ':' || v_proposal.attendance_date::text, 0));
  select * into v_current from public.daily_attendance_calculations where id = v_proposal.current_calculation_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'The source calculation no longer exists.'; end if;
  select coalesce(max(calculation_version), 0) into v_latest_version from public.daily_attendance_calculations
    where employee_id = v_proposal.employee_id and attendance_date = v_proposal.attendance_date;
  if v_current.calculation_version <> v_latest_version then
    raise exception using errcode = '40001', message = 'A newer calculation exists. Re-run analysis before applying this proposal.';
  end if;
  select id into v_current_rule_id from public.attendance_rule_versions
    where effective_from <= v_proposal.attendance_date
    order by effective_from desc, version desc limit 1;
  if v_current_rule_id is distinct from v_proposal.rules_version_id then
    raise exception using errcode = '40001', message = 'A newer attendance rule applies. Re-run analysis before applying this proposal.';
  end if;
  select * into v_rule from public.attendance_rule_versions where id = v_proposal.rules_version_id;
  if v_rule.attendance_timezone <> 'Africa/Kigali' then
    raise exception using errcode = '22023', message = 'The applicable attendance rule does not use Africa/Kigali.';
  end if;

  select coalesce(array_agg(coalesce(raw_fingerprint_event_id, organized_attendance_entry_id) order by coalesce(raw_fingerprint_event_id, organized_attendance_entry_id)), '{}')
    into v_current_source_ids from public.daily_attendance_evidence where daily_calculation_id = v_current.id;
  select coalesce(array_agg(evidence_id::uuid order by evidence_id::uuid), '{}') into v_source_ids
    from jsonb_array_elements_text(v_proposal.source_references -> 'evidenceIds') as evidence(evidence_id);
  if v_current_source_ids is distinct from v_source_ids then
    raise exception using errcode = '40001', message = 'The source evidence changed. Re-run analysis before applying this proposal.';
  end if;

  v_calc := v_proposal.proposed_calculation;
  if v_proposal.affected_field <> 'arrival_classification'
    or (v_proposal.previous_value ->> 'value') is distinct from v_current.arrival_classification::text then
    raise exception using errcode = '22023', message = 'This proposal does not target a supported attendance field.';
  end if;

  with source_events as (
    select event_at, direction, source_event_id from (
      select raw.normalized_timestamp as event_at,
        case when (raw.normalized_timestamp at time zone 'Africa/Kigali')::time < time '12:00' then 'IN'
             when (raw.normalized_timestamp at time zone 'Africa/Kigali')::time > time '12:00' then 'OUT' else null end as direction,
        raw.id::text as source_event_id
      from public.daily_attendance_evidence evidence
      join public.raw_fingerprint_events raw on raw.id = evidence.raw_fingerprint_event_id
      where evidence.daily_calculation_id = v_current.id and raw.normalized_timestamp is not null
      union all
      select entry.normalized_in_at, 'IN', entry.id::text || ':in'
      from public.daily_attendance_evidence evidence
      join public.organized_attendance_entries entry on entry.id = evidence.organized_attendance_entry_id
      where evidence.daily_calculation_id = v_current.id and entry.normalized_in_at is not null
      union all
      select entry.normalized_out_at, 'OUT', entry.id::text || ':out'
      from public.daily_attendance_evidence evidence
      join public.organized_attendance_entries entry on entry.id = evidence.organized_attendance_entry_id
      where evidence.daily_calculation_id = v_current.id and entry.normalized_out_at is not null
    ) events
    where (event_at at time zone 'Africa/Kigali')::date = v_proposal.attendance_date
  )
  select min(event_at), max(event_at), min(event_at) filter (where direction = 'IN'),
    max(event_at) filter (where direction = 'OUT'), count(*)::integer,
    coalesce(jsonb_agg(source_event_id order by event_at, source_event_id), '[]'::jsonb)
  into v_first_recorded, v_last_recorded, v_first_in, v_last_out, v_event_count, v_source_event_ids
  from source_events;

  if v_first_in is null then
    raise exception using errcode = '22023', message = 'The linked source evidence does not establish an arrival time.';
  end if;
  v_arrival_minutes := extract(hour from (v_first_in at time zone 'Africa/Kigali'))::integer * 60
    + extract(minute from (v_first_in at time zone 'Africa/Kigali'))::integer;
  v_normal_start_minutes := extract(hour from v_rule.normal_start)::integer * 60 + extract(minute from v_rule.normal_start)::integer;
  v_grace_minutes := extract(hour from v_rule.grace_until)::integer * 60 + extract(minute from v_rule.grace_until)::integer;
  v_very_late_minutes := extract(hour from v_rule.very_late_from)::integer * 60 + extract(minute from v_rule.very_late_from)::integer;
  v_arrival_classification := case when v_arrival_minutes < v_normal_start_minutes then 'before_start'
    when v_arrival_minutes < v_grace_minutes then 'on_time'
    when v_arrival_minutes < v_very_late_minutes then 'late' else 'very_late' end;
  if (v_proposal.proposed_value ->> 'value') is distinct from v_arrival_classification
    or (v_calc ->> 'arrivalClassification') is distinct from v_arrival_classification then
    raise exception using errcode = '22023', message = 'The proposed arrival classification does not match the saved source time and current rule.';
  end if;
  v_weekday := case extract(isodow from v_proposal.attendance_date)::integer when 6 then 'Saturday' when 7 then 'Sunday' else null end;
  v_weekend := v_weekday is not null;
  v_overtime := v_last_out is not null
    and (v_last_out at time zone 'Africa/Kigali')::time >= v_rule.overtime_from
    and (not v_weekend or coalesce((v_rule.policy -> 'weekendOvertimeDays') ? v_weekday, false));
  v_completeness := case when v_first_in is not null and v_last_out is not null then 'complete_evidence' else 'incomplete_evidence' end;
  if v_first_in is null then v_review_issues := v_review_issues || jsonb_build_array(jsonb_build_object('code', 'missing_in')); end if;
  if v_last_out is null then v_review_issues := v_review_issues || jsonb_build_array(jsonb_build_object('code', 'missing_out')); end if;
  if (v_calc ->> 'engineVersion') is distinct from '3' then
    raise exception using errcode = '22023', message = 'The proposal was generated with an unsupported attendance engine version.';
  end if;
  select coalesce(max(calculation_version), 0) + 1 into v_next_version from public.daily_attendance_calculations
    where employee_id = v_proposal.employee_id and attendance_date = v_proposal.attendance_date;

  insert into public.attendance_corrections (
    daily_calculation_id, correction_type, previous_values, corrected_values, reason, corrected_by,
    proposal_id, finding_id, rules_version_id
  ) values (
    v_current.id, v_proposal.affected_field, v_proposal.previous_value, v_proposal.proposed_value,
    coalesce(v_proposal.decision_note, 'Approved evidence-based attendance correction'), (select auth.uid()),
    v_proposal.id, v_proposal.finding_id, v_proposal.rules_version_id
  ) returning id into v_correction_id;

  insert into public.daily_attendance_calculations (
    employee_id, attendance_date, calculation_version, rules_version_id, first_recorded_at,
    last_recorded_at, recorded_event_count, arrival_classification, overtime_evidence,
    is_weekend, completeness, calculation_result, calculated_by
  ) values (
    v_proposal.employee_id, v_proposal.attendance_date, v_next_version, v_proposal.rules_version_id,
    v_first_recorded, v_last_recorded, coalesce(v_event_count, 0),
    v_arrival_classification::public.arrival_classification,
    v_overtime, v_weekend,
    v_completeness::public.calculation_completeness,
    jsonb_build_object('engineVersion', 3, 'rulesVersion', v_rule.version, 'sourceEventIds', v_source_event_ids,
      'directionPolicy', 'fingerprint-before-12-kigali-in-after-12-out', 'reviewIssues', v_review_issues,
      'approvedCorrectionId', v_correction_id, 'sourceProposalId', v_proposal.id),
    (select auth.uid())
  ) returning id into v_new_calculation_id;

  insert into public.daily_attendance_evidence (daily_calculation_id, raw_fingerprint_event_id, organized_attendance_entry_id)
  select v_new_calculation_id, raw_fingerprint_event_id, organized_attendance_entry_id
  from public.daily_attendance_evidence where daily_calculation_id = v_current.id;

  insert into public.attendance_calculation_supersessions (
    previous_calculation_id, replacement_calculation_id, proposal_id, superseded_by
  ) values (v_current.id, v_new_calculation_id, v_proposal.id, (select auth.uid()));

  update public.attendance_correction_proposals set status = 'applied', resulting_calculation_id = v_new_calculation_id,
    application_error = null where id = v_proposal.id;
  update public.attendance_review_findings set status = 'corrected' where id = v_proposal.finding_id;
  insert into public.attendance_review_decisions (finding_id, proposal_id, action, reason, actor_user_id, details)
  values (v_proposal.finding_id, v_proposal.id, 'application_applied', 'Correction applied to a new calculation version.', (select auth.uid()),
    jsonb_build_object('calculationId', v_new_calculation_id, 'previousCalculationId', v_current.id));

  return jsonb_build_object('status', 'applied', 'calculationId', v_new_calculation_id, 'alreadyApplied', false);
end;
$function$;

create or replace function public.mark_attendance_proposal_application_failed(p_proposal_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_proposal public.attendance_correction_proposals%rowtype;
  v_owner uuid;
begin
  if not (select public.user_has_any_role(array['administrator']::public.app_role[])) then
    raise exception using errcode = '42501', message = 'Administrator access is required.';
  end if;
  select * into v_proposal from public.attendance_correction_proposals where id = p_proposal_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Correction proposal not found.'; end if;
  select uploaded_by into v_owner from public.attendance_imports where id = v_proposal.import_id;
  if v_owner is distinct from (select auth.uid()) then raise exception using errcode = '42501', message = 'Proposal is not owned by the signed-in administrator.'; end if;
  if v_proposal.status not in ('approved', 'failed') then raise exception using errcode = '55000', message = 'Only an approved proposal can be marked failed.'; end if;
  update public.attendance_correction_proposals set status = 'failed', application_error = left(coalesce(p_error, 'Recalculation failed.'), 1000)
    where id = p_proposal_id;
  insert into public.attendance_review_decisions (finding_id, proposal_id, action, reason, actor_user_id)
  values (v_proposal.finding_id, v_proposal.id, 'application_failed', left(coalesce(p_error, 'Recalculation failed.'), 1000), (select auth.uid()));
end;
$function$;

revoke all on function public.persist_attendance_analysis(uuid, date, date, integer, jsonb, jsonb),
  public.decide_attendance_finding(uuid, text, text),
  public.apply_attendance_correction_proposal(uuid), public.mark_attendance_proposal_application_failed(uuid, text) from public, anon;
grant execute on function public.persist_attendance_analysis(uuid, date, date, integer, jsonb, jsonb),
  public.decide_attendance_finding(uuid, text, text),
  public.apply_attendance_correction_proposal(uuid), public.mark_attendance_proposal_application_failed(uuid, text) to authenticated;
