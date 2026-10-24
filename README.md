# Nagrik — agentic civic complaints

[![CI](https://github.com/SaiPranav13188/Nagrik/actions/workflows/ci.yml/badge.svg)](https://github.com/SaiPranav13188/Nagrik/actions/workflows/ci.yml)

Take a photo of a civic problem. AI agents classify it, work out which government office is responsible, write a formal complaint, file it on the official portal with a headless browser, then keep checking on it and escalate when nothing happens.

Seeded for **Wanaparthy (PIN 509103), Telangana**. The app is in English, Telugu and Hindi.

```
 Expo app ──► Express API ──► Coordinator agent
 (photo, GPS)                    ├─ Intake agent        Gemini vision · Nominatim
                                 ├─ Jurisdiction agent  verified lookup table → web search → admin review
                                 ├─ Drafting agent      portal-specific formal letter
                                 └─ Submission agent    Playwright → tracking ID, or hand-off to citizen
                node-cron ──► Monitoring & Escalation agent  status scrape → escalate → notify
```

Every stage is an AI SDK `generateText` tool loop: the model picks its next action. The safety rules are enforced inside the tools, so a model can't talk its way around them. Every tool call is written to `agent_tool_logs`.

---

## Quick start (no accounts or keys needed)

Requirements: Node 20+.

```bash
# 1. Backend
cd backend
npm install            # also downloads headless Chromium
npm run dev            # http://localhost:4000

# 2. App (in a second terminal)
cd mobile
npm install
npx expo start         # scan the QR code with Expo Go (phone must be on the same Wi-Fi)
```

Without any keys the backend runs fully offline:

| Piece | Without keys | With keys |
|---|---|---|
| Data | JSON store in `backend/.data/` | Supabase Postgres + Storage |
| Sign-in | Device token | Supabase email OTP |
| Agent decisions | Rule-based **offline planner** (same tool-loop code path) | Gemini |
| Photo analysis | Asks the citizen to choose the issue type | Gemini vision |
| Escalation email | Letter prepared for the citizen to send | Sent through Resend |

Useful local URLs:

- **Admin console:** http://localhost:4000/admin (key: `admin-dev-key`). Use it to review agent-proposed mappings, read every agent tool call, see automation and CAPTCHA stats, and control the sandbox portal.
- **Sandbox portal:** http://localhost:4000/sandbox-portal. This is a copy of the municipal grievance form, so the whole loop can be tested without filing anything with a real office.

### Turning on the real services

1. **Gemini** (free): get a key at https://aistudio.google.com/apikey and set `GEMINI_API_KEY` in `backend/.env`.
2. **Supabase:**
   1. Create a project.
   2. Run `supabase/migrations/0001_nagrik_schema.sql` in the SQL editor.
   3. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `backend/.env`.
   4. Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` in `mobile/.env`.
   5. In Auth → Email Templates, make the magic-link template include `{{ .Token }}` so users receive a 6-digit code.
3. **Resend** (optional): set `RESEND_API_KEY`. Real government inboxes are only emailed when `ALLOW_LIVE_ESCALATION_EMAILS=true`.
4. **Real portals:** set `PORTAL_MODE=live`.

See `backend/.env.example` for every setting.

---

## Behaviour against the real Wanaparthy portal

Wanaparthy Municipality's grievance form (`municipalservices.in/complaint_form.php?id=078`) asks for a **mobile-number OTP before the form appears**. The harness confirms this (run `npm run test:harness -- --url <portal>`).

Because of that, in `live` mode:

- Nagrik does the routing and writes the complaint.
- It then hands the complaint to the citizen with three steps: copy the text, open the portal, and tell Nagrik the reference number.
- Monitoring and escalation then run automatically. Level 1 escalation goes to the commissioner's published email.

Full zero-touch filing works on portals without a human-verification gate. The sandbox portal shows the complete loop: form fill with photo upload, then grievance-number capture, status scraping, escalation and resolution.

Seeded mappings are in `backend/src/db/seed.ts`, with sources:

- Wanaparthy Municipality grievance page and commissioner contact page
- CDMA Telangana (level 2 escalation)
- District Collector / Prajavani (level 3). This contact is marked **unverified**, so agents will not send to it.

---

## Guardrails

| Rule | Where it's enforced |
|---|---|
| New jurisdiction mappings and form selectors need admin approval before auto-submission | `propose_new_jurisdiction` writes `pending`. `get_form_selectors` and `fill_and_submit_form` re-check `review_status` when they run. |
| A CAPTCHA or OTP always leads to a manual hand-off and is never bypassed | `automation/captcha.ts` checks before filling and again after submit, then `flag_submission_failure` runs |
| A partially filled form is never submitted | The harness stops if any required mapped field can't be filled |
| Every tool call is logged | `withToolLogging` in `ai/runtime.ts` wraps all tools of every agent |
| Escalations only go to verified contacts, and levels are never skipped | `submit_escalation` |
| Nothing leaves the machine by email unless explicitly allowed | Sandbox contacts are only simulated. Live contacts need `ALLOW_LIVE_ESCALATION_EMAILS`. |
| The first submission to a new portal gets a review window | `schedule_submission` shows a countdown the citizen can Hold. `autoSubmit=false` requires the citizen's approval every time. |
| A real (non-sandbox) portal is never filed without the citizen tapping Submit, whatever the auto-submit setting | `schedule_submission` waits for approval. `get_form_selectors` and `fill_and_submit_form` refuse unless that run came from the citizen's Submit/Retry (`citizenConfirmed`). |
| A complaint is only recorded as filed if a form was really submitted in that run | `mark_submitted` refuses otherwise, so a confused or hijacked model can't fake a filing |
| Agents can't invent departments | `propose_new_jurisdiction` needs an official `.gov.in` / `.nic.in` source, and proposals stay `pending` (never auto-filed) |
| Citizen text can't steer the agents | Notes and addresses are cleaned of instruction-like text (`services/citizenText.ts`) and marked as untrusted data in every prompt. The tool checks above hold even if a model is fooled. |
| The server only fetches photos it stored itself | `photoUrl` must be the signed-in user's own upload (blocks SSRF) |
| Only one browser session runs at a time | A single-slot queue in `automation/portal.ts` |

---

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/complaints/analyze` | Intake agent (multipart photo + GPS). Returns the new complaint, a clarifying question, or a rejection. |
| POST | `/complaints/:id/determine-jurisdiction` | Run the Jurisdiction agent |
| POST | `/complaints/:id/draft` | Run the Drafting agent (redraft) |
| PATCH | `/complaints/:id/draft` | Save the citizen's edits |
| POST | `/complaints/:id/submit` | Queue the Submission agent |
| POST | `/complaints/:id/hold` | Cancel the pending auto-submission |
| POST | `/complaints/:id/retry` | Retry the pipeline or the submission |
| POST | `/complaints/:id/manual-submitted` | Citizen filed it by hand (optional reference number) |
| POST | `/complaints/:id/user-status` | Citizen says it is fixed or not fixed |
| POST | `/complaints/:id/check-status` | Run the Monitoring agent now for this complaint |
| POST | `/complaints/:id/escalate` | Escalate now to the next verified level. Needs body `{ "confirm": true }`; real offices also need 3 days since the last action. |
| GET | `/complaints/:id/status` | Complaint, department, activity timeline, checks and escalations |
| POST | `/jobs/monitor-complaints` | Cron trigger (`x-cron-secret` header) |
| POST | `/admin/jurisdiction/review` | Approve or reject a mapping and its selectors (`x-admin-key` header) |
| GET | `/health` | Health check |

---

## Tests and evaluation

```bash
cd backend
npm run test:harness     # Playwright harness vs sandbox portal: fill, submit, tracking ID, status, CAPTCHA, broken selector
npm run test:failures    # 39 failure-mode checks: portal down, CAPTCHA, bad photos, prompt injection, invented departments, security
npm run test:mcp         # spawns the MCP server over stdio and drives all 7 tools
npm run test:tracing     # tracing wiring against a fake Langfuse endpoint (no account needed)
npm run test:e2e         # full HTTP pipeline (start the server first; see header of scripts/e2e.ts)
npm run eval:intake      # scores the Intake, Jurisdiction and Drafting agents (see backend/eval/README.md)
```

GitHub Actions runs everything except `test:e2e` on every push and pull request. It fails if the eval scores drop below `backend/eval/thresholds.json`. You can start the Gemini eval by hand from the Actions tab; it needs a `GEMINI_API_KEY` repository secret.

### Failure handling

`npm run test:failures` checks that each failure below is handled safely and that nothing is filed, escalated or routed wrongly. "Handled safely" means one of: the complaint goes back to the citizen, the action is refused, or the request gets a clear 4xx error.

| Failure | What happens |
|---|---|
| Portal unreachable, or returns an error after submit | Handed back (`navigation_failed` / `portal_error`), never recorded as filed |
| Status page down | Check logged as failed; complaint stays filed, not resolved or escalated |
| CAPTCHA on the form, CAPTCHA only after submit, or an OTP gate | Detected and handed back, never bypassed |
| Bad photo: missing, garbage, GIF, over 10 MB, corrupt bytes, someone else's URL | 400 / 413, or handled without a server error |
| Prompt injection in the note, or a "hijacked" model calling tools with malicious arguments | Instructions stripped. Fake filing, redirected form, wrong-department routing and level-skipping escalation are all refused. |
| Invented departments | No official source → refused. Official source → stored as pending only. Pending → never auto-filed. |

### Agent eval

`backend/eval/cases.synthetic.json` holds 40 synthetic, messy complaints: typos, Hinglish, romanised Telugu, vague addresses, out-of-area, not-civic, prompt injection and invented departments. **A human has not reviewed the expected answers yet**, so treat the numbers as provisional. Full results and fixes: [`backend/eval/README.md`](backend/eval/README.md).

EVAL_TABLE_PLACEHOLDER

## Tracing (Langfuse)

Set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` (free at https://cloud.langfuse.com) and every agent run is traced:

- one trace per agent run, grouped by complaint (the Langfuse *session* is the complaint id)
- nested agents (Coordinator → Jurisdiction → Drafting → Submission)
- every tool call as a span with input, output and duration
- every model call, including the ones inside tools (photo analysis, drafting, web search), with tokens and cost

Cost uses the per-token prices in `MODEL_PRICES` (defaults cover the two Gemini models). Without the keys, tracing is off.

![A Nagrik complaint traced in Langfuse](docs/langfuse-trace.png)
<!-- To add: file one complaint with the keys set, open it in Langfuse → Sessions, save a screenshot as docs/langfuse-trace.png -->

## MCP server

`backend/src/mcp/server.ts` lets MCP clients (Claude Desktop, Claude Code…) use Nagrik through 7 tools:

| Tool | Does |
|---|---|
| `report_issue` | Photo + location (+ note) → Intake agent. Returns the complaint, a clarifying question, a nearby duplicate, or a rejection. |
| `find_jurisdiction` | Runs the Jurisdiction agent |
| `draft_complaint` | Runs the Drafting agent |
| `submit_complaint` | Files on the portal. **Only a preview unless `confirm: true`.** |
| `get_complaint_status` | Status, department, tracking ID, escalations, and anything the citizen must do |
| `list_my_complaints` | The citizen's complaints |
| `escalate_complaint` | Escalates to the next verified level. **Only a preview unless `confirm: true`.** |

Safe by default:
- `submit_complaint` and `escalate_complaint` refuse complaints routed to a real government portal or office unless `NAGRIK_MCP_ALLOW_LIVE=true`.
- Complaints reported through MCP are never auto-filed.
- Every backend guardrail still applies.

Claude Desktop config (`claude_desktop_config.json`), with the backend running locally:

```json
{
  "mcpServers": {
    "nagrik": {
      "command": "npx",
      "args": ["tsx", "C:/path/to/Nagrik/backend/src/mcp/server.ts"],
      "env": { "NAGRIK_API_URL": "http://localhost:4000", "NAGRIK_DEVICE_ID": "my-laptop" }
    }
  }
}
```

`NAGRIK_DEVICE_ID` works with a backend that has no Supabase. With Supabase, pass `NAGRIK_TOKEN` (a signed-in user's access token) instead.

## Security

- **Secrets:** with `NODE_ENV=production` (the Dockerfile sets it) the server refuses to start unless these are set to non-default values of 24+ characters: `ADMIN_API_KEY`, `CRON_SECRET`, and `LOCAL_AUTH_SECRET` when Supabase isn't used.
- **Admin key:** compared in constant time and accepted only in the `x-admin-key` header, never in the URL.
- **Rate limits:**
  - 900 requests per 15 min per IP
  - 20 *failed* admin/cron attempts per 15 min per IP
  - 60 agent-starting actions per hour per user (submit, retry, redraft, re-route, check, escalate, Me too)
  - the existing per-user limits on reporting, voice and geocoding
- **Real submissions:** always need the citizen's confirmation (see Guardrails).

## Pilot

[`docs/PILOT.md`](docs/PILOT.md) is the checklist for running Nagrik with 5–10 real users and turning what breaks into eval cases.

The admin console's **Overview** tab reports:

- automated success rate
- CAPTCHA block rate
- reasons complaints were handed back to the citizen

These are the numbers that show how much of real-world filing can actually be automated.

---

## Deploying

- **Backend:** `render.yaml` deploys `backend/Dockerfile`, which is based on Playwright's image and includes Chromium. Use at least a 2 GB instance.
  - Set `PUBLIC_BASE_URL` to the service URL.
  - Change `ADMIN_API_KEY`, `CRON_SECRET` and `LOCAL_AUTH_SECRET`.
- **App:** `cd mobile && npx eas-cli build --profile preview`.
  - Set `EXPO_PUBLIC_API_URL` to the Render URL.
  - Push notifications need a development or production build. Expo Go on Android doesn't support remote push.
  - In-app updates work everywhere.

## Project layout

```
backend/src
  agents/        intake · jurisdiction · drafting · submission · monitoring · coordinator
  ai/            runtime (tool loop + logging + fallback) · offlineModel (keyless planner) · tracing (Langfuse)
  mcp/           MCP server (7 tools)
  automation/    Playwright harness · CAPTCHA/OTP detection
  db/            Supabase + local repos · Wanaparthy seed
  sandboxPortal/ mock municipal grievance portal
  admin/         admin console
mobile/src
  app/           expo-router screens (welcome, sign-in, profile-setup, tabs, report, complaint, edit-draft)
  components/    UI kit, complaint widgets, sheet, toast
  lib/           api, auth, i18n (en/te/hi), notifications
supabase/migrations/  schema + RLS
```
