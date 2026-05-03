-- Supabase hardening round 2
-- Prepared: 2026-05-02
-- Goal:
-- 1) Remove SECURITY DEFINER view warning for public.user.
-- 2) Rewrite RLS policy auth helper calls to initplan-safe form.

-- Ensure the public.user view executes with caller permissions.
alter view public."user" set (security_invoker = true);

-- Rewrite policy expressions from auth.uid()/auth.role() to (select auth.uid())/(select auth.role()).
do $$
declare
  r record;
  new_qual text;
  new_check text;
  stmt text;
begin
  for r in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (
        coalesce(qual, '') like '%auth.uid()%' or
        coalesce(qual, '') like '%auth.role()%' or
        coalesce(with_check, '') like '%auth.uid()%' or
        coalesce(with_check, '') like '%auth.role()%'
      )
  loop
    new_qual := r.qual;
    new_check := r.with_check;

    if new_qual is not null then
      new_qual := replace(new_qual, 'auth.uid()', '(select auth.uid())');
      new_qual := replace(new_qual, 'auth.role()', '(select auth.role())');
    end if;

    if new_check is not null then
      new_check := replace(new_check, 'auth.uid()', '(select auth.uid())');
      new_check := replace(new_check, 'auth.role()', '(select auth.role())');
    end if;

    if new_qual is distinct from r.qual or new_check is distinct from r.with_check then
      stmt := format('alter policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);

      if new_qual is not null then
        stmt := stmt || format(' using (%s)', new_qual);
      end if;

      if new_check is not null then
        stmt := stmt || format(' with check (%s)', new_check);
      end if;

      execute stmt;
    end if;
  end loop;
end
$$;
