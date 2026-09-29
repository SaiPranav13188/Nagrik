import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { config } from '../config.js';
import type { FormSelectors, StatusCheckSelectors } from '../db/types.js';
import { detectCaptcha, type CaptchaDetection } from './captcha.js';

/**
 * Standalone Playwright harness. Everything here is deterministic automation; the *decisions*
 * (whether to submit, how to react to CAPTCHAs, when to give up) are made by the agents that
 * call these functions as tools.
 *
 * Browser work is serialized through a single-slot queue: headless Chromium is memory heavy,
 * so on a small Render instance we run exactly one portal session at a time.
 */

let browserPromise: Promise<Browser> | null = null;
let chain: Promise<unknown> = Promise.resolve();
let queued = 0;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: config.headless, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    browserPromise.catch(() => (browserPromise = null));
  }
  const b = await browserPromise;
  if (!b.isConnected()) {
    browserPromise = null;
    return getBrowser();
  }
  return b;
}

export function browserQueueDepth() {
  return queued;
}

export function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  queued++;
  const run = chain.then(async () => {
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36 Nagrik/1.0',
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    try {
      return await fn(page);
    } finally {
      await context.close().catch(() => {});
    }
  });
  chain = run.catch(() => {}).finally(() => queued--);
  return run;
}

export async function closeBrowser() {
  if (browserPromise) (await browserPromise).close().catch(() => {});
  browserPromise = null;
}

// ───────────── page snapshots (so agents pass a small id instead of raw HTML) ─────────────

export interface PageSnapshot {
  id: string;
  url: string;
  title: string;
  html: string;
  text: string;
  /** Text of selectors captured while the page was still open. */
  selectorText: Record<string, string | null>;
  screenshotPath: string | null;
  createdAt: number;
}

const snapshots = new Map<string, PageSnapshot>();
const snapshotDir = path.resolve(config.localDataDir, 'snapshots');
fs.mkdirSync(snapshotDir, { recursive: true });

async function takeSnapshot(page: Page, selectors: string[] = [], screenshot = false): Promise<PageSnapshot> {
  const selectorText: Record<string, string | null> = {};
  for (const s of selectors) {
    selectorText[s] = await page
      .locator(s)
      .first()
      .innerText({ timeout: 1500 })
      .catch(() => null);
  }
  const snap: PageSnapshot = {
    id: randomUUID(),
    url: page.url(),
    title: await page.title().catch(() => ''),
    html: await page.content(),
    text: await page.locator('body').innerText({ timeout: 3000 }).catch(() => ''),
    selectorText,
    screenshotPath: null,
    createdAt: Date.now(),
  };
  if (screenshot) {
    snap.screenshotPath = path.join(snapshotDir, `${snap.id}.png`);
    await page.screenshot({ path: snap.screenshotPath, fullPage: true }).catch(() => (snap.screenshotPath = null));
  }
  snapshots.set(snap.id, snap);
  // Keep memory bounded.
  for (const [k, v] of snapshots) if (Date.now() - v.createdAt > 60 * 60 * 1000) snapshots.delete(k);
  return snap;
}

export function getSnapshot(id: string) {
  return snapshots.get(id) ?? null;
}

// ─────────────────────────────── form submission ───────────────────────────────

export type ComplaintFormData = Record<string, string | number | null | undefined>;

export type SubmitOutcome =
  | 'submitted'
  | 'blocked_by_captcha'
  | 'selector_mismatch'
  | 'portal_error'
  | 'navigation_failed';

export interface SubmitResult {
  outcome: SubmitOutcome;
  snapshotId: string | null;
  captcha: CaptchaDetection | null;
  filledFields: string[];
  missingFields: string[];
  message: string;
  pageTitle?: string;
  pageUrl?: string;
}

