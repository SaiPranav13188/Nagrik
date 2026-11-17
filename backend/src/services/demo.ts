import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { issueLocalToken } from '../auth.js';
import { repo } from '../db/index.js';
import { SupabaseRepo } from '../db/supabaseRepo.js';
import type { Complaint, IssueType, Jurisdiction } from '../db/types.js';
import { sandboxState } from '../sandboxPortal/router.js';
import { deleteAccount } from './account.js';

/**
 * Throwaway demo accounts, so recruiters and visitors can try Nagrik in a browser without signing up.
 *
 * Each visitor gets their own account with sample complaints at every stage (draft waiting for
 * approval, filed, escalation waiting for approval, resolved). Accounts are deleted 24 hours after
 * they are made. The email uses the reserved `.invalid` domain, so no mail can ever reach one.
 *
 * Demo accounts can never reach a real office: they are always routed to the sandbox portal (see
 * jurisdiction.ts), escalation emails are only simulated (escalations.ts), they can't "Me too" a real
 * citizen's complaint, and their complaints are hidden from real residents' nearby map.
 */
export const DEMO_DOMAIN = 'demo.nagrik.invalid';
export const DEMO_HOURS = 24;
const MAX_LIVE_DEMOS = 200; // keeps the free database and Gemini quota safe if the link spreads

export const isDemoEmail = (email: string | null | undefined) => !!email && email.toLowerCase().endsWith(`@${DEMO_DOMAIN}`);

// A user never stops or starts being a demo user, so the answer can be cached for good.
const demoCache = new Map<string, boolean>();
export async function isDemoUser(userId: string): Promise<boolean> {
  const hit = demoCache.get(userId);
  if (hit !== undefined) return hit;
  const demo = isDemoEmail((await repo.getProfile(userId))?.email);
  if (demoCache.size > 20_000) demoCache.clear();
  demoCache.set(userId, demo);
  return demo;
}

export class DemoUnavailable extends Error {}

async function listDemoProfiles(): Promise<{ id: string; created_at: string }[]> {
  if (!(repo instanceof SupabaseRepo)) return [];
  const { data, error } = await repo.client.from('profiles').select('id, created_at').like('email', `%@${DEMO_DOMAIN}`);
  if (error) throw new Error(`Demo listing failed: ${error.message}`);
  return data ?? [];
}

/** Deletes demo accounts older than DEMO_HOURS. Runs a small batch each time a new demo starts. */
export async function cleanupExpiredDemos(limit = 20) {
  const cutoff = Date.now() - DEMO_HOURS * 3600_000;
  const old = (await listDemoProfiles()).filter((p) => new Date(p.created_at).getTime() < cutoff).slice(0, limit);
  for (const p of old) {
    const nos = (await repo.listComplaintsByUser(p.id)).map((c) => c.tracking_id).filter((n): n is string => !!n);
    await deleteAccount(p.id).catch((e) => console.warn('[demo] cleanup failed', (e as Error).message));
    sandboxState.remove(nos);
    demoCache.delete(p.id);
  }
  return old.length;
}

export type DemoSession = { mode: 'supabase'; email: string; password: string } | { mode: 'local'; token: string };

export async function createDemoAccount(): Promise<DemoSession> {
  await cleanupExpiredDemos().catch((e) => console.warn('[demo] cleanup skipped', (e as Error).message));
  if ((await listDemoProfiles()).length >= MAX_LIVE_DEMOS) throw new DemoUnavailable('The demo is very busy right now. Please try again in a little while.');

  const email = `demo-${randomBytes(6).toString('hex')}@${DEMO_DOMAIN}`;
  let userId: string;
  let session: DemoSession;
  if (repo instanceof SupabaseRepo) {
    const password = randomBytes(24).toString('base64url'); // only this browser ever learns it
    const { data, error } = await repo.client.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { demo: true } });
    if (error || !data.user) throw new Error(`Demo account creation failed: ${error?.message}`);
    userId = data.user.id;
    session = { mode: 'supabase', email, password };
  } else {
    const local = issueLocalToken(email);
    userId = local.userId;
    session = { mode: 'local', token: local.token };
  }

  try {
    await repo.upsertProfile({ id: userId, email, full_name: 'Demo Citizen', phone: '9876543210', preferred_language: 'en', auto_submit_default: false });
    demoCache.set(userId, true);
    await seedSampleComplaints(userId);
  } catch (e) {
    await deleteAccount(userId).catch(() => {});
    throw e;
  }
  return session;
}

