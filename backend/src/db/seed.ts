import { config } from '../config.js';
import type { EscalationStep, FormSelectors, IssueType, Jurisdiction, StatusCheckSelectors } from './types.js';

/**
 * Admin-maintained, trusted jurisdiction mappings for Wanaparthy (PIN 509103), Telangana.
 *
 * Sources (verified 2026-09):
 *  - https://wanaparthymunicipality.telangana.gov.in/pages/grievance-redressal
 *    -> grievance form https://municipalservices.in/complaint_form.php?id=078 (mobile OTP gate)
 *  - https://wanaparthymunicipality.telangana.gov.in/pages/commissioner-contact
 *    -> commissioner.wnpmplty@gmail.com
 *  - https://cdma.telangana.gov.in/Grievance_Redressal (state Municipal Administration)
 *
 * Two copies exist of each mapping: a LIVE row (real portal) and a SANDBOX row pointing at the
 * bundled mock portal, so the full auto-submit -> tracking ID -> status scrape -> escalation loop
 * is testable without spamming a real government office. PORTAL_MODE selects which set is used.
 */

const LIVE_PORTAL = 'https://municipalservices.in/complaint_form.php?id=078';
const SOURCES = [
  'https://wanaparthymunicipality.telangana.gov.in/pages/grievance-redressal',
  'https://wanaparthymunicipality.telangana.gov.in/pages/commissioner-contact',
  'https://cdma.telangana.gov.in/Grievance_Redressal',
];

const DEPARTMENTS: Record<IssueType, { dept: string; notes: string }> = {
  pothole: {
    dept: 'Wanaparthy Municipality – Engineering Section (Roads)',
    notes:
      'Municipal roads and internal colony roads. National/State highways passing through town (e.g. NH-44 approach roads) belong to R&B / NHAI; mention the road name so the Engineering Section can forward if needed.',
  },
  streetlight: {
    dept: 'Wanaparthy Municipality – Engineering Section (Street Lighting)',
    notes:
      'Non-working street lights, damaged poles and lamp timers. Snapped live wires or transformer faults are a TGSPDCL matter (toll-free 1912) – say so explicitly in the complaint if the photo shows exposed wires.',
  },
  garbage: {
    dept: 'Wanaparthy Municipality – Public Health & Sanitation Section',
    notes: 'Garbage dumps, missed door-to-door collection, overflowing bins, dead animals. Handled by the Sanitary Inspector of the ward.',
  },
  water_leakage: {
    dept: 'Wanaparthy Municipality – Water Supply Section (Engineering)',
    notes:
      'Pipeline bursts, leaking public taps and contaminated supply inside municipal limits. Mission Bhagiratha bulk mains are maintained by TGDWSCL; the Water Supply Section forwards those.',
  },
  drainage: {
    dept: 'Wanaparthy Municipality – Public Health & Sanitation Section (Drains)',
    notes: 'Blocked or overflowing drains, open manholes, sewage on roads. Open manholes are a safety hazard – mark as urgent.',
  },
  other: {
    dept: "Wanaparthy Municipality – Commissioner's Office (General Grievances)",
    notes: 'Anything not covered above (encroachments, stray animals, illegal hoardings, public toilets). The office routes it internally.',
  },
};

const PORTAL_REQUIREMENTS =
  'Portal format: Subject (max 100 chars), Description (max 1500 chars, plain text, no markdown), exact location with landmark, ward if known. Write in formal English.';

const LIVE_ESCALATION: EscalationStep[] = [
  {
    level: 1,
    title: 'Municipal Commissioner, Wanaparthy Municipality',
    channel: 'email',
    contact: 'commissioner.wnpmplty@gmail.com',
    verified: true,
  },
  {
    level: 2,
    title: 'Commissioner & Director of Municipal Administration (CDMA), Telangana',
    channel: 'portal',
    contact: 'https://cdma.telangana.gov.in/Grievance_Redressal',
    verified: true,
  },
  {
    level: 3,
    title: 'District Collector, Wanaparthy (Prajavani)',
    channel: 'portal',
    // Prajavani/CPGRAMS link published on https://wanaparthy.telangana.gov.in/ (checked 2026-09-29).
    // Portal channel: the agent prepares the letter, the citizen submits it.
    contact: 'http://cpgrams.ts.nic.in/',
    verified: true,
  },
];

export function sandboxPortalUrl() {
  return `${config.publicBaseUrl}/sandbox-portal`;
}

