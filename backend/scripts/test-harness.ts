/**
 * Standalone Playwright harness test against the sandbox portal (build-order step 1).
 * Verifies: form fill + submit, tracking-ID capture, status scrape, and CAPTCHA fallback detection.
 *
 *   npm run test:harness
 *   npm run test:harness -- --url https://some-portal/form   (read-only probe of a real portal)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { sandboxPortalRouter, sandboxState } from '../src/sandboxPortal/router.js';
import { SANDBOX_FORM_SELECTORS, SANDBOX_STATUS_SELECTORS } from '../src/db/seed.js';
import { closeBrowser, extractConfirmationDetails, fillAndSubmitForm, probePortal, scrapeStatus } from '../src/automation/portal.js';

const probeIdx = process.argv.indexOf('--url');
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '✅' : '❌'} ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  if (!ok) failures++;
};

async function main() {
  if (probeIdx > -1) {
    const r = await probePortal(process.argv[probeIdx + 1]);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const app = express();
  app.use('/sandbox-portal', sandboxPortalRouter);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/sandbox-portal`;

  // 1x1 PNG
  const photo = path.join(os.tmpdir(), 'nagrik-harness.png');
  fs.writeFileSync(photo, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

  const data = {
    citizen_name: 'Harness Test',
    phone: '9876543210',
    email: 'test@example.org',
    issue_type: 'pothole',
    subject: 'Deep pothole near bus stand',
    description: 'A deep pothole approximately 1 m wide on the main road near the RTC bus stand is causing accidents.',
    address: 'Main Road, near RTC Bus Stand, Wanaparthy, Telangana 509103',
    latitude: '16.3623',
    longitude: '78.0622',
    photo_path: photo,
  };

  sandboxState.setCaptcha(false);
  const r = await fillAndSubmitForm(base, SANDBOX_FORM_SELECTORS, data);
  check('form submitted', r.outcome === 'submitted', { outcome: r.outcome, missing: r.missingFields, msg: r.message });
  check('all mapped fields filled', r.filledFields.length === SANDBOX_FORM_SELECTORS.fields.length, r.filledFields);

  const conf = extractConfirmationDetails(r.snapshotId!, SANDBOX_FORM_SELECTORS.confirmation);
  check('tracking ID captured', conf.found && /^WNP\/\d{4}\/\d{6}$/.test(conf.trackingId ?? ''), conf);

  const s1 = await scrapeStatus(`${base}/track`, SANDBOX_STATUS_SELECTORS, conf.trackingId!);
  check('status scraped = Registered', s1.ok && s1.statusText === 'Registered' && !s1.isResolved, { status: s1.statusText });

  sandboxState.setStatus(conf.trackingId!, 'Resolved', 'Pothole patched with bituminous mix.');
  const s2 = await scrapeStatus(`${base}/track`, SANDBOX_STATUS_SELECTORS, conf.trackingId!);
  check('resolution detected', s2.ok && s2.isResolved, { status: s2.statusText, remarks: s2.remarks });

  sandboxState.setCaptcha(true);
  const r3 = await fillAndSubmitForm(base, SANDBOX_FORM_SELECTORS, data);
  check('CAPTCHA detected → no submission attempted', r3.outcome === 'blocked_by_captcha' && r3.filledFields.length === 0, r3.captcha);
  sandboxState.setCaptcha(false);

  const broken = { ...SANDBOX_FORM_SELECTORS, fields: SANDBOX_FORM_SELECTORS.fields.map((f) => (f.source === 'description' ? { ...f, selector: '#desc-renamed' } : f)) };
  const r4 = await fillAndSubmitForm(base, broken, data);
  check('broken selector → refuses partial submit', r4.outcome === 'selector_mismatch', r4.missingFields);

  server.close();
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    await closeBrowser();
    console.log(failures ? `\n${failures} check(s) failed` : '\nAll harness checks passed');
    process.exit(failures ? 1 : 0);
  });
