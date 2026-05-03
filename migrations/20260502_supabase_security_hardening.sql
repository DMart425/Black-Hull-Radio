-- Supabase security hardening
-- Prepared: 2026-05-02
-- Purpose: close advisor findings while preserving server-side service-role workflows.

-- 1) Protect broadcast embed batches table from anon/authenticated wide-open access.
alter table public.broadcast_embed_batches enable row level security;

-- Keep service-role access for backend API routes.
drop policy if exists "service role full access" on public.broadcast_embed_batches;
create policy "service role full access"
  on public.broadcast_embed_batches
  for all
  to service_role
  using (true)
  with check (true);

-- 2) Lock function search_path to avoid mutable search_path warnings.
-- increment_message_count signature verified from migration history.
alter function public.increment_message_count(text, date, text, integer)
  set search_path = public, pg_temp;

-- set_updated_at may be present from earlier non-repo schema work; guard it safely.
do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'set_updated_at'
      and pg_get_function_identity_arguments(p.oid) = ''
  ) then
    execute 'alter function public.set_updated_at() set search_path = public, pg_temp';
  end if;
end
$$;
