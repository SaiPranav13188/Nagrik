# Civic Complaint Agent — Fully Agentic Implementation Prompt

Build a mobile app where a fully agentic AI system handles a civic complaint end-to-end: analyzing a photographed issue, determining the responsible government department, drafting a formal complaint, **submitting it directly to the real portal via browser automation**, and then **autonomously monitoring and escalating** it over time — with minimal required human intervention at each step.

## What "totally agentic" means in this build

Every stage — classification, jurisdiction reasoning, drafting, submission, monitoring, and escalation decisions — is handled by an agent deciding its own actions using tools, not by hardcoded application logic. The one exception, kept deliberately: a lightweight final confirmation before submission (see "Design decision" below) — everything else runs autonomously.

## Design decision: why one human checkpoint stays, and how to remove it if you want zero-touch

Unlike WhatsApp or UPI (which block automation by design — biometric confirmation, no public API), government complaint portals are usually standard public web forms, so **automating the actual submission is technically realistic** using a headless browser (Playwright) as a tool the agent can call. I've built this in as the default path.

I'd still recommend keeping a brief "reviewing and submitting your complaint..." confirmation toast (not a blocking approval screen) before the first-ever submission to a new portal, since:
- CAPTCHAs will sometimes block automation entirely (the agent needs to detect this and fall back gracefully, not fail silently)
- A wrong jurisdiction determination on a fully unattended run means a complaint goes to the wrong department with no one noticing until much later

If you want **zero human touch at all**, set `autoSubmit: true` in the complaint config (see schema below) — the architecture supports it either way; this is a configuration toggle, not a structural limitation.

---

## Stack

- **Mobile**: Expo (React Native) — photo capture, location, complaint feed, status dashboard
- **Backend**: Node.js/Express on Render
- **Agent orchestration**: Vercel AI SDK
- **Model**: Google Gemini API (vision-capable model version, for photo analysis)
- **Database**: Supabase (Postgres + Row-Level Security)
- **Browser automation**: Playwright (running server-side on Render — note: browser automation is resource-heavier than typical API calls, so plan for a Render instance size that can handle a headless Chromium process, and consider a queue so submissions run one at a time rather than concurrently maxing out memory)

---

## Database schema (Supabase)

