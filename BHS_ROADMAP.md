# BHS Bot & Website — Roadmap & Status
Last updated: 2026-05-02
Audit status: verified against live code on 2026-05-02

---

## Original 10-Phase Plan

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Scope & guardrails — define v1 features, role permissions, audit logs | ✅ Done |
| 1 | Config backbone — persisted config for channel routing, toggles, role rules, snippet metadata | 🟡 In progress |
| 2 | Telemetry — voice time, messages, joins/leaves, dashboard read APIs | 🟡 Partial |
| 3 | Utility controls — Org-Lit snippet manager + embed composer with validation | 🟡 Partial |
| 4 | Feed routing — RSI/ops/news post destinations dashboard-configurable | ❌ Not started |
| 5 | Integrations — Twitch/YouTube subscription alerts with de-dupe and routing | ❌ Not started |
| 6 | Automation — auto-roles, safe channel create/remove with strict auth | ❌ Not started |
| 7 | Ticketing — templates, channel provisioning, close/transcript flows | ❌ Not started |
| 8 | Party key dashboard — assign/revoke/revoke-all with full audit history | ✅ Done |
| 9 | Hardening & launch — feature flags, staged rollout, module-by-module enablement | ❌ Not started |

---

## What's Built (as of 2026-05-02)

### Bot (discord-afk-bot)

| Feature | Status | Notes |
|---------|--------|-------|
| Radio playback (voice, queue, skip, volume) | ✅ Complete | |
| RSI Comm-Link feed watcher | ✅ Complete | |
| RSI Status feed watcher | ✅ Complete | |
| RSI Patch Notes feed watcher | ✅ Complete | |
| Ops reminder system (windowed, forced, cleanup) | ✅ Complete | |
| Member admin slash commands (rank, authcheck, lookup, removed) | ✅ Complete | |
| Fleet slash commands (ships, summary, ship detail) | ✅ Complete | |
| Roster status command | ✅ Complete | |
| SnareHound party API (port 3002, key lifecycle, rate limiting) | ✅ Complete | |
| Party key slash commands (generate, revoke, revokeall) | ✅ Complete | |
| Activity tracking — voice sessions (with restart resume) | ✅ Complete | |
| Activity tracking — game sessions (all games, exclusion list, restart resume) | ✅ Complete | |
| Activity tracking — SnareHound sessions (idle timeout) | ✅ Complete | |
| Activity tracking — daily message counts | ✅ Complete | |
| Media sync (approved/updated/removed → Discord embeds + threads) | ✅ Complete | |
| Internal API (port 3001) — media events, system actions, party keys | ✅ Complete | |
| System health slash command | ✅ Complete | |
| Random roll command | ✅ Complete | |
| Join/leave tracking | ❌ Missing | Phase 2 gap |
| Config backbone (channel routing, toggles via dashboard) | ❌ Missing | Phase 1 |
| Twitch/YouTube alerts | ❌ Missing | Phase 5 |
| Auto-roles | ❌ Missing | Phase 6 |
| Channel create/remove workflows | ❌ Missing | Phase 6 |
| Ticketing | ❌ Missing | Phase 7 |

### Website (BHS-Website / Vercel)

| Feature | Status | Notes |
|---------|--------|-------|
| BHB Dashboard (Chief-only) | ✅ Complete | |
| System health panel (service signals, audit trail) | ✅ Complete | |
| SnareHound keys panel (list, generate, revoke, revoke-all, metadata) | ✅ Complete | Deployed 2026-05-02 |
| Activity leaderboard (voice/game/snare/messages, month + all-time) | ✅ Complete | |
| Embed builder (full Discord embed, field support) | ✅ Complete | |
| Batch embed posting to Discord | 🟡 Partial | Publish logic exists, upload endpoint not fully verified |
| Embed audit trail (create/update/publish/delete) | ✅ Complete | No browse UI yet |
| Org-Lit snippet manager | ❌ Missing | Phase 3 |
| Feed routing config (which channel gets RSI/ops/news posts) | ❌ Missing | Phase 4 |
| Twitch/YouTube alert config | ❌ Missing | Phase 5 |
| Auto-role config | ❌ Missing | Phase 6 |
| Ticket config/management | ❌ Missing | Phase 7 |

---

## Database Migrations Applied

| File | Description | Date |
|------|-------------|------|
| 20260404_roster_removals.sql | roster_removals table | 2026-04-04 |
| 20260405_media_discord_sync.sql | Discord sync columns on media_submissions | 2026-04-05 |
| 20260415_duty_access_flags.sql | Duty/access control flags | 2026-04-15 |
| 20260419_recruitment_discord_blocks.sql | Discord blocking for recruitment | 2026-04-19 |
| 20260425_recruitment_votes.sql | Vote tracking on recruitment reviews | 2026-04-25 |
| 20260502_activity_tracking.sql | activity_sessions + message_daily_counts tables | 2026-05-02 |
| 20260502_fix_activity_sessions_session_type_check.sql | Added 'game' to session_type constraint | 2026-05-02 |

---

## Live Supabase Audit (2026-05-02)

Verified present tables for implemented features:
- activity_sessions (rows observed: 34)
- message_daily_counts (rows observed: 2)
- broadcast_embeds (rows observed: 8)
- broadcast_embed_audit
- broadcast_embed_batches (rows observed: 1)
- system_events
- system_heartbeats

Verified constraint fix is active:
- activity_sessions.session_type check includes voice, game, snarehound.

Open security findings from Supabase advisors:
- ERROR: RLS disabled on public.broadcast_embed_batches.
- ERROR: SECURITY DEFINER view public.user.
- WARN: mutable search_path on functions public.increment_message_count and public.set_updated_at.

Open performance findings from Supabase advisors:
- INFO: several unindexed foreign keys (including broadcast_embed_audit.embed_id).
- WARN: auth_rls_initplan policies on ops tables (function calls not wrapped in SELECT).

Prepared migration files (saved for continuity; apply separately):
- migrations/20260502_supabase_security_hardening.sql
- migrations/20260502_supabase_performance_indexes.sql

Round 2 applied (2026-05-02):
- migrations/20260502_supabase_hardening_round2.sql

Round 2 results:
- Cleared: security_definer_view warning for public.user.
- Cleared: auth_rls_initplan warnings (policies rewritten to (select auth.*()) form).
- Remaining advisors are now general performance hygiene (unused indexes, duplicate indexes, and multiple permissive policy warnings), not critical security blockers.

---

## Next Up

**Phase 1 — Config backbone**
- One persisted config model covering: channel routing, feature toggles, role rules, snippet metadata
- Bot reads config on startup and hot-reloads from internal API
- Website dashboard exposes config editor (Chief-only)
- This unlocks Phases 4, 5, 6 (all need configurable channel routing and toggles)

Phase 1 progress shipped on 2026-05-02:
- Added Supabase table public.bot_runtime_config with singleton row `default`.
- Added internal bot endpoint GET /api/internal/bot-config (website) with bot-secret auth.
- Migration files added in both repos for continuity:
	- supabase/migrations/20260502_bot_runtime_config_backbone.sql (website)
	- migrations/20260502_bot_runtime_config_backbone.sql (bot)

---

## Bot Evidence Anchors

- Activity telemetry handlers and restart resume logic live in activity-tracker.js (voice, game, message counts, resume).
- Party key lifecycle and masking logic live in party-api.js; dashboard output is currently configured unmasked from index.js.
- Internal routes for party keys, channels, and batch embeds live in internal-api.js.
- SQL continuity file for the game session constraint fix is in migrations/20260502_fix_activity_sessions_session_type_check.sql.
