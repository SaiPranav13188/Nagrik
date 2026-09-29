export type IssueType = 'pothole' | 'streetlight' | 'garbage' | 'water_leakage' | 'drainage' | 'other';
export type ComplaintStatus = 'analyzing' | 'drafted' | 'submitting' | 'submitted' | 'submission_failed' | 'escalated' | 'resolved';

export interface Profile {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  expo_push_token: string | null;
  preferred_language: 'en' | 'te' | 'hi';
  auto_submit_default: boolean;
}

export interface Complaint {
  id: string;
  user_id: string;
  photo_url: string | null;
  issue_type: IssueType | null;
  description: string | null;
  user_note: string | null;
  severity: 'low' | 'medium' | 'high' | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  city: string | null;
  jurisdiction_department: string | null;
  jurisdiction_portal_id: string | null;
  draft_text: string | null;
  draft_subject: string | null;
  status: ComplaintStatus;
  failure_reason: string | null;
  tracking_id: string | null;
  portal_status: string | null;
  auto_submit: boolean;
  submit_after: string | null;
  submitted_at: string | null;
  last_checked_at: string | null;
  escalation_level: number;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivityItem {
  id: string;
  at: string;
  agent: string;
  tool: string;
  title: string;
  detail: string | null;
  tone: 'info' | 'success' | 'warning' | 'error';
  icon: string;
}

export interface Escalation {
  id: string;
  escalation_level: number;
  action_taken: string;
  channel: 'email' | 'portal' | null;
  recipient: string | null;
  draft_text: string | null;
  delivery_status: 'sent' | 'manual_required' | 'blocked_unverified' | 'failed';
  created_at: string;
}

export interface StatusCheck {
  id: string;
  checked_at: string;
  status_found: string;
  source: 'scraped' | 'user_reported';
}

export interface ComplaintDetail {
  complaint: Complaint;
  failure: { category: string; message: string } | null;
  jurisdiction: {
    id: string;
    department_name: string;
    portal_url: string;
    is_sandbox: boolean;
    verified: boolean;
    requires_captcha: boolean;
    automated: boolean;
    notes: string | null;
    escalation_chain: Array<{ level: number; title: string; channel: 'email' | 'portal'; contact: string; verified: boolean }>;
  } | null;
  status_checks: StatusCheck[];
  escalations: Escalation[];
  activity: ActivityItem[];
  server_time: string;
}

export interface AppNotification {
  id: string;
  complaint_id: string | null;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
}

export type AnalyzeResult =
  | { result: 'created'; complaint: Complaint }
  | { result: 'clarification'; intakeId: string; photoUrl: string; question: string; options: Array<{ issue_type: IssueType; label: string }> }
  | { result: 'rejected'; intakeId: string; photoUrl: string; reason: string };
