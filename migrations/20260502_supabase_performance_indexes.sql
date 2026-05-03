-- Supabase performance hardening indexes
-- Prepared: 2026-05-02
-- Purpose: address advisor findings for unindexed foreign keys.

create index if not exists idx_broadcast_embed_audit_embed_id
  on public.broadcast_embed_audit (embed_id);

create index if not exists idx_media_submissions_related_op_id
  on public.media_submissions (related_op_id);

create index if not exists idx_recruitment_application_events_actor_id
  on public.recruitment_application_events (actor_id);

create index if not exists idx_recruitment_application_notes_created_by
  on public.recruitment_application_notes (created_by);

create index if not exists idx_recruitment_application_reviews_reviewer_id
  on public.recruitment_application_reviews (reviewer_id);

create index if not exists idx_recruitment_applications_decided_by
  on public.recruitment_applications (decided_by);

create index if not exists idx_roster_rank_audit_changed_by
  on public.roster_rank_audit (changed_by);

create index if not exists idx_roster_removals_removed_by
  on public.roster_removals (removed_by);
