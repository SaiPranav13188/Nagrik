import type {
  Complaint,
  ComplaintStatus,
  Escalation,
  IssueType,
  Jurisdiction,
  Notification,
  Profile,
  ReviewStatus,
  StatusCheck,
  ToolLog,
} from './types.js';

export type NewComplaint = Pick<Complaint, 'user_id'> & Partial<Omit<Complaint, 'created_at' | 'updated_at'>>;

export interface JurisdictionQuery {
  city: string;
  state?: string;
  issueType: IssueType;
  sandbox: boolean;
  reviewStatuses: ReviewStatus[];
}

/**
 * Storage abstraction. `SupabaseRepo` is the production implementation; `LocalRepo`
 * is a JSON-file store so the whole system runs on a laptop with zero accounts.
 */
export interface Repo {
  kind: 'supabase' | 'local';

  getProfile(id: string): Promise<Profile | null>;
  upsertProfile(p: Partial<Profile> & { id: string }): Promise<Profile>;

  createComplaint(c: NewComplaint): Promise<Complaint>;
  getComplaint(id: string): Promise<Complaint | null>;
  updateComplaint(id: string, patch: Partial<Complaint>): Promise<Complaint>;
  deleteComplaint(id: string): Promise<void>;
  listComplaintsByUser(userId: string): Promise<Complaint[]>;
  listComplaintsByStatus(statuses: ComplaintStatus[]): Promise<Complaint[]>;

  findJurisdictions(q: JurisdictionQuery): Promise<Jurisdiction[]>;
  getJurisdiction(id: string): Promise<Jurisdiction | null>;
  insertJurisdiction(j: Omit<Jurisdiction, 'id' | 'created_at'>): Promise<Jurisdiction>;
  updateJurisdiction(id: string, patch: Partial<Jurisdiction>): Promise<Jurisdiction>;
  listJurisdictions(reviewStatus?: ReviewStatus): Promise<Jurisdiction[]>;

  addStatusCheck(s: Omit<StatusCheck, 'id' | 'checked_at'>): Promise<StatusCheck>;
  listStatusChecks(complaintId: string): Promise<StatusCheck[]>;

  addEscalation(e: Omit<Escalation, 'id' | 'created_at'>): Promise<Escalation>;
  listEscalations(complaintId: string): Promise<Escalation[]>;

  addToolLog(l: Omit<ToolLog, 'id' | 'created_at'>): Promise<void>;
  listToolLogs(opts: { complaintId?: string; limit?: number; toolName?: string }): Promise<ToolLog[]>;

  addNotification(n: Omit<Notification, 'id' | 'created_at' | 'read'>): Promise<Notification>;
  listNotifications(userId: string): Promise<Notification[]>;
  markNotificationsRead(userId: string): Promise<void>;
}
