-- Import support: stable file idempotency, cell-level Excel provenance, and an
-- atomic confirmation RPC. Source evidence is only inserted after administrator
-- preview and confirmation.

create unique index attendance_imports_checksum_unique_idx
  on public.attendance_imports (sha256_checksum);

alter table public.organized_attendance_entries
  add column source_column integer not null default 0 check (source_column >= 0);

alter table public.organized_attendance_entries
  drop constraint organized_attendance_entries_import_id_source_sheet_source__key;

alter table public.organized_attendance_entries
  add constraint organized_attendance_entries_source_cell_unique
  unique (import_id, source_sheet, source_row, source_column);

create or replace function public.confirm_attendance_import(
  p_import_id uuid,
  p_records jsonb,
  p_matches jsonb,
  p_review_items jsonb,
  p_calculations jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_import public.attendance_imports%rowtype;
  v_record jsonb;
  v_match jsonb;
  v_review jsonb;
  v_calculation jsonb;
  v_source_reference jsonb;
  v_index integer;
  v_source_index integer;
  v_event_id uuid;
  v_entry_id uuid;
  v_calculation_id uuid;
  v_employee_id uuid;
  v_calculation_version integer;
  v_review_count integer := 0;
  v_record_count integer := 0;
  v_existing_count integer := 0;
  v_status public.import_processing_status;
begin
  select * into v_import
  from public.attendance_imports
  where id = p_import_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Attendance import not found.';
  end if;
  if v_import.uploaded_by is distinct from (select auth.uid()) then
    raise exception using errcode = '42501', message = 'Import is not owned by the signed-in administrator.';
  end if;
  if v_import.processing_status = 'completed' then
    return jsonb_build_object('alreadyCompleted', true, 'status', 'completed');
  end if;
  if v_import.source_type = 'ivms_pdf_original_records' then
    select count(*) into v_existing_count from public.raw_fingerprint_events where import_id = p_import_id;
  else
    select count(*) into v_existing_count from public.organized_attendance_entries where import_id = p_import_id;
  end if;
  if v_existing_count > 0 then
    return jsonb_build_object('alreadyCompleted', true, 'status', v_import.processing_status);
  end if;
  if v_import.processing_status not in ('parsed', 'needs_review') then
    raise exception using errcode = '55000', message = 'Import must be previewed before confirmation.';
  end if;
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) = 0
     or jsonb_typeof(p_matches) <> 'array'
     or jsonb_array_length(p_records) <> jsonb_array_length(p_matches)
     or jsonb_typeof(p_review_items) <> 'array'
     or jsonb_typeof(p_calculations) <> 'array' then
    raise exception using errcode = '22023', message = 'Import confirmation payload is invalid.';
  end if;

  for v_record, v_index in
    select value, ordinality::integer
    from jsonb_array_elements(p_records) with ordinality
  loop
    v_match := p_matches -> (v_index - 1);
    v_employee_id := nullif(v_match ->> 'employeeId', '')::uuid;
    v_event_id := null;
    v_entry_id := null;

    if v_import.source_type = 'ivms_pdf_original_records' then
      insert into public.raw_fingerprint_events (
        import_id, source_page, source_row, source_event_identifier,
        source_employee_number, source_employee_name, source_department,
        source_timestamp_text, normalized_timestamp, source_status, checkpoint, raw_evidence
      ) values (
        p_import_id,
        nullif(v_record ->> 'sourcePage', '')::integer,
        nullif(v_record ->> 'sourceRow', '')::integer,
        nullif(v_record ->> 'sourceEventIdentifier', ''),
        nullif(v_record ->> 'employeeNumber', ''),
        nullif(v_record ->> 'employeeName', ''),
        nullif(v_record ->> 'department', ''),
        coalesce(v_record ->> 'sourceTimestamp', ''),
        nullif(v_record ->> 'normalizedTimestamp', '')::timestamptz,
        nullif(v_record ->> 'attendanceStatus', ''),
        nullif(v_record ->> 'checkpoint', ''),
        coalesce(v_record -> 'fields', '{}'::jsonb)
          || jsonb_build_object('rawText', coalesce(v_record -> 'rawText', 'null'::jsonb))
      ) returning id into v_event_id;
    else
      insert into public.organized_attendance_entries (
        import_id, source_sheet, source_row, source_column,
        source_employee_number, source_employee_name, source_department,
        source_work_date_text, normalized_work_date, source_in_text,
        normalized_in_at, source_out_text, normalized_out_at, raw_evidence
      ) values (
        p_import_id,
        nullif(v_record ->> 'sourceSheet', ''),
        (v_record ->> 'sourceRow')::integer,
        coalesce((v_record ->> 'sourceColumn')::integer, 0),
        nullif(v_record ->> 'employeeNumber', ''),
        nullif(v_record ->> 'employeeName', ''),
        nullif(v_record ->> 'department', ''),
        coalesce(v_record ->> 'sourceWorkDate', ''),
        nullif(v_record ->> 'normalizedWorkDate', '')::date,
        nullif(v_record ->> 'sourceIn', ''),
        nullif(v_record ->> 'normalizedInAt', '')::timestamptz,
        nullif(v_record ->> 'sourceOut', ''),
        nullif(v_record ->> 'normalizedOutAt', '')::timestamptz,
        coalesce(v_record -> 'rawValues', '{}'::jsonb)
      ) returning id into v_entry_id;
    end if;

    insert into public.employee_match_decisions (
      raw_fingerprint_event_id, organized_attendance_entry_id, employee_id,
      match_status, match_method, confidence, decided_by, decision_note
    ) values (
      v_event_id, v_entry_id, v_employee_id,
      case when v_employee_id is null then 'unmatched'::public.employee_match_status else 'matched'::public.employee_match_status end,
      case when v_employee_id is null then null
        when coalesce(v_match ->> 'method', '') = 'employee_number' then 'employee_number'::public.employee_match_method
        else 'manual'::public.employee_match_method end,
      case when v_employee_id is null then null else 1 end,
      (select auth.uid()),
      nullif(v_match ->> 'note', '')
    );
    v_record_count := v_record_count + 1;

    for v_review in
      select value
      from jsonb_array_elements(p_review_items)
      where (value ->> 'sourceIndex')::integer = (v_record ->> 'sourceIndex')::integer
    loop
      insert into public.attendance_review_items (
        import_id, raw_fingerprint_event_id, organized_attendance_entry_id,
        issue_code, severity, description, evidence
      ) values (
        p_import_id, v_event_id, v_entry_id,
        v_review ->> 'code', coalesce(v_review ->> 'severity', 'warning'),
        v_review ->> 'message', coalesce(v_review -> 'evidence', '{}'::jsonb)
      );
      v_review_count := v_review_count + 1;
    end loop;
  end loop;

  for v_review in
    select value from jsonb_array_elements(p_review_items)
    where coalesce(value ->> 'sourceIndex', '') = ''
  loop
    insert into public.attendance_review_items (
      import_id, issue_code, severity, description, evidence
    ) values (
      p_import_id, v_review ->> 'code', coalesce(v_review ->> 'severity', 'warning'),
      v_review ->> 'message', coalesce(v_review -> 'evidence', '{}'::jsonb)
    );
    v_review_count := v_review_count + 1;
  end loop;

  for v_calculation in select value from jsonb_array_elements(p_calculations)
  loop
    v_employee_id := (v_calculation ->> 'employeeId')::uuid;
    perform pg_advisory_xact_lock(hashtextextended(v_employee_id::text || ':' || (v_calculation ->> 'attendanceDate'), 0));
    select coalesce(max(calculation_version), 0) + 1 into v_calculation_version
    from public.daily_attendance_calculations
    where employee_id = v_employee_id
      and attendance_date = (v_calculation ->> 'attendanceDate')::date;

    insert into public.daily_attendance_calculations (
      employee_id, attendance_date, calculation_version, rules_version_id,
      first_recorded_at, last_recorded_at, recorded_event_count,
      arrival_classification, overtime_evidence, is_weekend, completeness,
      calculation_result, calculated_by
    ) values (
      v_employee_id,
      (v_calculation ->> 'attendanceDate')::date,
      v_calculation_version,
      (v_calculation ->> 'rulesVersionId')::uuid,
      nullif(v_calculation ->> 'firstRecordedAt', '')::timestamptz,
      nullif(v_calculation ->> 'lastRecordedAt', '')::timestamptz,
      (v_calculation ->> 'recordedEventCount')::integer,
      (v_calculation ->> 'arrivalClassification')::public.arrival_classification,
      coalesce((v_calculation ->> 'overtimeEvidence')::boolean, false),
      coalesce((v_calculation ->> 'isWeekend')::boolean, false),
      (v_calculation ->> 'completeness')::public.calculation_completeness,
      coalesce(v_calculation -> 'calculationResult', '{}'::jsonb),
      (select auth.uid())
    ) returning id into v_calculation_id;

    for v_source_index in
      select value::integer from jsonb_array_elements_text(v_calculation -> 'sourceIndices')
    loop
      v_source_reference := p_records -> (v_source_index - 1);
      if v_import.source_type = 'ivms_pdf_original_records' then
        select id into v_event_id from public.raw_fingerprint_events
        where import_id = p_import_id
          and source_page = (v_source_reference ->> 'sourcePage')::integer
          and source_row = (v_source_reference ->> 'sourceRow')::integer;
        insert into public.daily_attendance_evidence (daily_calculation_id, raw_fingerprint_event_id)
        values (v_calculation_id, v_event_id);
      else
        select id into v_entry_id from public.organized_attendance_entries
        where import_id = p_import_id
          and source_sheet = v_source_reference ->> 'sourceSheet'
          and source_row = (v_source_reference ->> 'sourceRow')::integer
          and source_column = (v_source_reference ->> 'sourceColumn')::integer;
        insert into public.daily_attendance_evidence (daily_calculation_id, organized_attendance_entry_id)
        values (v_calculation_id, v_entry_id);
      end if;
    end loop;
  end loop;

  v_status := case when v_review_count > 0 then 'needs_review'::public.import_processing_status else 'completed'::public.import_processing_status end;
  update public.attendance_imports
  set processing_status = v_status,
      processing_error = null,
      processing_completed_at = now()
  where id = p_import_id;

  return jsonb_build_object(
    'alreadyCompleted', false,
    'status', v_status,
    'recordCount', v_record_count,
    'reviewCount', v_review_count
  );
end;
$function$;

revoke all on function public.confirm_attendance_import(uuid, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.confirm_attendance_import(uuid, jsonb, jsonb, jsonb, jsonb) to authenticated;