// ─────────────── sample data ───────────────

const photo = (name: string) => `${config.demoPhotoBaseUrl}/${name}.jpg`;
const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();

async function sandboxOffice(issue: IssueType): Promise<Jurisdiction> {
  const [j] = await repo.findJurisdictions({ city: 'Wanaparthy', state: 'Telangana', issueType: issue, sandbox: true, reviewStatuses: ['approved'] });
  if (!j) throw new Error(`No sandbox office for ${issue}`);
  return j;
}

const LETTER_END = `\n\nI request you to kindly arrange for this to be repaired at the earliest. A photograph of the problem is attached.\n\nYours faithfully,\nDemo Citizen\nMobile: 9876543210`;

interface Sample {
  issue: IssueType;
  photo: string;
  severity: Complaint['severity'];
  description: string;
  address: string;
  lat: number;
  lng: number;
  subject: string;
  body: string;
  createdHoursAgo: number;
}

const SAMPLES: Record<'pothole' | 'streetlight' | 'garbage' | 'drainage', Sample> = {
  pothole: {
    issue: 'pothole',
    photo: 'pothole',
    severity: 'high',
    description: 'A large, water-filled pothole across most of the road width. Two-wheelers are swerving into oncoming traffic to avoid it.',
    address: 'Gandhi Chowk Road, near the bus stand, Wanaparthy, Telangana 509103',
    lat: 16.36214,
    lng: 78.06192,
    subject: 'Large pothole on Gandhi Chowk Road near the bus stand',
    body: `To\nThe Assistant Engineer (Roads),\nEngineering Section, Wanaparthy Municipality\n\nSubject: Large pothole on Gandhi Chowk Road near the bus stand\n\nRespected Sir/Madam,\n\nI wish to bring to your notice a large pothole on Gandhi Chowk Road, near the Wanaparthy bus stand (GPS 16.36214, 78.06192). It covers most of the road width and fills with water, so it is hard to see. Two-wheeler riders are swerving into oncoming traffic to avoid it, and there is a real risk of an accident.`,
    createdHoursAgo: 24 * 6,
  },
  streetlight: {
    issue: 'streetlight',
    photo: 'streetlight',
    severity: 'medium',
    description: 'A street light pole is bent over and the lamp has not worked for two weeks. The lane is completely dark at night.',
    address: 'Pebbair Road, near the Government Junior College, Wanaparthy, Telangana 509103',
    lat: 16.36788,
    lng: 78.05741,
    subject: 'Damaged street light pole on Pebbair Road, lane dark at night',
    body: `To\nThe Assistant Engineer (Street Lighting),\nEngineering Section, Wanaparthy Municipality\n\nSubject: Damaged street light pole on Pebbair Road, lane dark at night\n\nRespected Sir/Madam,\n\nThe street light pole on Pebbair Road near the Government Junior College (GPS 16.36788, 78.05741) is bent over and its lamp has not worked for about two weeks. The lane is completely dark at night and is used by students and women returning home late.`,
    createdHoursAgo: 24 * 14,
  },
  garbage: {
    issue: 'garbage',
    photo: 'garbage',
    severity: 'medium',
    description: 'Garbage has piled up beside the community bin outside the temple and is spreading onto the road. Animals are scattering it.',
    address: 'Temple Street, Ward 12, Wanaparthy, Telangana 509103',
    lat: 16.35912,
    lng: 78.06655,
    subject: 'Uncollected garbage beside the community bin on Temple Street',
    body: `To\nThe Sanitary Inspector,\nPublic Health & Sanitation Section, Wanaparthy Municipality\n\nSubject: Uncollected garbage beside the community bin on Temple Street\n\nRespected Sir/Madam,\n\nGarbage has not been collected from the community bin on Temple Street, Ward 12 (GPS 16.35912, 78.06655) for several days. It has piled up beside the bin and is spreading onto the road, and stray animals are scattering it.`,
    createdHoursAgo: 24 * 20,
  },
  drainage: {
    issue: 'drainage',
    photo: 'drainage',
    severity: 'high',
    description: 'The open side drain is blocked and overflowing onto the footpath. Stagnant sewage water and a strong smell near houses.',
    address: 'Srinivasa Colony, 2nd Lane, Wanaparthy, Telangana 509103',
    lat: 16.36453,
    lng: 78.05322,
    subject: 'Blocked, overflowing side drain in Srinivasa Colony 2nd Lane',
    body: `To\nThe Assistant Engineer (Drainage),\nEngineering Section, Wanaparthy Municipality\n\nSubject: Blocked, overflowing side drain in Srinivasa Colony 2nd Lane\n\nRespected Sir/Madam,\n\nThe open side drain in Srinivasa Colony, 2nd Lane (GPS 16.36453, 78.05322) is blocked and overflowing onto the footpath. Sewage water is stagnating next to houses, there is a strong smell, and mosquitoes are breeding. This is a health risk for the families living here.`,
    createdHoursAgo: 2,
  },
};

