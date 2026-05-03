-- Phase 2: member_events table
-- Records guild join and leave events for activity tracking.

create table if not exists public.member_events (
  id              bigint generated always as identity primary key,
  discord_user_id text        not null,
  guild_id        text        not null,
  event_type      text        not null check (event_type in ('join', 'leave')),
  occurred_at     timestamptz not null default now()
);

create index if not exists member_events_discord_user_id_idx on public.member_events (discord_user_id);
create index if not exists member_events_occurred_at_idx     on public.member_events (occurred_at desc);
create index if not exists member_events_guild_id_idx        on public.member_events (guild_id);

alter table public.member_events enable row level security;

-- Service role has full access (bot writes via service role key)
-- No public read/write — Chief dashboard reads via service role admin client
