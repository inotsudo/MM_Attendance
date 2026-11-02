-- Keep the existing import pipeline compatibility status while adding an explicit
-- administrator review lifecycle and review actor metadata.
alter table public.attendance_review_items
  add column review_state text not null default 'pending',
  add column reviewed_by uuid references public.user_profiles (id) on delete restrict,
  add column reviewed_at timestamptz;

update public.attendance_review_items
set review_state = case status::text
      when 'resolved' then 'confirmed'
      when 'dismissed' then 'rejected'
      else 'pending'
    end,
    reviewed_by = resolved_by,
    reviewed_at = resolved_at;

alter table public.attendance_review_items
  add constraint attendance_review_items_review_state_check
    check (review_state in ('pending', 'under_review', 'confirmed', 'corrected', 'unresolved', 'rejected')),
  add constraint attendance_review_items_review_actor_check
    check ((reviewed_by is null and reviewed_at is null) or (reviewed_by is not null and reviewed_at is not null));

create index attendance_review_state_created_idx
  on public.attendance_review_items (review_state, created_at desc);

create or replace function public.update_attendance_review_item(
  p_review_item_id uuid,
  p_next_state text,
  p_note text,
  p_employee_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_item public.attendance_review_items%rowtype;
  v_import_owner uuid;
  v_employee_active boolean;
  v_terminal boolean;
  v_effective_state text;
begin
  if p_next_state not in ('pending', 'under_review', 'confirmed', 'corrected', 'unresolved', 'rejected') then
    raise exception using errcode = '22023', message = 'Unsupported review status.';
  end if;
  if p_next_state = 'corrected' and p_employee_id is null then
    raise exception using errcode = '22023', message = 'Mark an item corrected only through a source-backed correction and recalculation.';
  end if;
  if length(trim(coalesce(p_note, ''))) = 0 then
    raise exception using errcode = '22023', message = 'Enter a review note before saving.';
  end if;

  select * into v_item
  from public.attendance_review_items
  where id = p_review_item_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Review item not found.';
  end if;

  select uploaded_by into v_import_owner
  from public.attendance_imports where id = v_item.import_id;
  if v_import_owner is distinct from (select auth.uid()) then
    raise exception using errcode = '42501', message = 'Review item is not owned by the signed-in administrator.';
  end if;

  if p_employee_id is not null then
    if p_next_state <> 'confirmed'
      or v_item.issue_code not in ('unmatched_employee', 'conflicting_employee', 'missing_employee_id')
      or num_nonnulls(v_item.raw_fingerprint_event_id, v_item.organized_attendance_entry_id) <> 1 then
      raise exception using errcode = '22023', message = 'This review item cannot be resolved as an employee match.';
    end if;
    select is_active into v_employee_active from public.employees where id = p_employee_id;
    if v_employee_active is distinct from true then
      raise exception using errcode = '22023', message = 'The selected employee is inactive or unavailable.';
    end if;
    insert into public.employee_match_decisions (
      raw_fingerprint_event_id, organized_attendance_entry_id, employee_id,
      match_status, match_method, confidence, decided_by, decision_note
    ) values (
      v_item.raw_fingerprint_event_id,
      v_item.organized_attendance_entry_id,
      p_employee_id,
      'matched', 'manual', 1, (select auth.uid()), trim(p_note)
    );
    -- Persist the administrator's identity decision, but keep the issue open
    -- until a new calculation is created from the newly matched source event.
    v_effective_state := 'unresolved';
  elsif p_next_state = 'confirmed'
    and v_item.issue_code in ('unmatched_employee', 'conflicting_employee', 'missing_employee_id') then
    raise exception using errcode = '22023', message = 'Select an active employee before confirming this identity match.';
  else
    v_effective_state := p_next_state;
  end if;

  v_terminal := v_effective_state in ('confirmed', 'corrected', 'rejected');
  update public.attendance_review_items
  set review_state = v_effective_state,
      status = case
        when v_effective_state in ('confirmed', 'corrected') then 'resolved'::public.review_item_status
        when v_effective_state = 'rejected' then 'dismissed'::public.review_item_status
        else 'open'::public.review_item_status
      end,
      resolution_note = trim(p_note),
      reviewed_by = (select auth.uid()),
      reviewed_at = now(),
      resolved_by = case when v_terminal then (select auth.uid()) else null end,
      resolved_at = case when v_terminal then now() else null end
  where id = p_review_item_id;

  return jsonb_build_object('status', v_effective_state, 'requiresReprocessing', p_employee_id is not null, 'alreadyUpdated', false);
end;
$function$;

revoke all on function public.update_attendance_review_item(uuid, text, text, uuid) from public, anon;
grant execute on function public.update_attendance_review_item(uuid, text, text, uuid) to authenticated;