async function log(agent: string, complaintId: string, tool: string, args: unknown, result: unknown, at: string) {
  // created_at is set explicitly so the timeline reads in the right order.
  await repo.addToolLog({ agent_name: agent, complaint_id: complaintId, tool_name: tool, arguments: args, result, duration_ms: 400, error: null, created_at: at });
}

async function create(userId: string, s: Sample, j: Jurisdiction, patch: Partial<Complaint>) {
  const c = await repo.createComplaint({
    user_id: userId,
    photo_url: photo(s.photo),
    issue_type: s.issue,
    description: s.description,
    severity: s.severity,
    latitude: s.lat,
    longitude: s.lng,
    address: s.address,
    city: 'Wanaparthy',
    state: 'Telangana',
    pincode: '509103',
    jurisdiction_department: j.department_name,
    jurisdiction_portal_id: j.id,
    draft_subject: s.subject,
    draft_text: s.body + LETTER_END,
    auto_submit: false,
    created_at: ago(s.createdHoursAgo),
    ...patch,
  } as never);
  const t0 = s.createdHoursAgo;
  await log('intake_agent', c.id, 'analyze_photo', {}, { issue_type: s.issue, confidence: 0.94 }, ago(t0));
  await log('intake_agent', c.id, 'reverse_geocode', { latitude: s.lat, longitude: s.lng }, { address: s.address }, ago(t0 - 0.001));
  await log('intake_agent', c.id, 'find_nearby_duplicates', {}, { candidates: [] }, ago(t0 - 0.002));
  await log('intake_agent', c.id, 'save_complaint', {}, { ok: true }, ago(t0 - 0.003));
  await log('jurisdiction_agent', c.id, 'lookup_jurisdiction', { city: 'Wanaparthy', issue_type: s.issue }, { approved: [{ department_name: j.department_name }] }, ago(t0 - 0.004));
  await log('jurisdiction_agent', c.id, 'assign_jurisdiction', {}, { assigned: true, trusted: true, department: j.department_name }, ago(t0 - 0.005));
  await log('drafting_agent', c.id, 'draft_complaint_text', {}, { subject: s.subject }, ago(t0 - 0.006));
  return c;
}

/** Puts a grievance on the sandbox portal, so "Check status" on the sample complaint really works. */
function fileOnSandbox(s: Sample, filedAt: string, status: string, remarks: string) {
  return sandboxState.register({
    name: 'Demo Citizen',
    mobile: '9876543210',
    category: s.issue.toUpperCase(),
    subject: s.subject,
    description: s.description,
    location: s.address,
    lat: String(s.lat),
    lng: String(s.lng),
    status,
    remarks,
    createdAt: filedAt,
  });
}

async function markFiled(c: Complaint, filedHoursAgo: number, no: string) {
  await log('submission_agent', c.id, 'fill_and_submit_form', {}, { outcome: 'submitted', filledFields: ['name', 'mobile', 'category', 'subject', 'description', 'location', 'photo'] }, ago(filedHoursAgo));
  await log('submission_agent', c.id, 'extract_confirmation_details', {}, { found: true, trackingId: no }, ago(filedHoursAgo - 0.001));
  await log('submission_agent', c.id, 'mark_submitted', { tracking_id: no }, { ok: true }, ago(filedHoursAgo - 0.002));
}

