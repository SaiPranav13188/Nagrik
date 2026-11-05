import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { filingQueue } from '../queues/filingQueue.js';

/**
 * Bull Board: a web dashboard of waiting, active, failed and completed filing jobs, at
 * /admin/queues. app.ts mounts it behind admin authentication — never expose it without.
 */
export function queueBoardRouter(basePath = '/admin/queues') {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(basePath);
  createBullBoard({ queues: [new BullMQAdapter(filingQueue(), { readOnlyMode: false })], serverAdapter });
  return serverAdapter.getRouter();
}
