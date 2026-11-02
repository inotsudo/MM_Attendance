-- Reprocessing creates a new import revision linked to its source. The prior
-- import and its evidence remain immutable and available for audit.
alter table public.attendance_imports
  add column reprocessed_from_import_id uuid references public.attendance_imports(id) on delete restrict;

drop index if exists public.attendance_imports_checksum_unique_idx;
create unique index attendance_imports_original_checksum_unique_idx
  on public.attendance_imports (sha256_checksum)
  where reprocessed_from_import_id is null;

create index attendance_imports_reprocessing_parent_idx
  on public.attendance_imports (reprocessed_from_import_id, uploaded_at desc)
  where reprocessed_from_import_id is not null;
