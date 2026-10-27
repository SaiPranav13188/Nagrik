export const ISSUE_TYPES = ['pothole', 'streetlight', 'garbage', 'water_leakage', 'drainage', 'other'] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const COMPLAINT_STATUSES = [
  'analyzing',
  'drafted',
  'submitting',
  'submitted',
  'submission_failed',
  'escalated',
  'resolved',
] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export interface Profile {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  expo_push_token: string | null;
  preferred_language: string;
  auto_submit_default: boolean;
  created_at: string;
  updated_at: string;
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
  state: string | null;
  pincode: string | null;
  jurisdiction_department: string | null;
  jurisdiction_portal_id: string | null;
  draft_text: string | null;
  draft_subject: string | null;
  status: ComplaintStatus;
  /** Human-readable reason the agent handed this complaint back for manual submission. */
  failure_reason: string | null;
  tracking_id: string | null;
  portal_status: string | null;
  auto_submit: boolean;
  /** Non-blocking grace window: submission starts at this time unless the user taps "Hold". */
  submit_after: string | null;
  submitted_at: string | null;
  last_checked_at: string | null;
  escalation_level: number;
  /** Other residents who tapped "Me too" (the reporter is not counted). */
  supporters_count: number;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Supporter {
  complaint_id: string;
  user_id: string;
  created_at: string;
}

export interface FormField {
  /** Field key in the complaint payload, e.g. "citizen_name", "description", "photo". */
  source: string;
  selector: string;
  type: 'text' | 'textarea' | 'select' | 'checkbox' | 'file' | 'hidden';
  required?: boolean;
  /** For selects: map our issue_type (or other values) to the portal's option values. */
  valueMap?: Record<string, string>;
  /** Constant value to use instead of a payload value. */
  constant?: string;
}

export interface FormSelectors {
  version: number;
  verified_at?: string;
  fields: FormField[];
  submit: string;
  /** Optional selector that must be visible before filling (form ready). */
  ready?: string;
  confirmation: {
    success_selector?: string;
    tracking_id_selector?: string;
    tracking_id_regex?: string;
  };
}

export interface StatusCheckSelectors {
  tracking_input: string;
  submit: string;
  status_text: string;
  remarks_text?: string;
  resolved_keywords: string[];
  rejected_keywords?: string[];
}

export interface EscalationStep {
  level: number;
  title: string;
  channel: 'email' | 'portal';
  contact: string;
  verified: boolean;
}

export type ReviewStatus = 'approved' | 'pending' | 'rejected';

export interface Jurisdiction {
  id: string;
  city: string;
  state: string;
  issue_type: IssueType;
  department_name: string;
  portal_url: string;
  form_selectors: FormSelectors | null;
  status_check_url_template: string | null;
  status_check_selectors: StatusCheckSelectors | null;
  escalation_contact: EscalationStep[];
  requires_captcha: boolean;
  notes: string | null;
  review_status: ReviewStatus;
  is_sandbox: boolean;
  source_urls: string[];
  proposed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  created_at: string;
}

export interface StatusCheck {
  id: string;
  complaint_id: string;
  checked_at: string;
  status_found: string;
  source: 'scraped' | 'user_reported';
  raw_snapshot: string | null;
}

export interface Escalation {
  id: string;
  complaint_id: string;
  escalation_level: number;
  action_taken: string;
  channel: 'email' | 'portal' | null;
  recipient: string | null;
  draft_text: string | null;
  /** awaiting_approval: an email draft that is only sent once the citizen approves this exact text. */
  delivery_status: 'awaiting_approval' | 'cancelled' | 'sent' | 'manual_required' | 'blocked_unverified' | 'failed';
  subject: string | null;
  body: string | null;
  approved_by: string | null;
  approved_at: string | null;
  reminded_at: string | null;
  created_at: string;
}

export interface ToolLog {
  id: string;
  agent_name: string;
  complaint_id: string | null;
  tool_name: string;
  arguments: unknown;
  result: unknown;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  complaint_id: string | null;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
}
