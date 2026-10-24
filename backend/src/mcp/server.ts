/**
 * Nagrik MCP server — lets an AI assistant (Claude Desktop, Claude Code, …) report and follow civic
 * complaints through a running Nagrik backend.
 *
 *   NAGRIK_API_URL=http://localhost:4000 NAGRIK_DEVICE_ID=my-laptop npm run mcp
 *
 * It is a thin client over the HTTP API, so every backend guardrail still applies. On top:
 *  - Sandbox by default: submit_complaint and escalate_complaint refuse complaints routed to a real
 *    government portal or office unless NAGRIK_MCP_ALLOW_LIVE=true.
 *  - Confirmation by default: those two tools only act when called with confirm: true. Without it
 *    they return a preview of exactly what would be sent, and where.
 *  - Complaints it reports are never auto-filed (autoSubmit: false), whatever the profile says.
 *
 * Auth: NAGRIK_TOKEN (a Supabase access token from the app) or, against a backend without
 * Supabase, NAGRIK_DEVICE_ID (exchanged for a local device token).
 *
 * stdout carries the MCP protocol — log to stderr only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = (process.env.NAGRIK_API_URL || 'http://localhost:4000').replace(/\/$/, '');
const ALLOW_LIVE = ['1', 'true', 'yes'].includes((process.env.NAGRIK_MCP_ALLOW_LIVE || '').toLowerCase());
const ISSUE_TYPES = ['pothole', 'streetlight', 'garbage', 'water_leakage', 'drainage', 'other'] as const;

let token = process.env.NAGRIK_TOKEN || '';

async function authToken() {
  if (token) return token;
  const deviceId = process.env.NAGRIK_DEVICE_ID;
  if (!deviceId) throw new Error('Set NAGRIK_TOKEN (Supabase access token) or NAGRIK_DEVICE_ID (backend without Supabase).');
  const r = await fetch(`${API}/auth/local`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }) });
  const j = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!r.ok || !j.token) throw new Error(`Sign-in failed: ${j.error ?? r.status}`);
  token = j.token;
  return token;
}

async function api<T = any>(method: string, route: string, body?: unknown): Promise<T> {
  const r = await fetch(API + route, {
    method,
    headers: { authorization: `Bearer ${await authToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180_000),
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `Nagrik API ${r.status}`);
  return j;
}

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });
async function guarded(fn: () => Promise<ReturnType<typeof ok>>) {
  try {
    return await fn();
  } catch (e) {
    return fail((e as Error).message);
  }
}

/** The parts of a complaint an assistant needs, without the activity log noise. */
function summary(d: any) {
  const c = d.complaint;
  return {
    complaint_id: c.id,
    status: c.status,
    issue_type: c.issue_type,
    address: c.address,
    department: d.jurisdiction?.department_name ?? null,
    portal: d.jurisdiction ? { url: d.jurisdiction.portal_url, sandbox: d.jurisdiction.is_sandbox, verified: d.jurisdiction.verified, automated: d.jurisdiction.automated } : null,
    tracking_id: c.tracking_id,
    portal_status: c.portal_status,
    escalation_level: c.escalation_level,
    needs_citizen: d.failure ? { category: d.failure.category, message: d.failure.message } : null,
    draft: c.draft_text ? { subject: c.draft_subject, text: c.draft_text } : null,
    escalations: (d.escalations ?? []).map((e: any) => ({ level: e.escalation_level, to: e.recipient, delivery: e.delivery_status, at: e.created_at })),
  };
}

/** Sandbox-by-default gate shared by the two tools that reach government offices. */
function liveBlock(d: any, action: string) {
  if (!d.jurisdiction) return `No department is assigned yet — run find_jurisdiction first.`;
  if (!d.jurisdiction.is_sandbox && !ALLOW_LIVE) {
    return `Refused: this complaint is routed to a REAL government ${action === 'escalate' ? 'office' : 'portal'} (${d.jurisdiction.department_name}). This MCP server runs in sandbox mode. The citizen can ${action} it from the Nagrik app, or the operator can set NAGRIK_MCP_ALLOW_LIVE=true.`;
  }
  return null;
}

