-- Nagrik: escalation emails need the citizen's approval.
-- The monitoring agent only saves a draft (awaiting_approval); the email is sent when the citizen
-- approves that exact text in the app. Run in the Supabase SQL editor after 0002.

alter table public.complaint_escalations add column if not exists subject text;
alter table public.complaint_escalations add column if not exists body text;
alter table public.complaint_escalations add column if not exists approved_by uuid references auth.users (id) on delete set null;
alter table public.complaint_escalations add column if not exists approved_at timestamptz;
alter table public.complaint_escalations add column if not exists reminded_at timestamptz;

alter table public.complaint_escalations drop constraint if exists complaint_escalations_delivery_status_check;
alter table public.complaint_escalations add constraint complaint_escalations_delivery_status_check
  check (delivery_status in ('awaiting_approval','cancelled','sent','manual_required','blocked_unverified','failed'));

-- Per-user daily limit on approved escalation emails.
create index if not exists escalations_approved_idx on public.complaint_escalations (approved_by, approved_at desc);
