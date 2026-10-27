import { config, productionSecretProblems, useGemini } from './config.js';
import { initRepo, repo } from './db/index.js';
import { recoverOnBoot, startCron } from './services/scheduler.js';
import { closeBrowser } from './automation/portal.js';
import { shutdownTracing } from './ai/tracing.js';
import { app } from './app.js';
import { loadSandboxState } from './sandboxPortal/router.js';

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
await recoverOnBoot();
startCron();

const shutdown = async () => {
  server.close();
  await closeBrowser();
  await shutdownTracing();
  if ('flush' in repo) (repo as { flush(): void }).flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