const server = new McpServer({ name: 'nagrik', version: '1.0.0' });

server.registerTool(
  'report_issue',
  {
    title: 'Report a civic issue',
    description:
      'Report a civic problem (pothole, broken street light, garbage, water leak, blocked drain…) with a photo and a location. The Intake agent classifies it and may answer with a clarifying question, a nearby duplicate, or a rejection. When created, routing and drafting continue automatically; nothing is filed without submit_complaint.',
    inputSchema: {
      photo_path: z.string().optional().describe('Path to a JPEG/PNG/WebP photo on this machine.'),
      photo_base64: z.string().optional().describe('Photo bytes, base64 (alternative to photo_path).'),
      photo_mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      address: z.string().max(300).optional().describe('Required when no coordinates are given.'),
      note: z.string().max(500).optional().describe("The citizen's own words about the problem."),
      clarification_answer: z.enum(ISSUE_TYPES).optional().describe('Answer to a previous clarifying question (send intake_id and photo_url from that answer too).'),
      intake_id: z.string().uuid().optional(),
      photo_url: z.string().url().optional().describe('photo_url returned by a previous report_issue call.'),
      file_separately: z.boolean().optional().describe('File a new complaint even though a nearby duplicate exists.'),
    },
  },
  async (a) =>
    guarded(async () => {
      let photoBase64 = a.photo_base64;
      let mime = a.photo_mime_type;
      if (a.photo_path) {
        photoBase64 = fs.readFileSync(a.photo_path).toString('base64');
        const ext = path.extname(a.photo_path).toLowerCase();
        mime ??= ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      }
      const r = await api('POST', '/complaints/analyze', {
        photoBase64,
        photoMimeType: mime,
        photoUrl: a.photo_url,
        latitude: a.latitude,
        longitude: a.longitude,
        manualAddress: a.address,
        note: a.note,
        clarificationAnswer: a.clarification_answer,
        intakeId: a.intake_id,
        forceNew: a.file_separately,
        autoSubmit: false,
      });
      if (r.result === 'created') return ok({ result: 'created', complaint_id: r.complaint.id, issue_type: r.complaint.issue_type, address: r.complaint.address, next: 'Routing and drafting run in the background — check get_complaint_status in ~30 s.' });
      return ok(r);
    }),
);

server.registerTool(
  'find_jurisdiction',
  {
    title: 'Find the responsible department',
    description: 'Run the Jurisdiction agent: decides which government department and portal handle this complaint (verified lookup table first; unverified proposals are never auto-filed).',
    inputSchema: { complaint_id: z.string() },
    annotations: { idempotentHint: true },
  },
  async ({ complaint_id }) =>
    guarded(async () => {
      const d = await api('POST', `/complaints/${complaint_id}/determine-jurisdiction`);
      const s = summary(d);
      return ok({ complaint_id, department: s.department, portal: s.portal, needs_citizen: s.needs_citizen });
    }),
);

server.registerTool(
  'draft_complaint',
  {
    title: 'Draft the complaint letter',
    description: 'Run the Drafting agent: (re)writes the formal complaint for the assigned department. Holds any pending auto-submission.',
    inputSchema: { complaint_id: z.string() },
  },
  async ({ complaint_id }) =>
    guarded(async () => {
      const s = summary(await api('POST', `/complaints/${complaint_id}/draft`));
      return ok({ complaint_id, department: s.department, draft: s.draft });
    }),
);