- **complaints**: `id`, `user_id`, `photo_url`, `issue_type`, `description`, `latitude`, `longitude`, `address`, `jurisdiction_department`, `jurisdiction_portal_id` (references jurisdiction_lookup), `draft_text`, `status` (`analyzing`/`drafted`/`submitting`/`submitted`/`submission_failed`/`escalated`/`resolved`), `tracking_id` (nullable, captured automatically from the portal's confirmation page where possible), `auto_submit` (bool, default true), `created_at`, `updated_at`
- **jurisdiction_lookup**: `id`, `city`, `state`, `issue_type`, `department_name`, `portal_url`, `form_selectors` (jsonb — CSS selectors/field mappings Playwright uses to fill this specific portal's form, since every portal's HTML is different), `status_check_url_template` (nullable), `status_check_selectors` (jsonb, nullable), `escalation_contact`, `requires_captcha` (bool), `notes` — admin-maintained; new entries proposed by the agent go through review before being trusted (see Jurisdiction Agent)
- **complaint_status_checks**: `id`, `complaint_id`, `checked_at`, `status_found`, `source` (`scraped`/`user_reported`), `raw_snapshot` (text, for debugging when scraping breaks)
- **complaint_escalations**: `id`, `complaint_id`, `escalation_level`, `action_taken`, `created_at`
- **agent_tool_logs**: `id`, `agent_name`, `complaint_id`, `tool_name`, `arguments` (jsonb), `result` (jsonb), `created_at`

RLS: users see only their own complaints; `jurisdiction_lookup` readable by all authenticated users, writable only via an admin-reviewed path.

---

## Agent 1: Intake Agent (photo → structured issue)

**Tools:**
- `analyze_photo(imageData)` — Gemini vision call; classifies issue type (pothole/streetlight/garbage/water leakage/other) and generates a factual, formal-toned description
- `reverse_geocode(lat, lng)` — Nominatim (free, no key), consistent with your existing Journi pattern
- `save_complaint(userId, issueType, description, lat, lng, address, photoUrl)`

**Loop:** if the photo is ambiguous (could plausibly be two different issue types), the agent should ask one clarifying question rather than guess — a wrong classification here cascades into a wrong department downstream.

---

## Agent 2: Jurisdiction Agent

**Tools:**
- `lookup_jurisdiction(city, state, issueType)` — checks `jurisdiction_lookup`
- `web_search(query)` — fallback only, when no entry exists
- `propose_new_jurisdiction(city, state, issueType, department, portalUrl, sourceUrls)` — writes to a `pending` review state, never directly to the trusted table

**Loop:** prefer the trusted lookup table; only fall back to search when nothing matches, and always route new mappings through human review before they're trusted for autonomous submission — an autonomous system misrouting real complaints at scale is the actual failure mode worth guarding against here, not a minor inconvenience.

---

## Agent 3: Drafting Agent

**Tools:**
- `get_complaint_context(complaintId)`
- `draft_complaint_text(context, portalRequirements)` — generates the complaint in whatever structure the specific portal expects (pulled from `jurisdiction_lookup.notes`)
- `save_draft(complaintId, draftText)`

---

## Agent 4: Submission Agent (the fully agentic core)

**Tools:**
- `get_form_selectors(portalId)` — pulls the `form_selectors` mapping for this specific portal
- `fill_and_submit_form(portalUrl, formSelectors, complaintData)` — uses Playwright to open the portal, fill each mapped field (name, address, issue description, photo upload if the portal supports it), and submit
- `detect_captcha(pageContent)` — checks if the loaded page contains a CAPTCHA challenge
- `extract_confirmation_details(pageContent)` — after successful submission, scrapes the confirmation page for a tracking/reference ID
- `flag_submission_failure(complaintId, reason)` — called when CAPTCHA blocks the flow, a form field can't be matched, or the portal returns an error — this hands the complaint back to a manual-submission fallback (show the drafted text + portal link in the app for the user to submit by hand) rather than failing silently

**Loop:** attempt automated submission. If `detect_captcha` finds a CAPTCHA, immediately call `flag_submission_failure` rather than attempting to bypass it (CAPTCHA-solving services exist but introduce cost, reliability, and ethical/ToS complications not worth taking on for this project). If submission succeeds, call `extract_confirmation_details` to capture the tracking ID automatically — this is what makes downstream monitoring fully autonomous too, since you don't have to manually type in a tracking number.

---

## Agent 5: Monitoring & Escalation Agent (scheduled, node-cron)

**Tools:**
- `list_submitted_complaints_needing_check()` — complaints in `submitted` status, due for a recheck (e.g., every 3 days)
- `check_status_via_scraper(complaintId, statusCheckUrl, statusSelectors, trackingId)` — Playwright navigates to the portal's status page, enters the tracking ID if needed, scrapes the current status
- `draft_escalation(complaintId, escalationLevel, context)` — drafts a formal escalation to the next authority (`jurisdiction_lookup.escalation_contact`)
- `submit_escalation(escalationDraft, escalationContact)` — sends via email (if the escalation contact is an email address, this can be fully automated using a transactional email API) or flags for manual submission if the escalation contact is another web portal without known selectors yet
- `mark_resolved(complaintId)`
- `notify_user(complaintId, message)` — push notification via Expo's notification service, so the user stays informed even though the whole loop runs unattended

**Loop, per complaint:** check status → if resolved, mark and notify; if unchanged past the escalation threshold (e.g., 10 days), decide the appropriate escalation level and draft + (where possible) autonomously send the escalation; if a new portal/escalation contact has no selectors/mapping yet, flag for the same human-review path as new jurisdictions rather than guessing at automation for an unmapped destination.

---

## Backend API (Express, Render)

- `POST /complaints/analyze`
- `POST /complaints/:id/determine-jurisdiction`
- `POST /complaints/:id/draft`
- `POST /complaints/:id/submit` — triggers the fully agentic Submission Agent
- `POST /jobs/monitor-complaints` — node-cron trigger for the Monitoring & Escalation Agent
- `POST /admin/jurisdiction/review` — approve/reject proposed jurisdiction mappings and form selectors
- `GET /complaints/:id/status`
- `GET /health`

---

## Guardrails (kept even in the fully agentic design)

- New jurisdiction mappings and new portal form-selector mappings always go through human/admin review before an agent is allowed to auto-submit through them — this protects against misrouted complaints and against Playwright blindly submitting garbage into unmapped form fields.
- CAPTCHA detection always triggers graceful fallback to manual submission, never a bypass attempt.
- Every tool call, on every agent, logged to `agent_tool_logs` — this matters even more here than in Journi, since a fully unattended pipeline needs strong observability to catch problems you won't be watching for in real time.
- Escalation emails/submissions still go through the same "only act on reviewed/trusted contacts" rule as the original submission step.

---

## Practical build order

1. **Shared infra first**: Supabase schema, `agent_tool_logs`, the Playwright automation harness as a standalone tested utility (get it reliably filling and submitting ONE real portal's form before wiring it into any agent).
2. **Intake + Jurisdiction agents** — fully autonomous, no automation risk, easiest to get right first, using a manually seeded `jurisdiction_lookup` for your own city to start.
3. **Drafting Agent** — straightforward once the above work.
4. **Submission Agent** — build and test against your one seeded portal thoroughly, including deliberately testing the CAPTCHA-fallback path, before trusting it to run unattended.
5. **Monitoring & Escalation Agent** — last, since it depends on submission already working reliably and having real tracking IDs to check against.

## Evaluation

- Test the Intake + Jurisdiction agents against 10-15 real photos from your area, verified against the actual published department responsible for each issue type in your city.
- Test the Submission Agent against your one seeded portal repeatedly over a few days — portal HTML can change, and you want to catch a broken selector quickly rather than have silent submission failures pile up unnoticed in a fully autonomous system.
- Log and review CAPTCHA-fallback triggers to gauge what percentage of real submissions your target portal(s) actually allow to be automated versus requiring manual completion — this is useful, honest data for explaining the project's real-world coverage in an interview.
