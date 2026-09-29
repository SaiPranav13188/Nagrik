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
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

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