async function seedSampleComplaints(userId: string) {
  // 1. Just analysed: the letter is drafted and waits for the citizen to approve filing.
  {
    const s = SAMPLES.drainage;
    const c = await create(userId, s, await sandboxOffice(s.issue), { status: 'drafted' });
    await log('submission_agent', c.id, 'schedule_submission', {}, { awaiting_user_approval: true }, ago(s.createdHoursAgo - 0.01));
  }

  // 2. Filed 6 days ago, the office has acknowledged it.
  {
    const s = SAMPLES.pothole;
    const filedAt = ago(s.createdHoursAgo - 0.05);
    const no = fileOnSandbox(s, filedAt, 'Forwarded', 'Forwarded to the Engineering Section (Roads) for inspection.');
    const c = await create(userId, s, await sandboxOffice(s.issue), {
      status: 'submitted',
      tracking_id: no,
      portal_status: 'Forwarded',
      submitted_at: filedAt,
      last_checked_at: ago(20),
    });
    await markFiled(c, s.createdHoursAgo - 0.05, no);
    await repo.addStatusCheck({ complaint_id: c.id, status_found: 'Forwarded', source: 'scraped', raw_snapshot: null, checked_at: ago(20) });
    await log('monitoring_agent', c.id, 'check_status_via_scraper', {}, { ok: true, statusText: 'Forwarded', remarks: 'Forwarded to the Engineering Section (Roads) for inspection.' }, ago(20));
    await repo.addNotification({ user_id: userId, complaint_id: c.id, title: 'Your pothole complaint was filed', body: `Reference ${no}. We'll keep checking on it for you.` });
  }

  // 3. Filed 14 days ago with no action: the agent drafted an escalation that waits for approval.
  {
    const s = SAMPLES.streetlight;
    const j = await sandboxOffice(s.issue);
    const filedAt = ago(s.createdHoursAgo - 0.05);
    const no = fileOnSandbox(s, filedAt, 'Registered', 'Grievance received and forwarded to the concerned section.');
    const c = await create(userId, s, j, { status: 'submitted', tracking_id: no, portal_status: 'Registered', submitted_at: filedAt, last_checked_at: ago(10) });
    await markFiled(c, s.createdHoursAgo - 0.05, no);
    await repo.addStatusCheck({ complaint_id: c.id, status_found: 'Registered', source: 'scraped', raw_snapshot: null, checked_at: ago(10) });
    await log('monitoring_agent', c.id, 'check_status_via_scraper', {}, { ok: true, statusText: 'Registered', remarks: 'No action recorded yet.' }, ago(10));
    const step = j.escalation_contact.find((x) => x.level === 1)!;
    const subject = `Escalation: street light complaint ${no} unresolved for 14 days`;
    const body = `To\n${step.title}\n\nSubject: ${subject}\n\nRespected Sir/Madam,\n\nOn ${new Date(filedAt).toDateString()} I filed grievance ${no} about a damaged street light pole on Pebbair Road near the Government Junior College, Wanaparthy. The lane has now been dark at night for over four weeks and the portal still shows the grievance as "Registered", with no action recorded.\n\nI request you to direct the Engineering Section (Street Lighting) to repair the light, and to let me know when the work is planned.\n\nYours faithfully,\nDemo Citizen\nMobile: 9876543210`;
    await repo.addEscalation({
      complaint_id: c.id,
      escalation_level: 1,
      action_taken: 'Drafted an escalation to the Municipal Commissioner. Waiting for your approval.',
      channel: 'email',
      recipient: step.contact,
      draft_text: body,
      subject,
      body,
      delivery_status: 'awaiting_approval',
    });
    await log('monitoring_agent', c.id, 'draft_escalation', { level: 1 }, { ok: true, level: 1 }, ago(9.9));
    await repo.addNotification({ user_id: userId, complaint_id: c.id, title: 'No progress on your street light complaint', body: 'We drafted a letter to the Municipal Commissioner. Review it and tap Send if you agree.' });
  }

  // 4. Filed 20 days ago and resolved.
  {
    const s = SAMPLES.garbage;
    const filedAt = ago(s.createdHoursAgo - 0.05);
    const no = fileOnSandbox(s, filedAt, 'Resolved', 'Garbage cleared and bin area cleaned by the sanitation team.');
    const c = await create(userId, s, await sandboxOffice(s.issue), {
      status: 'resolved',
      tracking_id: no,
      portal_status: 'Resolved',
      submitted_at: filedAt,
      resolved_at: ago(24 * 17),
      last_checked_at: ago(24 * 17),
    });
    await markFiled(c, s.createdHoursAgo - 0.05, no);
    await repo.addStatusCheck({ complaint_id: c.id, status_found: 'Resolved', source: 'scraped', raw_snapshot: null, checked_at: ago(24 * 17) });
    await log('monitoring_agent', c.id, 'check_status_via_scraper', {}, { ok: true, isResolved: true, statusText: 'Resolved', remarks: 'Garbage cleared and bin area cleaned by the sanitation team.' }, ago(24 * 17));
    await repo.addNotification({ user_id: userId, complaint_id: c.id, title: 'Resolved: garbage on Temple Street', body: 'The municipality marked your complaint as resolved.' });
  }
}