server.registerTool(
  'submit_complaint',
  {
    title: 'File the complaint on the portal',
    description:
      'File the drafted complaint on the department portal. Without confirm: true this only returns a preview (department, portal, exact text). Sandbox portals only unless the server allows live filing. CAPTCHA/OTP portals are handed back to the citizen, never bypassed.',
    inputSchema: {
      complaint_id: z.string(),
      confirm: z.boolean().default(false).describe('Must be true to actually file. Show the preview to the user and get their OK first.'),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ complaint_id, confirm }) =>
    guarded(async () => {
      const d = await api('GET', `/complaints/${complaint_id}/status`);
      const s = summary(d);
      const blocked = liveBlock(d, 'submit');
      if (blocked) return fail(blocked);
      if (!s.draft) return fail('No draft yet — run draft_complaint first.');
      if (!['drafted', 'submission_failed'].includes(s.status)) return fail(`Can't submit while the complaint is "${s.status}".`);
      if (!confirm) {
        return ok({ preview: true, would_file_with: s.department, portal: s.portal, subject: s.draft.subject, text: s.draft.text, next: 'Show this to the user. If they agree, call submit_complaint again with confirm: true.' });
      }
      await api('POST', `/complaints/${complaint_id}/submit`);
      return ok({ queued: true, complaint_id, next: 'Filing runs in a headless browser (≈30 s). Check get_complaint_status for the tracking ID or a hand-off reason.' });
    }),
);

server.registerTool(
  'get_complaint_status',
  {
    title: 'Get complaint status',
    description: 'Current status, department, tracking ID, portal status, escalations, and anything the citizen needs to do.',
    inputSchema: { complaint_id: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ complaint_id }) => guarded(async () => ok(summary(await api('GET', `/complaints/${complaint_id}/status`)))),
);

server.registerTool(
  'list_my_complaints',
  {
    title: 'List my complaints',
    description: "The signed-in citizen's complaints (and ones they support with \"Me too\"), newest first.",
    inputSchema: { status: z.enum(['analyzing', 'drafted', 'submitting', 'submitted', 'submission_failed', 'escalated', 'resolved']).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ status }) =>
    guarded(async () => {
      const { complaints } = await api<{ complaints: any[] }>('GET', '/complaints');
      return ok(
        complaints
          .filter((c) => !status || c.status === status)
          .map((c) => ({ complaint_id: c.id, status: c.status, issue_type: c.issue_type, address: c.address, department: c.jurisdiction_department, tracking_id: c.tracking_id, role: c.viewer_role, created_at: c.created_at })),
      );
    }),
);

server.registerTool(
  'escalate_complaint',
  {
    title: 'Escalate an unresolved complaint',
    description:
      'Escalate a filed, unresolved complaint to the next level of its verified escalation chain (never skips levels, never writes to unverified contacts). Without confirm: true this only returns a preview of who it would go to. Sandbox only unless the server allows live escalation.',
    inputSchema: {
      complaint_id: z.string(),
      confirm: z.boolean().default(false).describe('Must be true to actually escalate. Get the user\'s OK first.'),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ complaint_id, confirm }) =>
    guarded(async () => {
      const d = await api('GET', `/complaints/${complaint_id}/status`);
      const s = summary(d);
      const blocked = liveBlock(d, 'escalate');
      if (blocked) return fail(blocked);
      if (!['submitted', 'escalated'].includes(s.status)) return fail(`Only filed, unresolved complaints can be escalated (this one is "${s.status}").`);
      const next = (d.jurisdiction.escalation_chain ?? []).find((e: any) => e.level === s.escalation_level + 1);
      if (!next) return fail('There is no further escalation level for this department.');
      if (!confirm) {
        return ok({ preview: true, current_level: s.escalation_level, would_escalate_to: next, next: 'Show this to the user. If they agree, call escalate_complaint again with confirm: true.' });
      }
      const after = summary(await api('POST', `/complaints/${complaint_id}/escalate`, { confirm: true }));
      return ok({ complaint_id, status: after.status, escalation_level: after.escalation_level, latest: after.escalations[0] ?? null });
    }),
);

await server.connect(new StdioServerTransport());
console.error(`[nagrik-mcp] connected to ${API} (${ALLOW_LIVE ? 'LIVE filing allowed' : 'sandbox only'})`);
