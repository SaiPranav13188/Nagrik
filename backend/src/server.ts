import { config, productionSecretProblems, useGemini } from './config.js';
import { initRepo, repo } from './db/index.js';
import { recoverOnBoot, startCron } from './services/scheduler.js';
import { closeBrowser } from './automation/portal.js';
import { shutdownTracing } from './ai/tracing.js';
import { app } from './app.js';
import { loadSandboxState } from './sandboxPortal/router.js';
import { closeRedis, redisEnabled, waitForRedis } from './redis/connection.js';
import { closeFilingQueue } from './queues/filingQueue.js';
import { startFilingWorker } from './workers/filingWorker.js';

// Never run in production with missing or default secrets.
if (config.nodeEnv === 'production') {
  const problems = productionSecretProblems();
  if (problems.length) {
    console.error(`[startup] Refusing to start in production:\n  - ${problems.join('\n  - ')}\nSet long random values (e.g. openssl rand -hex 32).`);
    process.exit(1);
  }
}

await initRepo();
await loadSandboxState();
const server = app.listen(config.port, () => {
  console.log(`\n🏛️  Nagrik backend on ${config.publicBaseUrl}`);
  console.log(`   data=${repo.kind}  ai=${useGemini ? config.geminiModel : 'offline-planner'}  portals=${config.portalMode}`);
  console.log(`   admin console: ${config.publicBaseUrl}/admin   sandbox portal: ${config.publicBaseUrl}/sandbox-portal\n`);
});
let worker: ReturnType<typeof startFilingWorker> | null = null;
if (redisEnabled) {
  const ready = await waitForRedis(10_000);
  console.log(`[redis] ${ready ? 'connected' : 'not reachable yet (filing falls back to in-process until it is)'}; filing worker: ${config.filingWorker}`);
  if (config.filingWorker === 'inline') worker = startFilingWorker();
}
await recoverOnBoot();
startCron();

const shutdown = async () => {
  server.close();
  await worker?.close(); // lets a running filing job finish instead of killing it halfway
  await closeFilingQueue();
  await closeRedis();
  await closeBrowser();
  await shutdownTracing();
  if ('flush' in repo) (repo as { flush(): void }).flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