export async function fillAndSubmitForm(
  portalUrl: string,
  selectors: FormSelectors,
  data: ComplaintFormData & { photo_path?: string | null },
): Promise<SubmitResult> {
  return withPage(async (page) => {
    const filled: string[] = [];
    const missing: string[] = [];

    try {
      await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      return { outcome: 'navigation_failed', snapshotId: null, captcha: null, filledFields: [], missingFields: [], message: `Could not open portal: ${(e as Error).message}` };
    }

    // Guard 1: never touch a form that sits behind a CAPTCHA / OTP gate.
    const before = await takeSnapshot(page, [], true);
    const cap = detectCaptcha(before.html);
    if (cap.hasCaptcha) {
      return { outcome: 'blocked_by_captcha', snapshotId: before.id, captcha: cap, filledFields: [], missingFields: [], message: 'Human verification detected before filling the form.', pageTitle: before.title, pageUrl: before.url };
    }

    if (selectors.ready) {
      const ok = await page.locator(selectors.ready).first().waitFor({ state: 'attached', timeout: 10000 }).then(() => true, () => false);
      if (!ok) {
        return { outcome: 'selector_mismatch', snapshotId: before.id, captcha: null, filledFields: [], missingFields: [selectors.ready], message: `Form container ${selectors.ready} not found — portal HTML may have changed.`, pageTitle: before.title, pageUrl: before.url };
      }
    }

    for (const f of selectors.fields) {
      const raw = f.constant ?? (f.source === 'photo' ? data.photo_path : data[f.source]);
      if (raw === null || raw === undefined || raw === '') {
        if (f.required) missing.push(`${f.source} (no value)`);
        continue;
      }
      const value = String(raw);
      const loc = page.locator(f.selector).first();
      const exists = await loc.waitFor({ state: 'attached', timeout: 5000 }).then(() => true, () => false);
      if (!exists) {
        if (f.required) missing.push(`${f.source} → ${f.selector}`);
        continue;
      }
      try {
        switch (f.type) {
          case 'select':
            await loc.selectOption(f.valueMap?.[value] ?? value);
            break;
          case 'checkbox':
            if (value === 'true') await loc.check();
            break;
          case 'file':
            await loc.setInputFiles(value);
            break;
          case 'hidden':
            await loc.evaluate((el, v) => ((el as HTMLInputElement).value = v), value);
            break;
          default:
            await loc.fill(value);
        }
        filled.push(f.source);
      } catch (e) {
        if (f.required) missing.push(`${f.source} → ${f.selector} (${(e as Error).message.split('\n')[0]})`);
      }
    }

    if (missing.length) {
      const snap = await takeSnapshot(page, [], true);
      return { outcome: 'selector_mismatch', snapshotId: snap.id, captcha: null, filledFields: filled, missingFields: missing, message: 'Some required fields could not be filled. Not submitting a partial form.', pageTitle: snap.title, pageUrl: snap.url };
    }

    try {
      await Promise.all([
        page.waitForLoadState('domcontentloaded'),
        page.locator(selectors.submit).first().click({ timeout: 8000 }),
      ]);
    } catch (e) {
      const snap = await takeSnapshot(page, [], true);
      return { outcome: 'selector_mismatch', snapshotId: snap.id, captcha: null, filledFields: filled, missingFields: [selectors.submit], message: `Submit button not clickable: ${(e as Error).message.split('\n')[0]}`, pageTitle: snap.title, pageUrl: snap.url };
    }

    const c = selectors.confirmation;
    if (c.success_selector) {
      await page.locator(c.success_selector).first().waitFor({ timeout: 15000 }).catch(() => {});
    } else {
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }

    const after = await takeSnapshot(page, [c.success_selector, c.tracking_id_selector].filter(Boolean) as string[], true);
    // Guard 2: some portals only show a CAPTCHA after the first submit.
    const capAfter = detectCaptcha(after.html);
    const succeeded = c.success_selector ? after.selectorText[c.success_selector] != null : true;
    if (!succeeded && capAfter.hasCaptcha) {
      return { outcome: 'blocked_by_captcha', snapshotId: after.id, captcha: capAfter, filledFields: filled, missingFields: [], message: 'Portal presented a human-verification step after submit.', pageTitle: after.title, pageUrl: after.url };
    }
    if (!succeeded) {
      return { outcome: 'portal_error', snapshotId: after.id, captcha: null, filledFields: filled, missingFields: [], message: `No confirmation shown. Page says: ${after.text.slice(0, 300)}`, pageTitle: after.title, pageUrl: after.url };
    }
    return { outcome: 'submitted', snapshotId: after.id, captcha: null, filledFields: filled, missingFields: [], message: 'Form submitted and confirmation page loaded.', pageTitle: after.title, pageUrl: after.url };
  });
}

// ─────────────────────────────── confirmation parsing ───────────────────────────────

