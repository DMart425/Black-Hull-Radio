-- Phase 1: Configuration backbone for bot runtime behavior
-- Stores channel routing, feature toggles, role rules, and snippet metadata.

create table if not exists public.bot_runtime_config (
  config_key text primary key,
  channel_routing jsonb not null default '{}'::jsonb,
  feature_toggles jsonb not null default '{}'::jsonb,
  role_rules jsonb not null default '{}'::jsonb,
  snippet_metadata jsonb not null default '{}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Keep a canonical singleton row the bot can read.
insert into public.bot_runtime_config (config_key)
values ('default')
on conflict (config_key) do nothing;

alter table public.bot_runtime_config enable row level security;

drop policy if exists "service role full access" on public.bot_runtime_config;
create policy "service role full access"
  on public.bot_runtime_config
  for all
  to service_role
  using (true)
  with check (true);

create index if not exists bot_runtime_config_updated_at_idx
  on public.bot_runtime_config (updated_at desc);
