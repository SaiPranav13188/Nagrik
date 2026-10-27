/**
 * End-to-end test of the whole agentic pipeline over HTTP against a running backend in sandbox mode.
 *
 *   PORT=4100 LOCAL_DATA_DIR=.data-e2e SUBMISSION_GRACE_SECONDS=2 ESCALATION_THRESHOLD_DAYS=0 ENABLE_CRON=false npm start
 *   BASE=http://localhost:4100 npm run test:e2e
 */
const BASE = process.env.BASE || 'http://localhost:4100';
const ADMIN = process.env.ADMIN_API_KEY || 'admin-dev-key';
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '✅' : '❌'} ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : '');
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(path: string, opts: RequestInit & { token?: string } = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function form(fields: Record<string, string>, photo = true) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  if (photo) f.append('photo', new Blob([PNG], { type: 'image/png' }), 'issue.png');
  return f;
}

async function waitFor(token: string, id: string, pred: (d: any) => boolean, timeoutMs = 90000) {
  const start = Date.now();
  let d: any;
  while (Date.now() - start < timeoutMs) {
    d = (await call(`/complaints/${id}/status`, { token })).json;
    if (pred(d)) return d;
    await sleep(1000);
  }
  return d;
}

async function main() {
  const health = await call('/health');
  check('health', health.status === 200 && health.json.portal_mode === 'sandbox', health.json);

  const auth = await call('/auth/local', { method: 'POST', body: JSON.stringify({ deviceId: `e2e-${Date.now()}` }) });
  const token = auth.json.token as string;
  check('local sign-in', !!token);

  const bad = await call('/me', { method: 'PUT', token, body: JSON.stringify({ phone: '12345' }) });
  check('invalid phone rejected', bad.status === 400, bad.json);
  const prof = await call('/me', { method: 'PUT', token, body: JSON.stringify({ full_name: 'Ravi Kumar', phone: '+91 98765 43210', email: 'ravi@example.org' }) });
  check('profile saved + phone normalized', prof.json.profile?.phone === '9876543210', prof.json.profile);

  // Wanaparthy bus stand area
  const loc = { latitude: '16.3623', longitude: '78.0622' };

  // ── Path 1: ambiguous photo → clarification question → answer → complaint
  const a1 = await call('/complaints/analyze', { method: 'POST', token, body: form(loc) });
  const offline = health.json.ai === 'offline-planner';
  if (offline) {
    check('ambiguous photo → clarification asked', a1.json.result === 'clarification' && a1.json.options?.length >= 2, a1.json);
    const a1b = await call('/complaints/analyze', {
      method: 'POST',
      token,
      body: form({ ...loc, intakeId: a1.json.intakeId, photoUrl: a1.json.photoUrl, clarificationAnswer: 'garbage' }, false),
    });
    check('clarification answer → complaint created', a1b.status === 201 && a1b.json.complaint?.issue_type === 'garbage', a1b.json.complaint?.issue_type);
  } else {
    console.log('ℹ️  Gemini mode: clarification depends on photo content; skipping deterministic check', a1.json.result);
  }

  // ── Path 2: pothole with a note → full autonomous loop
  const a2 = await call('/complaints/analyze', { method: 'POST', token, body: form({ ...loc, note: 'Big pothole near the bus stand, bikes are falling' }) });
  check('intake created complaint', a2.status === 201 && a2.json.result === 'created', a2.json);
  const id = a2.json.complaint.id as string;
  check('address geocoded', !!a2.json.complaint.address, a2.json.complaint.address);

  const drafted = await waitFor(token, id, (d) => ['drafted', 'submitting', 'submitted', 'submission_failed'].includes(d.complaint.status));
  check('routed to Wanaparthy Municipality', /Wanaparthy Municipality/.test(drafted.jurisdiction?.department_name ?? ''), drafted.jurisdiction?.department_name);
  check('draft written', (drafted.complaint.draft_text ?? '').length > 100, drafted.complaint.draft_subject);

  const submitted = await waitFor(token, id, (d) => ['submitted', 'submission_failed'].includes(d.complaint.status));
  check('auto-submitted via Playwright', submitted.complaint.status === 'submitted', { status: submitted.complaint.status, failure: submitted.failure });
  check('tracking ID captured automatically', /^WNP\/\d{4}\/\d{6}$/.test(submitted.complaint.tracking_id ?? ''), submitted.complaint.tracking_id);
  check('activity timeline populated', submitted.activity.length >= 6, submitted.activity.map((x: any) => x.title));

  const logs = await call(`/admin/logs?complaintId=${id}`, { headers: { 'x-admin-key': ADMIN } });
  const tools = new Set(logs.json.logs.map((l: any) => l.tool_name));
  check('every agent tool call logged', ['analyze_photo', 'reverse_geocode', 'save_complaint', 'lookup_jurisdiction', 'assign_jurisdiction', 'draft_complaint_text', 'save_draft', 'get_form_selectors', 'fill_and_submit_form', 'extract_confirmation_details', 'mark_submitted'].every((t) => tools.has(t)), [...tools]);

  // ── Monitoring: unchanged past threshold (0 days in this test) → escalation drafted, not sent
  await call('/admin/monitor/run', { method: 'POST', headers: { 'x-admin-key': ADMIN }, body: JSON.stringify({ force: true }) });
  const drafts = (await call(`/complaints/${id}/status`, { token })).json;
  const draft = drafts.escalations.find((e: any) => e.delivery_status === 'awaiting_approval');
  check('escalation drafted for the citizen to approve; nothing sent yet', !!draft && drafts.complaint.escalation_level === 0, drafts.escalations[0]);

  // ── The citizen approves the exact letter → sent to level 1
  const sentRes = await call(`/complaints/${id}/escalations/${draft?.id}/send`, { token, method: 'POST', body: JSON.stringify({ confirm: true, subject: draft?.subject, body: draft?.body }) });
  const esc = sentRes.json;
  check('escalated to level 1 (sandbox commissioner) after approval', esc.complaint?.status === 'escalated' && esc.complaint?.escalation_level === 1, { status: esc.complaint?.status, esc: esc.escalations?.[0] });

  // ── Officer resolves on the portal → monitoring detects → resolved
  await call('/admin/sandbox/grievances/status', { method: 'POST', headers: { 'x-admin-key': ADMIN }, body: JSON.stringify({ no: submitted.complaint.tracking_id, status: 'Resolved', remarks: 'Pothole patched.' }) });
  await call('/admin/monitor/run', { method: 'POST', headers: { 'x-admin-key': ADMIN }, body: JSON.stringify({ force: true }) });
  const res = (await call(`/complaints/${id}/status`, { token })).json;
  check('resolution scraped → resolved', res.complaint.status === 'resolved', res.complaint.status);

  const notes = (await call('/me/notifications', { token })).json;
  check('citizen notified along the way', notes.notifications.length >= 3, notes.notifications.map((n: any) => n.title));

  // ── CAPTCHA path: portal presents CAPTCHA → no bypass → manual fallback
  await call('/admin/sandbox/captcha', { method: 'POST', headers: { 'x-admin-key': ADMIN }, body: JSON.stringify({ enabled: true }) });
  const a3 = await call('/complaints/analyze', { method: 'POST', token, body: form({ ...loc, note: 'Street light not working for a week, very dark at night' }) });
  const id3 = a3.json.complaint.id;
  const c3 = await waitFor(token, id3, (d) => ['submitted', 'submission_failed'].includes(d.complaint.status));
  check('CAPTCHA → manual fallback (not bypassed)', c3.complaint.status === 'submission_failed' && c3.failure?.category === 'captcha', c3.failure);
  await call('/admin/sandbox/captcha', { method: 'POST', headers: { 'x-admin-key': ADMIN }, body: JSON.stringify({ enabled: false }) });

  const manual = await call(`/complaints/${id3}/manual-submitted`, { method: 'POST', token, body: JSON.stringify({ trackingId: 'WNP/2026/999999' }) });
  check('citizen can record manual filing', manual.json.complaint?.status === 'submitted', manual.json.complaint?.status);

  // ── Ownership: another user can't see this complaint
  const other = (await call('/auth/local', { method: 'POST', body: JSON.stringify({ deviceId: `e2e-other-${Date.now()}` }) })).json.token;
  const peek = await call(`/complaints/${id}/status`, { token: other });
  check("other users can't read it", peek.status === 404);

  // ── "Me too": a neighbour reports the same street light → offered to join instead of duplicating
  const nb = (await call('/auth/local', { method: 'POST', body: JSON.stringify({ deviceId: `e2e-neighbour-${Date.now()}` }) })).json.token;
  await call('/me', { method: 'PUT', token: nb, body: JSON.stringify({ full_name: 'Lakshmi Devi', phone: '9123456780' }) });
  const d1 = await call('/complaints/analyze', { method: 'POST', token: nb, body: form({ ...loc, note: 'street light not working here' }) });
  check('duplicate detected nearby', d1.json.result === 'duplicate' && d1.json.existing?.id === id3, { result: d1.json.result, reason: d1.json.reason });
  check('duplicate view hides reporter details', d1.json.existing && !('user_id' in d1.json.existing) && !('draft_text' in d1.json.existing));
  const sup = await call(`/complaints/${id3}/support`, { method: 'POST', token: nb });
  check('neighbour can say "Me too"', sup.json.supported && sup.json.supporters_count === 1, sup.json);
  const again = await call(`/complaints/${id3}/support`, { method: 'POST', token: nb });
  check('supporting twice is idempotent', again.json.supporters_count === 1);
  const own = await call(`/complaints/${id3}/support`, { method: 'POST', token });
  check("reporter can't support own complaint", own.status === 409);
  const sv = await call(`/complaints/${id3}/status`, { token: nb });
  check('supporter gets read-only redacted view', sv.status === 200 && sv.json.viewer_role === 'supporter' && sv.json.complaint.draft_text === null, sv.json.viewer_role);
  const nbList = await call('/complaints', { token: nb });
  check("supported complaint appears in neighbour's list", nbList.json.complaints.some((c: any) => c.id === id3 && c.viewer_role === 'supporter'));
  const ownerNotes = (await call('/me/notifications', { token })).json.notifications;
  check('reporter notified when neighbour joins', ownerNotes.some((n: any) => /neighbour joined/i.test(n.title)));
  const forced = await call('/complaints/analyze', { method: 'POST', token: nb, body: form({ ...loc, note: 'street light not working here', intakeId: d1.json.intakeId, photoUrl: d1.json.photoUrl, forceNew: 'true' }, false) });
  check('"different problem" files separately', forced.status === 201 && forced.json.result === 'created', forced.json.result);
  const near = await call(`/complaints/nearby?lat=${loc.latitude}&lng=${loc.longitude}&radius=2000`, { token: nb });
  check('nearby map lists complaints with distance', near.json.items?.length >= 2 && near.json.items.every((i: any) => typeof i.distance_m === 'number' && !('user_id' in i)), near.json.items?.length);
  await call(`/complaints/${id3}/support`, { method: 'DELETE', token: nb });
  const after = await call(`/complaints/${id3}/status`, { token: nb });
  check('removing support revokes access', after.status === 404);

  const stats = await call('/admin/stats', { headers: { 'x-admin-key': ADMIN } });
  check('stats report captcha rate', stats.json.submission_attempts >= 2, stats.json);
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
    process.exit(failures ? 1 : 0);
  });