export const SANDBOX_FORM_SELECTORS: FormSelectors = {
  version: 1,
  verified_at: '2026-09-29',
  ready: '#grievanceForm',
  fields: [
    { source: 'citizen_name', selector: '#citizenName', type: 'text', required: true },
    { source: 'phone', selector: '#mobile', type: 'text', required: true },
    { source: 'email', selector: '#email', type: 'text' },
    {
      source: 'issue_type',
      selector: '#category',
      type: 'select',
      required: true,
      valueMap: {
        pothole: 'ROADS',
        streetlight: 'STREET_LIGHTS',
        garbage: 'SANITATION',
        water_leakage: 'WATER_SUPPLY',
        drainage: 'DRAINAGE',
        other: 'OTHERS',
      },
    },
    { source: 'subject', selector: '#subject', type: 'text', required: true },
    { source: 'description', selector: '#description', type: 'textarea', required: true },
    { source: 'address', selector: '#location', type: 'textarea', required: true },
    { source: 'latitude', selector: '#lat', type: 'hidden' },
    { source: 'longitude', selector: '#lng', type: 'hidden' },
    { source: 'photo', selector: '#photo', type: 'file' },
    { source: 'declaration', selector: '#declaration', type: 'checkbox', constant: 'true', required: true },
  ],
  submit: '#submitBtn',
  confirmation: {
    success_selector: '.ack-success',
    tracking_id_selector: '#grievanceNo',
    tracking_id_regex: 'WNP/\\d{4}/\\d{6}',
  },
};

export const SANDBOX_STATUS_SELECTORS: StatusCheckSelectors = {
  tracking_input: '#trackNo',
  submit: '#trackBtn',
  status_text: '#currentStatus',
  remarks_text: '#remarks',
  resolved_keywords: ['resolved', 'closed', 'disposed', 'work completed'],
  rejected_keywords: ['rejected', 'not pertaining'],
};

const ISSUE_ORDER: IssueType[] = ['pothole', 'streetlight', 'garbage', 'water_leakage', 'drainage', 'other'];

// Stable ids so the SQL seed and the local store agree.
const id = (sandbox: boolean, i: number) =>
  `${sandbox ? '5a0d' : '1a0e'}0000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;

export function buildSeedJurisdictions(): Jurisdiction[] {
  const created = '2026-09-29T00:00:00.000Z';
  const rows: Jurisdiction[] = [];
  ISSUE_ORDER.forEach((issue, i) => {
    const { dept, notes } = DEPARTMENTS[issue];
    rows.push({
      id: id(false, i),
      city: 'Wanaparthy',
      state: 'Telangana',
      issue_type: issue,
      department_name: dept,
      portal_url: LIVE_PORTAL,
      // The live portal gates the form behind a mobile OTP, so there are no automatable selectors.
      form_selectors: null,
      status_check_url_template: null,
      status_check_selectors: null,
      escalation_contact: LIVE_ESCALATION,
      requires_captcha: true,
      notes: `${notes} ${PORTAL_REQUIREMENTS} Live portal requires mobile-number OTP verification before the form appears; citizens can also WhatsApp the municipality on +91 90002 53342.`,
      review_status: 'approved',
      is_sandbox: false,
      source_urls: SOURCES,
      proposed_by: 'admin-seed',
      reviewed_at: created,
      review_comment: 'Seeded and verified by admin',
      created_at: created,
    });
    rows.push({
      id: id(true, i),
      city: 'Wanaparthy',
      state: 'Telangana',
      issue_type: issue,
      department_name: dept,
      portal_url: sandboxPortalUrl(),
      form_selectors: SANDBOX_FORM_SELECTORS,
      status_check_url_template: `${sandboxPortalUrl()}/track`,
      status_check_selectors: SANDBOX_STATUS_SELECTORS,
      escalation_contact: [
        {
          level: 1,
          title: 'Municipal Commissioner, Wanaparthy (test)',
          channel: 'email',
          contact: 'commissioner@sandbox.nagrik.local',
          verified: true,
        },
        { ...LIVE_ESCALATION[1], contact: `${sandboxPortalUrl()}/cdma`, title: 'CDMA Telangana (test)' },
      ],
      requires_captcha: false,
      notes: `${notes} ${PORTAL_REQUIREMENTS} SANDBOX mirror of the Wanaparthy grievance form for end-to-end testing.`,
      review_status: 'approved',
      is_sandbox: true,
      source_urls: SOURCES,
      proposed_by: 'admin-seed',
      reviewed_at: created,
      review_comment: 'Sandbox portal – selectors verified by scripts/test-harness.ts',
      created_at: created,
    });
  });
  return rows;
}
