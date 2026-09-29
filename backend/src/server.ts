import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, useGemini, useSupabase } from './config.js';
import { initRepo, repo } from './db/index.js';
import { complaintsRouter } from './routes/complaints.js';
import { authRouter, meRouter } from './routes/me.js';
import { adminRouter, jobsRouter } from './routes/admin.js';
import { sandboxPortalRouter } from './sandboxPortal/router.js';
import { uploadsDir } from './services/storage.js';
import { queueStats, recoverOnBoot, startCron } from './services/scheduler.js';
import { browserQueueDepth, closeBrowser } from './automation/portal.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors());
// Photos arrive base64-encoded on the analyze route; everything else stays small.
const jsonSmall = express.json({ limit: '1mb' });
const jsonPhoto = express.json({ limit: '15mb' });
app.use((req, res, next) => (req.path === '/complaints/analyze' || req.path === '/complaints/transcribe' ? jsonPhoto : jsonSmall)(req, res, next));
app.use(express.urlencoded({ extended: false }));

// One line per request in the Render logs, so failures are easy to trace.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path !== "/health") console.log(`${req.method} ${req.originalUrl.split("?")[0]} → ${res.statusCode} (${Date.now() - start} ms)`);
  });
  res.on('close', () => {
    if (!res.writableFinished) console.warn(`${req.method} ${req.originalUrl.split("?")[0]} → connection closed by client after ${Date.now() - start} ms`);
  });
  next();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'nagrik-backend',
    time: new Date().toISOString(),
    data: repo.kind,
    auth: useSupabase ? 'supabase' : 'local',
    ai: useGemini ? `gemini (${config.geminiModel})` : 'offline-planner',
    portal_mode: config.portalMode,
    queues: { ...queueStats(), browser: browserQueueDepth() },
  });
});

app.use('/uploads', express.static(uploadsDir, { maxAge: '7d', fallthrough: false }));
app.use('/auth', authRouter);
app.use('/me', meRouter);
app.use('/complaints', complaintsRouter);
app.use('/jobs', jobsRouter);
app.use('/admin', adminRouter);
app.use('/sandbox-portal', sandboxPortalRouter);

// Landing page — Supabase's "Site URL" points here, so a tapped email link lands somewhere useful.
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nagrik</title><style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F5F7FA;color:#0B1220;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border:1px solid #E2E8F0;border-radius:20px;padding:32px 24px;max-width:380px;margin:16px;text-align:center}
.logo{width:64px;height:64px;border-radius:20px;background:#0F766E;color:#fff;font-size:30px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}
h1{font-size:22px;margin:0 0 8px}p{color:#475569;line-height:1.5;margin:8px 0}.te{color:#64748B;font-size:14px}</style></head>
<body><div class="card"><div class="logo">✓</div><h1>Almost there</h1>
<p>Go back to the <b>Nagrik app</b> and type the <b>code</b> from your email to sign in.</p>
<p class="te">నాగరిక్ యాప్‌కు తిరిగి వెళ్ళి, ఇమెయిల్‌లోని కోడ్‌ను టైప్ చేయండి.<br>नागरिक ऐप में वापस जाएँ और ईमेल में आया कोड डालें।</p></div></body></html>`);
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err: Error & { status?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Photo is too large (max 10 MB).' });
  console.error('[error]', err);
  res.status(err.status ?? 500).json({ error: 'Something went wrong on our side. Please try again.' });
});

await initRepo();
const server = app.listen(config.port, () => {
  console.log(`\n🏛️  Nagrik backend on ${config.publicBaseUrl}`);
  console.log(`   data=${repo.kind}  ai=${useGemini ? config.geminiModel : 'offline-planner'}  portals=${config.portalMode}`);
  console.log(`   admin console: ${config.publicBaseUrl}/admin   sandbox portal: ${config.publicBaseUrl}/sandbox-portal\n`);
});
await recoverOnBoot();
startCron();

const shutdown = async () => {
  server.close();
  await closeBrowser();
  if ('flush' in repo) (repo as { flush(): void }).flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