const GENERIC_ID_PATTERNS = [
  /(?:grievance|complaint|reference|ticket|tracking|docket|request)\s*(?:no\.?|number|id|#)\s*[:#\-–]?\s*([A-Z0-9][A-Z0-9/\-]{4,})/i,
  /\b([A-Z]{2,6}[/\-]\d{2,4}[/\-]\d{3,})\b/,
];

export function extractConfirmationDetails(snapshotId: string, conf?: FormSelectors['confirmation']) {
  const snap = getSnapshot(snapshotId);
  if (!snap) return { found: false, trackingId: null, message: 'Snapshot expired or unknown.' };
  const regex = conf?.tracking_id_regex ? new RegExp(conf.tracking_id_regex) : null;
  const candidates: Array<{ from: string; text: string }> = [];
  if (conf?.tracking_id_selector && snap.selectorText[conf.tracking_id_selector]) {
    candidates.push({ from: 'tracking_id_selector', text: snap.selectorText[conf.tracking_id_selector]! });
  }
  candidates.push({ from: 'page_text', text: snap.text });

  for (const c of candidates) {
    if (regex) {
      const m = c.text.match(regex);
      if (m) return { found: true, trackingId: m[0], source: `${c.from}+regex`, message: 'Tracking ID captured.' };
    }
    for (const re of GENERIC_ID_PATTERNS) {
      const m = c.text.match(re);
      if (m) return { found: true, trackingId: m[1], source: `${c.from}+generic`, message: 'Tracking ID captured (generic pattern — verify).' };
    }
  }
  return { found: false, trackingId: null, message: 'No tracking ID on the confirmation page.', pageExcerpt: snap.text.slice(0, 400) };
}

// ─────────────────────────────── status scraping ───────────────────────────────

export interface StatusScrape {
  ok: boolean;
  statusText: string | null;
  remarks: string | null;
  isResolved: boolean;
  isRejected: boolean;
  captcha: CaptchaDetection | null;
  rawSnapshot: string;
  message: string;
}

export async function scrapeStatus(url: string, sel: StatusCheckSelectors, trackingId: string): Promise<StatusScrape> {
  return withPage(async (page) => {
    try {
      await page.goto(url.replace('{tracking_id}', encodeURIComponent(trackingId)), { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      return { ok: false, statusText: null, remarks: null, isResolved: false, isRejected: false, captcha: null, rawSnapshot: '', message: `Status page unreachable: ${(e as Error).message}` };
    }
    const first = await page.content();
    const cap = detectCaptcha(first);
    if (cap.hasCaptcha) {
      return { ok: false, statusText: null, remarks: null, isResolved: false, isRejected: false, captcha: cap, rawSnapshot: first.slice(0, 4000), message: 'Status page requires human verification.' };
    }
    try {
      const input = page.locator(sel.tracking_input).first();
      if (await input.count()) {
        await input.fill(trackingId);
        await Promise.all([page.waitForLoadState('domcontentloaded'), page.locator(sel.submit).first().click()]);
      }
      await page.locator(sel.status_text).first().waitFor({ timeout: 10000 });
    } catch (e) {
      const text = await page.locator('body').innerText().catch(() => '');
      return { ok: false, statusText: null, remarks: null, isResolved: false, isRejected: false, captcha: null, rawSnapshot: text.slice(0, 4000), message: `Status selectors did not match: ${(e as Error).message.split('\n')[0]}` };
    }
    const statusText = (await page.locator(sel.status_text).first().innerText()).trim();
    const remarks = sel.remarks_text ? (await page.locator(sel.remarks_text).first().innerText().catch(() => ''))?.trim() || null : null;
    const lc = `${statusText} ${remarks ?? ''}`.toLowerCase();
    const body = await page.locator('body').innerText().catch(() => '');
    return {
      ok: true,
      statusText,
      remarks,
      isResolved: sel.resolved_keywords.some((k) => statusText.toLowerCase().includes(k)),
      isRejected: (sel.rejected_keywords ?? []).some((k) => lc.includes(k)),
      captcha: null,
      rawSnapshot: body.slice(0, 4000),
      message: 'Status scraped.',
    };
  });
}

/** Generic page probe used by agents to inspect an unmapped portal (read-only, never submits). */
export async function probePortal(url: string) {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const snap = await takeSnapshot(page);
    const forms = await page.$$eval('input, select, textarea', (els) =>
      els.slice(0, 40).map((e) => ({
        tag: e.tagName.toLowerCase(),
        type: (e as HTMLInputElement).type || null,
        id: e.id || null,
        name: (e as HTMLInputElement).name || null,
        placeholder: (e as HTMLInputElement).placeholder || null,
      })),
    );
    return { snapshotId: snap.id, title: snap.title, url: snap.url, captcha: detectCaptcha(snap.html), fields: forms, textExcerpt: snap.text.slice(0, 600) };
  });
}
