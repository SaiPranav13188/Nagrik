import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { repo } from '../db/index.js';
import { SupabaseRepo } from '../db/supabaseRepo.js';

/**
 * A realistic stand-in for a municipal grievance portal — deliberately plain server-rendered HTML
 * like most Indian ULB portals. It lets the Submission and Monitoring agents run their full loop
 * (fill form → capture grievance number → scrape status → escalate) without touching a real office.
 * Admins can toggle a CAPTCHA to exercise the manual-fallback path, and set grievance statuses.
 */

interface Grievance {
  no: string;
  name: string;
  mobile: string;
  email: string;
  category: string;
  subject: string;
  description: string;
  location: string;
  lat: string;
  lng: string;
  hasPhoto: boolean;
  status: string;
  remarks: string;
  createdAt: string;
  updatedAt: string;
}

interface PortalState {
  seq: number;
  captchaEnabled: boolean;
  grievances: Grievance[];
}

const file = path.resolve(config.localDataDir, 'sandbox-portal.json');
let state: PortalState = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, 'utf8'))
  : { seq: 0, captchaEnabled: false, grievances: [] };

// Render's free disk is wiped on every restart, which lost grievances (status checks then timed out)
// and restarted numbering at 000001. With Supabase, the state also lives in a private storage bucket.
const BUCKET = 'sandbox-portal';
const KEY = 'state.json';
let uploads = Promise.resolve();
const save = () => {
  fs.writeFileSync(file, JSON.stringify(state, null, 1));
  if (!(repo instanceof SupabaseRepo)) return;
  const bucket = repo.client.storage.from(BUCKET);
  const body = JSON.stringify(state);
  // Chained so an older snapshot never overwrites a newer one.
  uploads = uploads.then(async () => {
    const { error } = await bucket.upload(KEY, body, { contentType: 'application/json', upsert: true });
    if (error) console.warn('[sandbox] could not save portal state:', error.message);
  });
};

/** Loads the persisted portal state; the first time, rebuilds it from complaints already filed here. */
export async function loadSandboxState() {
  if (!(repo instanceof SupabaseRepo)) return;
  const storage = repo.client.storage;
  await storage.createBucket(BUCKET, { public: false }).catch(() => undefined); // already exists → error, fine
  const { data } = await storage.from(BUCKET).download(KEY);
  if (data) {
    state = JSON.parse(await data.text());
    return;
  }
  const { data: rows, error } = await repo.client
    .from('complaints')
    .select('tracking_id, status, draft_subject, description, address, latitude, longitude, submitted_at, created_at')
    .like('tracking_id', 'WNP/%');
  if (error) return console.warn('[sandbox] could not rebuild portal state:', error.message);
  const seqOf = (no: string) => Number(no.split('/').pop()) || 0;
  for (const r of rows ?? []) {
    if (state.grievances.some((g) => g.no === r.tracking_id)) continue;
    const at = r.submitted_at ?? r.created_at;
    const resolved = r.status === 'resolved';
    state.grievances.push({
      no: r.tracking_id,
      name: '',
      mobile: '',
      email: '',
      category: '',
      subject: r.draft_subject ?? '',
      description: r.description ?? '',
      location: r.address ?? '',
      lat: r.latitude != null ? String(r.latitude) : '',
      lng: r.longitude != null ? String(r.longitude) : '',
      hasPhoto: false,
      status: resolved ? 'Resolved' : 'Registered',
      remarks: resolved ? 'Work completed.' : 'Grievance received and forwarded to the concerned section.',
      createdAt: at,
      updatedAt: at,
    });
  }
  state.seq = Math.max(state.seq, ...state.grievances.map((g) => seqOf(g.no)));
  save();
  console.log(`[sandbox] rebuilt portal state: ${state.grievances.length} grievance(s), next no. ${state.seq + 1}`);
}

export const sandboxState = {
  get: () => state,
  setCaptcha(enabled: boolean) {
    state.captchaEnabled = enabled;
    save();
  },
  setStatus(no: string, status: string, remarks: string) {
    const g = state.grievances.find((x) => x.no === no);
    if (!g) return null;
    g.status = status;
    g.remarks = remarks;
    g.updatedAt = new Date().toISOString();
    save();
    return g;
  },
};

