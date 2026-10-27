import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JurisdictionQuery, NewComplaint, NewEscalation, Repo } from './repo.js';
import type {
  Complaint,
  ComplaintStatus,
  Escalation,
  Jurisdiction,
  Notification,
  Profile,
  ReviewStatus,
  StatusCheck,
  Supporter,
  ToolLog,
} from './types.js';
import { buildSeedJurisdictions } from './seed.js';

interface Data {
  profiles: Profile[];
  complaints: Complaint[];
  jurisdiction_lookup: Jurisdiction[];
  complaint_status_checks: StatusCheck[];
  complaint_escalations: Escalation[];
  agent_tool_logs: ToolLog[];
  notifications: Notification[];
  complaint_supporters: Supporter[];
}

const now = () => new Date().toISOString();
const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase();
export const cityMatches = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

/** JSON-file backed store for zero-setup local development. Single process only. */
export class LocalRepo implements Repo {
  kind = 'local' as const;
  private data: Data;
  private file: string;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'db.json');
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } else {
      this.data = {
        profiles: [],
        complaints: [],
        jurisdiction_lookup: [],
        complaint_status_checks: [],
        complaint_escalations: [],
        agent_tool_logs: [],
        notifications: [],
        complaint_supporters: [],
      };
    }
    this.data.complaint_supporters ??= [];
    for (const c of this.data.complaints) c.supporters_count ??= 0;
    // Seeds are idempotent: re-sync trusted seed rows on every boot so edits to seed.ts apply.
    for (const seed of buildSeedJurisdictions()) {
      const i = this.data.jurisdiction_lookup.findIndex((j) => j.id === seed.id);
      if (i === -1) this.data.jurisdiction_lookup.push(seed);
      else this.data.jurisdiction_lookup[i] = { ...seed, created_at: this.data.jurisdiction_lookup[i].created_at };
    }
    this.flush();
  }

  private persist() {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }

  async getProfile(id: string) {
    return this.data.profiles.find((p) => p.id === id) ?? null;
  }

  async upsertProfile(p: Partial<Profile> & { id: string }) {
    const existing = this.data.profiles.find((x) => x.id === p.id);
    if (existing) {
      Object.assign(existing, p, { updated_at: now() });
      this.persist();
      return existing;
    }
    const row: Profile = {
      full_name: null,
      phone: null,
      email: null,
      avatar_url: null,
      expo_push_token: null,
      preferred_language: 'en',
      auto_submit_default: true,
      created_at: now(),
      updated_at: now(),
      ...p,
    };
    this.data.profiles.push(row);
    this.persist();
    return row;
  }

  async createComplaint(c: NewComplaint) {
    const row: Complaint = {
      id: randomUUID(),
      photo_url: null,
      issue_type: null,
      description: null,
      user_note: null,
      severity: null,
      latitude: null,
      longitude: null,
      address: null,
      city: null,
      state: null,
      pincode: null,
      jurisdiction_department: null,
      jurisdiction_portal_id: null,
      draft_text: null,
      draft_subject: null,
      status: 'analyzing',
      failure_reason: null,
      tracking_id: null,
      portal_status: null,
      auto_submit: true,
      submit_after: null,
      submitted_at: null,
      last_checked_at: null,
      escalation_level: 0,
      supporters_count: 0,
      resolved_at: null,
      created_at: now(),
      updated_at: now(),
      ...c,
    };
    this.data.complaints.push(row);
    this.persist();
    return row;
  }

  async getComplaint(id: string) {
    return this.data.complaints.find((c) => c.id === id) ?? null;
  }

  async updateComplaint(id: string, patch: Partial<Complaint>) {
    const row = this.data.complaints.find((c) => c.id === id);
    if (!row) throw new Error(`Complaint ${id} not found`);
    Object.assign(row, patch, { updated_at: now() });
    this.persist();
    return row;
  }

  async deleteComplaint(id: string) {
    this.data.complaints = this.data.complaints.filter((c) => c.id !== id);
    this.data.complaint_supporters = this.data.complaint_supporters.filter((x) => x.complaint_id !== id);
    this.persist();
  }

  async listComplaintsByUser(userId: string) {
    return this.data.complaints
      .filter((c) => c.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async listComplaintsByStatus(statuses: ComplaintStatus[]) {
    return this.data.complaints.filter((c) => statuses.includes(c.status));
  }

  async findJurisdictions(q: JurisdictionQuery) {
    return this.data.jurisdiction_lookup.filter(
      (j) =>
        j.issue_type === q.issueType &&
        j.is_sandbox === q.sandbox &&
        q.reviewStatuses.includes(j.review_status) &&
        cityMatches(j.city, q.city) &&
        (!q.state || !j.state || cityMatches(j.state, q.state)),
    );
  }

  async getJurisdiction(id: string) {
    return this.data.jurisdiction_lookup.find((j) => j.id === id) ?? null;
  }

  async insertJurisdiction(j: Omit<Jurisdiction, 'id' | 'created_at'>) {
    const row: Jurisdiction = { ...j, id: randomUUID(), created_at: now() };
    this.data.jurisdiction_lookup.push(row);
    this.persist();
    return row;
  }

  async updateJurisdiction(id: string, patch: Partial<Jurisdiction>) {
    const row = this.data.jurisdiction_lookup.find((j) => j.id === id);
    if (!row) throw new Error(`Jurisdiction ${id} not found`);
    Object.assign(row, patch);
    this.persist();
    return row;
  }

  async listJurisdictions(reviewStatus?: ReviewStatus) {
    return this.data.jurisdiction_lookup
      .filter((j) => !reviewStatus || j.review_status === reviewStatus)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async addSupporter(complaintId: string, userId: string) {
    if (this.data.complaint_supporters.some((x) => x.complaint_id === complaintId && x.user_id === userId)) return false;
    this.data.complaint_supporters.push({ complaint_id: complaintId, user_id: userId, created_at: now() });
    this.syncCount(complaintId);
    return true;
  }

  async removeSupporter(complaintId: string, userId: string) {
    this.data.complaint_supporters = this.data.complaint_supporters.filter((x) => !(x.complaint_id === complaintId && x.user_id === userId));
    this.syncCount(complaintId);
  }

  private syncCount(complaintId: string) {
    const c = this.data.complaints.find((x) => x.id === complaintId);
    if (c) c.supporters_count = this.data.complaint_supporters.filter((x) => x.complaint_id === complaintId).length;
    this.persist();
  }

  async listSupporters(complaintId: string) {
    return this.data.complaint_supporters.filter((x) => x.complaint_id === complaintId);
  }

  async listSupportedComplaints(userId: string) {
    const ids = new Set(this.data.complaint_supporters.filter((x) => x.user_id === userId).map((x) => x.complaint_id));
    return this.data.complaints.filter((c) => ids.has(c.id));
  }

  async listComplaintsInBox(b: { minLat: number; maxLat: number; minLng: number; maxLng: number }, limit: number) {
    return this.data.complaints
      .filter((c) => c.latitude != null && c.longitude != null && c.latitude >= b.minLat && c.latitude <= b.maxLat && c.longitude >= b.minLng && c.longitude <= b.maxLng)
      .sort((x, y) => y.created_at.localeCompare(x.created_at))
      .slice(0, limit);
  }

  async addStatusCheck(s: Omit<StatusCheck, 'id' | 'checked_at'>) {
    const row: StatusCheck = { ...s, id: randomUUID(), checked_at: now() };
    this.data.complaint_status_checks.push(row);
    this.persist();
    return row;
  }

  async listStatusChecks(complaintId: string) {
    return this.data.complaint_status_checks
      .filter((s) => s.complaint_id === complaintId)
      .sort((a, b) => b.checked_at.localeCompare(a.checked_at));
  }

  async addEscalation(e: NewEscalation) {
    const row: Escalation = { subject: null, body: null, approved_by: null, approved_at: null, reminded_at: null, ...e, id: randomUUID(), created_at: now() };
    this.data.complaint_escalations.push(row);
    this.persist();
    return row;
  }

  async listEscalations(complaintId: string) {
    return this.data.complaint_escalations
      .filter((e) => e.complaint_id === complaintId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getEscalation(id: string) {
    return this.data.complaint_escalations.find((e) => e.id === id) ?? null;
  }

  async updateEscalation(id: string, patch: Partial<Escalation>) {
    const row = this.data.complaint_escalations.find((e) => e.id === id);
    if (!row) throw new Error(`Escalation ${id} not found`);
    Object.assign(row, patch);
    this.persist();
    return row;
  }

  async countApprovedEscalations(userId: string, sinceIso: string) {
    return this.data.complaint_escalations.filter((e) => e.approved_by === userId && !!e.approved_at && e.approved_at >= sinceIso).length;
  }

  async deleteUserData(userId: string) {
    const ids = new Set(this.data.complaints.filter((c) => c.user_id === userId).map((c) => c.id));
    const supported = this.data.complaint_supporters.filter((x) => x.user_id === userId).map((x) => x.complaint_id);
    const d = this.data;
    d.complaints = d.complaints.filter((c) => !ids.has(c.id));
    d.complaint_status_checks = d.complaint_status_checks.filter((s) => !ids.has(s.complaint_id));
    d.complaint_escalations = d.complaint_escalations.filter((e) => !ids.has(e.complaint_id));
    d.agent_tool_logs = d.agent_tool_logs.filter((l) => !l.complaint_id || !ids.has(l.complaint_id));
    d.notifications = d.notifications.filter((n) => n.user_id !== userId);
    d.complaint_supporters = d.complaint_supporters.filter((x) => x.user_id !== userId && !ids.has(x.complaint_id));
    d.profiles = d.profiles.filter((p) => p.id !== userId);
    for (const id of supported) this.syncCount(id);
    this.persist();
  }

  async addToolLog(l: Omit<ToolLog, 'id' | 'created_at'>) {
    this.data.agent_tool_logs.push({ ...l, id: randomUUID(), created_at: now() });
    // Keep the local file bounded.
    if (this.data.agent_tool_logs.length > 20000) this.data.agent_tool_logs.splice(0, 5000);
    this.persist();
  }

  async listToolLogs(opts: { complaintId?: string; limit?: number; toolName?: string }) {
    let rows = this.data.agent_tool_logs;
    if (opts.complaintId) rows = rows.filter((l) => l.complaint_id === opts.complaintId);
    if (opts.toolName) rows = rows.filter((l) => l.tool_name === opts.toolName);
    return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, opts.limit ?? 200);
  }

  async addNotification(n: Omit<Notification, 'id' | 'created_at' | 'read'>) {
    const row: Notification = { ...n, id: randomUUID(), read: false, created_at: now() };
    this.data.notifications.push(row);
    this.persist();
    return row;
  }

  async listNotifications(userId: string) {
    return this.data.notifications
      .filter((n) => n.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 100);
  }

  async markNotificationsRead(userId: string) {
    for (const n of this.data.notifications) if (n.user_id === userId) n.read = true;
    this.persist();
  }
}
