import type { ToolLog } from '../db/types.js';
import { ISSUE_LABELS } from '../agents/intake.js';

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

const AGENT_LABEL: Record<string, string> = {
  intake_agent: 'Intake',
  coordinator_agent: 'Coordinator',
  jurisdiction_agent: 'Routing',
  drafting_agent: 'Drafting',
  submission_agent: 'Filing',
  monitoring_agent: 'Monitoring',
};

const HIDDEN = new Set(['get_complaint_context', 'get_complaint_timeline', 'run_jurisdiction_agent', 'run_drafting_agent', 'notify_user', 'get_form_selectors', 'save_draft', '__model_error']);

/** Turns raw agent_tool_logs into a citizen-friendly "what the agents did" timeline. */
export function humanizeLogs(logs: ToolLog[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const l of [...logs].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (HIDDEN.has(l.tool_name)) continue;
    const a = (l.arguments ?? {}) as any;
    const r = (l.result ?? {}) as any;
    let title = l.tool_name.replace(/_/g, ' ');
    let detail: string | null = null;
    let tone: ActivityItem['tone'] = 'info';
    let icon = 'sparkles';
    if (l.error || r?.error) {
      tone = 'warning';
    }
    switch (l.tool_name) {
      case 'analyze_photo':
        icon = 'scan';
        title = 'Analyzed your photo';
        if (r.issue_type) detail = `${ISSUE_LABELS[r.issue_type as keyof typeof ISSUE_LABELS] ?? r.issue_type}${r.mode === 'offline_no_vision' ? '' : ` · ${Math.round((r.confidence ?? 0) * 100)}% confident`}`;
        break;
      case 'reverse_geocode':
        icon = 'location';
        title = 'Pinpointed the location';
        detail = r.address ?? null;
        break;
      case 'ask_user_clarification':
        icon = 'help-circle';
        title = 'Asked you to confirm the issue type';
        break;
      case 'save_complaint':
        icon = 'document-text';
        title = 'Created your complaint';
        break;
      case 'lookup_jurisdiction':
        icon = 'library';
        title = 'Checked the verified department directory';
        detail = r.approved?.length ? `Found ${r.approved[0].department_name}` : r.pending_review?.length ? 'Only an unverified match found' : 'No verified match';
        break;
      case 'web_search':
        icon = 'search';
        title = 'Searched official government sources';
        detail = a.query ?? null;
        break;
      case 'propose_new_jurisdiction':
        icon = 'git-pull-request';
        title = 'Proposed a new department mapping for admin review';
        detail = a.department ?? null;
        tone = 'warning';
        break;
      case 'assign_jurisdiction':
        icon = 'business';
        title = r.assigned ? 'Routed to the responsible department' : 'Routing attempt failed';
        detail = r.department ?? r.error ?? null;
        tone = r.assigned ? (r.trusted ? 'success' : 'warning') : 'warning';
        break;
      case 'report_no_jurisdiction':
        icon = 'alert-circle';
        title = "Couldn't confirm the department";
        detail = a.reason ?? null;
        tone = 'warning';
        break;
      case 'draft_complaint_text':
        icon = 'create';
        title = 'Drafted a formal complaint';
        detail = r.subject ?? null;
        break;
      case 'schedule_submission':
        icon = 'time';
        title = r.awaiting_user_approval ? 'Waiting for your go-ahead to submit' : 'Queued for filing';
        detail = r.submit_in_seconds ? `Submitting in ${r.submit_in_seconds}s unless you tap Hold` : null;
        break;
      case 'hand_off_to_citizen':
        icon = 'hand-left';
        title = 'Handed over to you to file';
        tone = 'warning';
        break;
      case 'fill_and_submit_form':
        icon = 'globe';
        title =
          r.outcome === 'submitted'
            ? 'Filled and submitted the portal form'
            : r.outcome === 'blocked_by_captcha'
              ? 'Portal asked for human verification'
              : 'Portal form could not be completed';
        detail = r.outcome === 'submitted' ? `${r.filledFields?.length ?? 0} fields filled incl. photo` : r.message ?? null;
        tone = r.outcome === 'submitted' ? 'success' : 'warning';
        break;
      case 'detect_captcha':
        icon = 'shield-checkmark';
        title = r.hasCaptcha ? 'Detected a CAPTCHA / OTP — not bypassing it' : 'No CAPTCHA detected';
        tone = r.hasCaptcha ? 'warning' : 'info';
        break;
      case 'extract_confirmation_details':
        icon = 'receipt';
        title = r.found ? 'Captured the reference number' : 'No reference number shown';
        detail = r.trackingId ?? null;
        tone = r.found ? 'success' : 'info';
        break;
      case 'mark_submitted':
        icon = 'checkmark-circle';
        title = 'Filed with the department';
        detail = a.tracking_id ? `Ref. ${a.tracking_id}` : null;
        tone = 'success';
        break;
      case 'flag_submission_failure':
        icon = 'hand-left';
        title = 'Needs you to finish filing';
        detail = a.reason ?? null;
        tone = 'warning';
        break;
      case 'check_status_via_scraper':
        icon = 'refresh';
        title = r.ok ? 'Checked status on the portal' : r.available === false ? 'Status check not available for this portal' : 'Status check failed';
        detail = r.ok ? `${r.statusText}${r.remarks ? ` — ${r.remarks}` : ''}` : r.message ?? null;
        tone = r.ok ? (r.isResolved ? 'success' : 'info') : 'warning';
        break;
      case 'draft_escalation':
        icon = 'mail';
        title = `Drafted an escalation (level ${a.escalation_level})`;
        detail = r.to ?? null;
        break;
      case 'submit_escalation':
        icon = 'trending-up';
        title = r.sent ? 'Escalated to a senior officer' : 'Escalation letter ready for you to send';
        detail = r.detail ?? r.portal_url ?? null;
        tone = r.sent ? 'success' : 'warning';
        break;
      case 'mark_resolved':
        icon = 'trophy';
        title = 'Marked as resolved';
        detail = a.evidence ?? null;
        tone = 'success';
        break;
      case 'request_user_status_update':
        icon = 'chatbubble-ellipses';
        title = 'Asked you whether it has been fixed';
        break;
      case 'list_submitted_complaints_needing_check':
      case 'run_complaint_check':
        continue;
    }
    items.push({ id: l.id, at: l.created_at, agent: AGENT_LABEL[l.agent_name] ?? l.agent_name, tool: l.tool_name, title, detail, tone, icon });
  }
  return items;
}