const CATEGORIES: Array<[string, string]> = [
  ['', '-- Select Category --'],
  ['ROADS', 'Roads & Potholes'],
  ['STREET_LIGHTS', 'Street Lights'],
  ['SANITATION', 'Sanitation / Garbage'],
  ['WATER_SUPPLY', 'Water Supply'],
  ['DRAINAGE', 'Drainage & Sewerage'],
  ['OTHERS', 'Others'],
];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | Wanaparthy Municipality (Sandbox)</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;margin:0;background:#f3f4f6;color:#1f2937}
header{background:#7c2d12;color:#fff;padding:14px 20px}header h1{margin:0;font-size:20px}header p{margin:4px 0 0;font-size:12px;opacity:.85}
.banner{background:#fef3c7;color:#92400e;padding:8px 20px;font-size:13px;border-bottom:1px solid #fcd34d}
nav{background:#9a3412;padding:6px 20px}nav a{color:#fff;margin-right:18px;font-size:14px;text-decoration:none}
main{max-width:760px;margin:24px auto;background:#fff;padding:24px;border:1px solid #e5e7eb}
label{display:block;font-weight:bold;font-size:14px;margin:14px 0 4px}input[type=text],input[type=email],select,textarea{width:100%;padding:8px;border:1px solid #9ca3af;box-sizing:border-box;font-size:14px}
textarea{min-height:110px}.req{color:#b91c1c}button{background:#9a3412;color:#fff;border:0;padding:10px 22px;font-size:15px;margin-top:18px;cursor:pointer}
.ack-success{background:#ecfdf5;border:1px solid #10b981;padding:16px}.err{background:#fef2f2;border:1px solid #ef4444;padding:12px;color:#991b1b}
table{border-collapse:collapse;width:100%}td{border:1px solid #e5e7eb;padding:8px;font-size:14px}td:first-child{font-weight:bold;width:35%;background:#f9fafb}
</style></head><body>
<header><h1>Wanaparthy Municipality</h1><p>Citizen Grievance Redressal System · Wanaparthy District, Telangana – 509103</p></header>
<div class="banner">SANDBOX PORTAL — mirrors the municipal grievance workflow for testing. Complaints here are not sent to the municipality.</div>
<nav><a href="/sandbox-portal">Lodge Grievance</a><a href="/sandbox-portal/track">Track Grievance</a></nav>
<main>${body}</main></body></html>`;
}

function formPage(error?: string) {
  const opts = CATEGORIES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  const captcha = state.captchaEnabled
    ? `<label for="captchaInput">Enter the characters shown <span class="req">*</span></label>
       <img id="captchaImage" alt="captcha" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='36'><text x='10' y='26' font-size='22' font-family='monospace'>7xK2p</text></svg>"/>
       <input type="text" id="captchaInput" name="captcha" required>`
    : '';
  return layout(
    'Lodge Grievance',
    `<h2>Lodge a Public Grievance</h2>${error ? `<div class="err">${esc(error)}</div>` : ''}
<form id="grievanceForm" method="post" action="/sandbox-portal/submit" enctype="multipart/form-data">
<label for="citizenName">Citizen Name <span class="req">*</span></label><input type="text" id="citizenName" name="name" required>
<label for="mobile">Mobile Number <span class="req">*</span></label><input type="text" id="mobile" name="mobile" maxlength="13" required>
<label for="email">Email</label><input type="email" id="email" name="email">
<label for="category">Grievance Category <span class="req">*</span></label><select id="category" name="category" required>${opts}</select>
<label for="subject">Subject <span class="req">*</span></label><input type="text" id="subject" name="subject" maxlength="100" required>
<label for="description">Grievance Details <span class="req">*</span></label><textarea id="description" name="description" maxlength="1500" required></textarea>
<label for="location">Location / Address with Landmark <span class="req">*</span></label><textarea id="location" name="location" required></textarea>
<input type="hidden" id="lat" name="lat"><input type="hidden" id="lng" name="lng">
<label for="photo">Upload Photo (optional, max 5 MB)</label><input type="file" id="photo" name="photo" accept="image/*">
${captcha}
<label><input type="checkbox" id="declaration" name="declaration" value="yes" required> I declare that the information furnished is true.</label>
<button type="submit" id="submitBtn">Submit Grievance</button>
</form>`,
  );
}

export const sandboxPortalRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

sandboxPortalRouter.get('/', (_req, res) => {
  res.type('html').send(formPage());
});

sandboxPortalRouter.post('/submit', upload.single('photo'), (req, res) => {
  const b = req.body as Record<string, string>;
  if (state.captchaEnabled && (b.captcha || '').trim() !== '7xK2p') {
    return res.status(400).type('html').send(formPage('Invalid captcha. Please try again.'));
  }
  const missing = ['name', 'mobile', 'category', 'subject', 'description', 'location'].filter((k) => !b[k]?.trim());
  if (missing.length || b.declaration !== 'yes') {
    return res.status(400).type('html').send(formPage(`Please fill all mandatory fields: ${missing.join(', ') || 'declaration'}`));
  }
  if (!/^(\+?91)?[6-9]\d{9}$/.test(b.mobile.replace(/\s|-/g, ''))) {
    return res.status(400).type('html').send(formPage('Please enter a valid 10 digit mobile number.'));
  }
  state.seq += 1;
  const no = `WNP/${new Date().getFullYear()}/${String(state.seq).padStart(6, '0')}`;
  const ts = new Date().toISOString();
  state.grievances.push({
    no,
    name: b.name,
    mobile: b.mobile,
    email: b.email || '',
    category: b.category,
    subject: b.subject,
    description: b.description,
    location: b.location,
    lat: b.lat || '',
    lng: b.lng || '',
    hasPhoto: !!req.file,
    status: 'Registered',
    remarks: 'Grievance received and forwarded to the concerned section.',
    createdAt: ts,
    updatedAt: ts,
  });
  save();
  res.type('html').send(
    layout(
      'Acknowledgement',
      `<div class="ack-success"><h2>Grievance Registered Successfully</h2>
<p>Your Grievance No: <strong id="grievanceNo">${no}</strong></p>
<p>Please quote this number for all future correspondence. Expected resolution: 7 working days.</p></div>
<table><tr><td>Category</td><td>${esc(b.category)}</td></tr><tr><td>Subject</td><td>${esc(b.subject)}</td></tr><tr><td>Registered On</td><td>${new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr></table>`,
    ),
  );
});

sandboxPortalRouter.get('/track', (req, res) => {
  const no = typeof req.query.no === 'string' ? req.query.no.trim() : '';
  const g = no ? state.grievances.find((x) => x.no.toLowerCase() === no.toLowerCase()) : null;
  const result = !no
    ? ''
    : g
      ? `<h3>Grievance Status</h3><table><tr><td>Grievance No</td><td>${esc(g.no)}</td></tr><tr><td>Subject</td><td>${esc(g.subject)}</td></tr>
<tr><td>Current Status</td><td id="currentStatus">${esc(g.status)}</td></tr><tr><td>Officer Remarks</td><td id="remarks">${esc(g.remarks)}</td></tr>
<tr><td>Last Updated</td><td>${new Date(g.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr></table>`
      : `<div class="err">No grievance found with number ${esc(no)}.</div>`;
  res.type('html').send(
    layout(
      'Track Grievance',
      `<h2>Track Your Grievance</h2><form method="get" action="/sandbox-portal/track">
<label for="trackNo">Grievance Number</label><input type="text" id="trackNo" name="no" value="${esc(no)}" placeholder="WNP/2026/000001">
<button type="submit" id="trackBtn">Get Status</button></form>${result}`,
    ),
  );
});

sandboxPortalRouter.get('/cdma', (_req, res) => {
  res.type('html').send(layout('CDMA', '<h2>CDMA Telangana — Grievance (sandbox)</h2><p>This escalation destination has no verified form mapping yet.</p>'));
});

export const sandboxAdminRouter = Router();
sandboxAdminRouter.use(express.json());
sandboxAdminRouter.get('/', (_req, res) => res.json(state));
sandboxAdminRouter.post('/captcha', (req, res) => {
  sandboxState.setCaptcha(Boolean(req.body?.enabled));
  res.json({ captchaEnabled: state.captchaEnabled });
});
sandboxAdminRouter.post('/grievances/status', (req, res) => {
  const { no, status, remarks } = req.body ?? {};
  const g = sandboxState.setStatus(String(no), String(status || 'Resolved'), String(remarks || ''));
  if (!g) return res.status(404).json({ error: 'Not found' });
  res.json(g);
});
