import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { JurisdictionQuery, NewComplaint, Repo } from './repo.js';
import type {
  Complaint,
  ComplaintStatus,
  Escalation,
  Jurisdiction,
  Notification,
  Profile,
  ReviewStatus,
  StatusCheck,
  ToolLog,
} from './types.js';
import { buildSeedJurisdictions } from './seed.js';
import { cityMatches } from './localRepo.js';

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

/**
 * Production store. Uses the service-role key (server only) — RLS still protects any direct
 * client access, and every query here is scoped by the authenticated user in the route layer.
 */
export class SupabaseRepo implements Repo {
  kind = 'supabase' as const;
  readonly client: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async syncSeeds() {
    const rows = buildSeedJurisdictions().map(({ created_at, ...r }) => r);
    const res = await this.client.from('jurisdiction_lookup').upsert(rows, { onConflict: 'id' });
    if (res.error) console.warn('[seed] jurisdiction sync failed:', res.error.message);
  }

  async getProfile(id: string) {
    return must(await this.client.from('profiles').select('*').eq('id', id).maybeSingle(), 'getProfile') as Profile | null;
  }

  async upsertProfile(p: Partial<Profile> & { id: string }) {
    return must(
      await this.client.from('profiles').upsert({ ...p, updated_at: new Date().toISOString() }).select().single(),
      'upsertProfile',
    ) as Profile;
  }

  async createComplaint(c: NewComplaint) {
    return must(await this.client.from('complaints').insert(c).select().single(), 'createComplaint') as Complaint;
  }

  async getComplaint(id: string) {
    return must(await this.client.from('complaints').select('*').eq('id', id).maybeSingle(), 'getComplaint') as Complaint | null;
  }

  async updateComplaint(id: string, patch: Partial<Complaint>) {
    return must(
      await this.client
        .from('complaints')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single(),
      'updateComplaint',
    ) as Complaint;
  }

  async deleteComplaint(id: string) {
    must(await this.client.from('complaints').delete().eq('id', id), 'deleteComplaint');
  }

  async listComplaintsByUser(userId: string) {
    return must(
      await this.client.from('complaints').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      'listComplaintsByUser',
    ) as Complaint[];
  }

  async listComplaintsByStatus(statuses: ComplaintStatus[]) {
    return must(
      await this.client.from('complaints').select('*').in('status', statuses).limit(1000),
      'listComplaintsByStatus',
    ) as Complaint[];
  }

  async findJurisdictions(q: JurisdictionQuery) {
    const rows = must(
      await this.client
        .from('jurisdiction_lookup')
        .select('*')
        .eq('issue_type', q.issueType)
        .eq('is_sandbox', q.sandbox)
        .in('review_status', q.reviewStatuses),
      'findJurisdictions',
    ) as Jurisdiction[];
    return rows.filter((j) => cityMatches(j.city, q.city) && (!q.state || cityMatches(j.state, q.state)));
  }

  async getJurisdiction(id: string) {
    return must(
      await this.client.from('jurisdiction_lookup').select('*').eq('id', id).maybeSingle(),
      'getJurisdiction',
    ) as Jurisdiction | null;
  }

  async insertJurisdiction(j: Omit<Jurisdiction, 'id' | 'created_at'>) {
    return must(await this.client.from('jurisdiction_lookup').insert(j).select().single(), 'insertJurisdiction') as Jurisdiction;
  }

  async updateJurisdiction(id: string, patch: Partial<Jurisdiction>) {
    return must(
      await this.client.from('jurisdiction_lookup').update(patch).eq('id', id).select().single(),
      'updateJurisdiction',
    ) as Jurisdiction;
  }

  async listJurisdictions(reviewStatus?: ReviewStatus) {
    let q = this.client.from('jurisdiction_lookup').select('*').order('created_at', { ascending: false });
    if (reviewStatus) q = q.eq('review_status', reviewStatus);
    return must(await q, 'listJurisdictions') as Jurisdiction[];
  }

  async addStatusCheck(s: Omit<StatusCheck, 'id' | 'checked_at'>) {
    return must(await this.client.from('complaint_status_checks').insert(s).select().single(), 'addStatusCheck') as StatusCheck;
  }

  async listStatusChecks(complaintId: string) {
    return must(
      await this.client
        .from('complaint_status_checks')
        .select('*')
        .eq('complaint_id', complaintId)
        .order('checked_at', { ascending: false }),
      'listStatusChecks',
    ) as StatusCheck[];
  }

  async addEscalation(e: Omit<Escalation, 'id' | 'created_at'>) {
    return must(await this.client.from('complaint_escalations').insert(e).select().single(), 'addEscalation') as Escalation;
  }

  async listEscalations(complaintId: string) {
    return must(
      await this.client
        .from('complaint_escalations')
        .select('*')
        .eq('complaint_id', complaintId)
        .order('created_at', { ascending: false }),
      'listEscalations',
    ) as Escalation[];
  }

  async addToolLog(l: Omit<ToolLog, 'id' | 'created_at'>) {
    const res = await this.client.from('agent_tool_logs').insert(l);
    if (res.error) console.error('[agent_tool_logs] insert failed', res.error.message);
  }

  async listToolLogs(opts: { complaintId?: string; limit?: number; toolName?: string }) {
    let q = this.client.from('agent_tool_logs').select('*').order('created_at', { ascending: false }).limit(opts.limit ?? 200);
    if (opts.complaintId) q = q.eq('complaint_id', opts.complaintId);
    if (opts.toolName) q = q.eq('tool_name', opts.toolName);
    return must(await q, 'listToolLogs') as ToolLog[];
  }

  async addNotification(n: Omit<Notification, 'id' | 'created_at' | 'read'>) {
    return must(await this.client.from('notifications').insert(n).select().single(), 'addNotification') as Notification;
  }

  async listNotifications(userId: string) {
    return must(
      await this.client
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(100),
      'listNotifications',
    ) as Notification[];
  }

  async markNotificationsRead(userId: string) {
    must(await this.client.from('notifications').update({ read: true }).eq('user_id', userId), 'markNotificationsRead');
  }
}
