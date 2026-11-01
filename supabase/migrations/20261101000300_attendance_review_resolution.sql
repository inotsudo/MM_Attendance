create or replace function public.resolve_attendance_review_item(
  p_review_item_id uuid,
  p_resolution_note text,
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
begin
  select * into v_item
  from public.attendance_review_items
  where id = p_review_item_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Review item not found.';
  end if;
  if v_item.status <> 'open' then
    return jsonb_build_object('alreadyResolved', true, 'status', v_item.status);
  end if;

  select uploaded_by into v_import_owner
  from public.attendance_imports where id = v_item.import_id;
  if v_import_owner is distinct from (select auth.uid()) then
    raise exception using errcode = '42501', message = 'Review item is not owned by the signed-in administrator.';
  end if;
  if length(trim(coalesce(p_resolution_note, ''))) = 0 then
    raise exception using errcode = '22023', message = 'A resolution note is required.';
  end if;

  if p_employee_id is not null then
    if v_item.issue_code not in ('unmatched_employee', 'conflicting_employee', 'missing_employee_id')
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
      'matched', 'manual', 1, (select auth.uid()), trim(p_resolution_note)
    );
  end if;

  update public.attendance_review_items
  set status = 'resolved', resolution_note = trim(p_resolution_note),
      resolved_by = (select auth.uid()), resolved_at = now()
  where id = p_review_item_id;

  return jsonb_build_object('alreadyResolved', false, 'status', 'resolved');
end;
$function$;

revoke all on function public.resolve_attendance_review_item(uuid, text, uuid) from public, anon;
grant execute on function public.resolve_attendance_review_item(uuid, text, uuid) to authenticated;
