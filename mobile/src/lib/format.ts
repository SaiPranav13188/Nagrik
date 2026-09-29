import type { Ionicons } from '@expo/vector-icons';
import type { Colors } from '../theme';
import type { TKey } from './i18n';
import type { Complaint, IssueType } from './types';

type IconName = keyof typeof Ionicons.glyphMap;

export function relativeTime(iso: string, t: (k: TKey, p?: Record<string, string | number>) => string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return t('justNow');
  if (diff < 3600) return t('minutesAgo', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('hoursAgo', { n: Math.floor(diff / 3600) });
  if (diff < 86400 * 7) return t('daysAgo', { n: Math.floor(diff / 86400) });
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export const ISSUE_META: Record<IssueType, { icon: IconName; key: TKey; tint: string }> = {
  pothole: { icon: 'car-outline', key: 'issue_pothole', tint: '#B45309' },
  streetlight: { icon: 'bulb-outline', key: 'issue_streetlight', tint: '#CA8A04' },
  garbage: { icon: 'trash-outline', key: 'issue_garbage', tint: '#15803D' },
  water_leakage: { icon: 'water-outline', key: 'issue_water_leakage', tint: '#0369A1' },
  drainage: { icon: 'git-merge-outline', key: 'issue_drainage', tint: '#6D28D9' },
  other: { icon: 'flag-outline', key: 'issue_other', tint: '#475569' },
};

export function issueMeta(t: IssueType | null) {
  return ISSUE_META[t ?? 'other'];
}

export type StatusKey = Complaint['status'] | 'filing_soon';

export function displayStatus(c: Pick<Complaint, 'status' | 'submit_after'>): StatusKey {
  if (c.status === 'drafted' && c.submit_after && new Date(c.submit_after).getTime() > Date.now() - 5000) return 'filing_soon';
  return c.status;
}

export function statusStyle(s: StatusKey, c: Colors): { fg: string; bg: string; icon: IconName } {
  switch (s) {
    case 'analyzing':
      return { fg: c.info, bg: c.infoSoft, icon: 'sparkles' };
    case 'drafted':
      return { fg: c.info, bg: c.infoSoft, icon: 'document-text' };
    case 'filing_soon':
    case 'submitting':
      return { fg: c.primary, bg: c.primarySoft, icon: 'paper-plane' };
    case 'submitted':
      return { fg: c.primary, bg: c.primarySoft, icon: 'checkmark-done' };
    case 'submission_failed':
      return { fg: c.warning, bg: c.warningSoft, icon: 'hand-left' };
    case 'escalated':
      return { fg: c.danger, bg: c.dangerSoft, icon: 'trending-up' };
    case 'resolved':
      return { fg: c.success, bg: c.successSoft, icon: 'checkmark-circle' };
  }
}

export const IN_PROGRESS: Complaint['status'][] = ['analyzing', 'drafted', 'submitting'];

export function needsUser(c: Complaint) {
  if (c.viewer_role === 'supporter') return false;
  return c.status === 'submission_failed' || (c.status === 'drafted' && !c.submit_after);
}

export function shortAddress(a: string | null | undefined) {
  if (!a) return '';
  return a.split(',').slice(0, 3).join(',').trim();
}

export function normalizePhone(v: string) {
  return v.replace(/[\s()-]/g, '').replace(/^(\+91|0091|91(?=\d{10}$)|0(?=\d{10}$))/, '');
}
