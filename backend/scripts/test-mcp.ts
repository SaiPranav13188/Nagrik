/**
 * End-to-end test of the Nagrik MCP server: starts the backend (offline, sandbox), spawns the MCP
 * server over stdio like Claude Desktop would, and drives all 7 tools.
 *
 *   npm run test:mcp
 */
import { TEST_PORT } from './test-env.js';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { app } from '../src/app.js';
import { repo } from '../src/db/index.js';
import { issueLocalToken } from '../src/auth.js';
import { closeBrowser } from '../src/automation/portal.js';

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '✅' : '❌'} ${name}`, !ok && detail !== undefined ? JSON.stringify(detail).slice(0, 500) : '');
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = app.listen(TEST_PORT);
const DEVICE = 'mcp-test-device-0001';

function png(w = 48, h = 48) {
  const raw = randomBytes((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const client = new Client({ name: 'nagrik-mcp-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', 'src/mcp/server.ts'],
  env: { ...(process.env as Record<string, string>), NAGRIK_API_URL: `http://127.0.0.1:${TEST_PORT}`, NAGRIK_DEVICE_ID: DEVICE, NAGRIK_TOKEN: '', NAGRIK_MCP_ALLOW_LIVE: '' },
  stderr: 'pipe',
});

async function call(name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = r.content[0]?.text ?? '';
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain-text error */
  }
  return { error: !!r.isError, data, text };
}

async function waitStatus(id: string, pred: (s: any) => boolean, ms = 90_000) {
  const start = Date.now();
  let s: any;
  while (Date.now() - start < ms) {
    s = (await call('get_complaint_status', { complaint_id: id })).data;
    if (pred(s)) return s;
    await sleep(1000);
  }
  return s;
}

async function main() {
  // The portal needs the citizen's name and mobile (set in the app's profile screen).
  await repo.upsertProfile({ id: issueLocalToken(DEVICE).userId, full_name: 'MCP Tester', phone: '9876543210' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  const expected = ['draft_complaint', 'escalate_complaint', 'find_jurisdiction', 'get_complaint_status', 'list_my_complaints', 'report_issue', 'submit_complaint'];
  check('exposes exactly the 7 tools', JSON.stringify(tools) === JSON.stringify(expected), tools);

  const rep = await call('report_issue', { photo_base64: png().toString('base64'), photo_mime_type: 'image/png', address: 'RTC bus stand, Wanaparthy', note: 'big pothole near bus stand, bikes falling' });
  const id = rep.data?.complaint_id;
  check('report_issue → complaint created', !rep.error && rep.data?.result === 'created' && rep.data?.issue_type === 'pothole', rep.data);

  let s = await waitStatus(id, (x) => x?.status === 'drafted' && !!x?.draft);
  check('pipeline drafts it and waits (MCP complaints are never auto-filed)', s?.status === 'drafted' && s?.portal?.sandbox === true, s);

  const j = await call('find_jurisdiction', { complaint_id: id });
  check('find_jurisdiction → verified sandbox department', !j.error && /Engineering Section \(Roads\)/.test(j.data?.department ?? '') && j.data?.portal?.verified, j.data);

  const d = await call('draft_complaint', { complaint_id: id });
  check('draft_complaint → letter with subject and text', !d.error && d.data?.draft?.text?.length > 50, d.data);

  const preview = await call('submit_complaint', { complaint_id: id });
  s = (await call('get_complaint_status', { complaint_id: id })).data;
  check('submit_complaint without confirm → preview only, nothing filed', preview.data?.preview === true && s.status === 'drafted', preview.data);

  const sub = await call('submit_complaint', { complaint_id: id, confirm: true });
  s = await waitStatus(id, (x) => ['submitted', 'submission_failed'].includes(x?.status));
  check('submit_complaint with confirm → filed on the sandbox portal with a tracking ID', !sub.error && s?.status === 'submitted' && /^WNP\//.test(s?.tracking_id ?? ''), s);

  const list = await call('list_my_complaints', {});
  check('list_my_complaints includes it', Array.isArray(list.data) && list.data.some((c: any) => c.complaint_id === id), list.data);

  const escPreview = await call('escalate_complaint', { complaint_id: id });
  check('escalate_complaint without confirm → preview of the next level only', escPreview.data?.preview === true && escPreview.data?.would_escalate_to?.level === 1, escPreview.data);
  const esc = await call('escalate_complaint', { complaint_id: id, confirm: true });
  check('escalate_complaint with confirm → escalated to level 1 (sandbox inbox)', !esc.error && esc.data?.status === 'escalated' && esc.data?.escalation_level === 1, esc.data);

  // A complaint routed to the REAL Wanaparthy portal: the MCP server must refuse in sandbox mode.
  const live = (await repo.findJurisdictions({ city: 'Wanaparthy', state: 'Telangana', issueType: 'garbage', sandbox: false, reviewStatuses: ['approved'] }))[0];
  const real = await repo.createComplaint({
    user_id: issueLocalToken(DEVICE).userId,
    issue_type: 'garbage',
    description: 'Garbage dumped near the market.',
    address: 'Market road, Wanaparthy',
    status: 'drafted',
    jurisdiction_portal_id: live.id,
    jurisdiction_department: live.department_name,
    draft_subject: 'Garbage near market',
    draft_text: 'To The Sanitation Section. Garbage has been dumped near the market for a week. Please clear it.',
  });
  const liveSub = await call('submit_complaint', { complaint_id: real.id, confirm: true });
  check('submit_complaint on a REAL portal → refused (sandbox mode)', liveSub.error && /REAL government portal/.test(liveSub.text), liveSub.text);
  await repo.updateComplaint(real.id, { status: 'submitted', submitted_at: new Date(Date.now() - 30 * 86_400_000).toISOString() });
  const liveEsc = await call('escalate_complaint', { complaint_id: real.id, confirm: true });
  check('escalate_complaint to a REAL office → refused (sandbox mode)', liveEsc.error && /REAL government office/.test(liveEsc.text), liveEsc.text);
  check('nothing was escalated on the real complaint', (await repo.listEscalations(real.id)).length === 0);
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    await client.close().catch(() => {});
    await closeBrowser();
    server.close();
    console.log(failures ? `\n${failures} MCP check(s) failed` : '\nAll MCP checks passed');
    process.exit(failures ? 1 : 0);
  });
