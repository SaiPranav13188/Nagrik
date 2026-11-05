# Redis Implementation Guide for Nagrik (+ Journi and Haathi)

Goal: make Nagrik reliable under real use. Complaint filing runs in the background with retries, never files twice, and the app replies instantly.

> **Read this first.** I have not seen your repo's file layout, so paths like `src/...` and function names like `fileOnPortal()` are placeholders. Map them to your real files. The code uses ES modules (`import`). If your backend uses CommonJS (`require`), convert the imports.

---

## 1. What you are building

```
Mobile app ──POST /complaints/:id/submit──► Express API
                                              │ 1. validate + rate-limit (Redis)
                                              │ 2. enqueue job   (Redis / BullMQ)
                                              ▼
                                   replies 202 "queued" immediately

                         Worker process (separate from the API)
                              │ takes job from Redis
                              │ runs Playwright filing
                              │ success → Supabase status = filed
                              │ failure → retry with backoff (5 tries)
                              ▼
                     all retries failed → status = needs_attention
```

Four jobs for Redis in Nagrik:

| # | Feature | Why |
|---|---|---|
| 1 | **Job queue (BullMQ)** | Playwright is slow and flaky; do not block the request |
| 2 | **Idempotency** | A retry or double-tap must never file the same complaint twice |
| 3 | **Cache** | Reuse "location → office" lookups and save Nominatim and Gemini calls |
| 4 | **Rate limiting** | Stop one user from flooding the agents |

Supabase stays your source of truth for complaints. Redis only holds temporary, fast data.

---

## 2. Prerequisites

- Node.js 18+
- Docker (for local Redis)
- Redis 6.2 or newer (7 is best). BullMQ requires it.

### Run Redis locally

```bash
docker run -d --name nagrik-redis -p 6379:6379 redis:7-alpine redis-server --appendonly yes
docker exec -it nagrik-redis redis-cli ping    # should print PONG
```

### Redis for production (pick one)

- **Render Key Value** (Redis-compatible), since you already use Render. Easiest if the API is on Render.
- **Redis Cloud free tier**, which gives a small free database.
- **Upstash**: works, but BullMQ polls Redis constantly and Upstash charges per command. Check the current free-tier limits before choosing it for a queue.

Whichever you choose, you end up with a URL like `redis://...` or `rediss://...` (TLS). Put it in `REDIS_URL`.

---

## 3. Install

```bash
npm install bullmq ioredis
```

Add to `.env` (and to your Render and GitHub secrets, never to git):

```env
REDIS_URL=redis://localhost:6379
FILING_CONCURRENCY=2
FILING_MAX_ATTEMPTS=5
```

---

## 4. Shared Redis connection

`src/redis/connection.js`

```js
import IORedis from "ioredis";

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is not set");
}

// BullMQ workers REQUIRE maxRetriesPerRequest: null
export const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

connection.on("error", (err) => {
  console.error("[redis] connection error:", err.message);
});
```

One connection object is fine to share across the queue, rate limiter and cache in the API process. The worker process creates its own by importing the same file.

---

## 5. The filing queue

`src/queues/filingQueue.js`

```js
import { Queue } from "bullmq";
import { connection } from "../redis/connection.js";

export const FILING_QUEUE = "complaint-filing";

export const filingQueue = new Queue(FILING_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: Number(process.env.FILING_MAX_ATTEMPTS ?? 5),
    backoff: { type: "exponential", delay: 10_000 }, // 10s, 20s, 40s, 80s...
    removeOnComplete: { age: 3600, count: 1000 },    // keep 1h of finished jobs
    removeOnFail: { age: 7 * 24 * 3600 },            // keep failures 7 days for debugging
  },
});

/**
 * Enqueue a filing job. The jobId makes it idempotent:
 * calling this twice for the same complaint does NOT create a second job
 * while the first still exists in Redis.
 * (BullMQ custom job IDs must not contain ":", so use "-".)
 */
export async function enqueueFiling(complaintId) {
  return filingQueue.add(
    "file-complaint",
    { complaintId },
    { jobId: `file-${complaintId}` }
  );
}
```

---

## 6. The worker (separate process)

`src/workers/filingWorker.js`

```js
import { Worker, UnrecoverableError } from "bullmq";
import { connection } from "../redis/connection.js";
import { FILING_QUEUE } from "../queues/filingQueue.js";

// ---- Replace these with your real functions ----
import {
  getComplaint,          // (id) => row from Supabase
  setComplaintStatus,    // (id, status, extra?) => updates Supabase
  fileOnPortal,          // (complaint) => runs Playwright, returns { reference }
} from "../services/complaints.js";
// -------------------------------------------------

const worker = new Worker(
  FILING_QUEUE,
  async (job) => {
    const { complaintId } = job.data;
    const complaint = await getComplaint(complaintId);

    if (!complaint) throw new UnrecoverableError(`Complaint ${complaintId} not found`);

    // Idempotency guard #1: already filed? Do nothing.
    if (complaint.status === "filed") {
      return { alreadyFiled: true, reference: complaint.portal_reference };
    }

    await setComplaintStatus(complaintId, "filing", { attempts: job.attemptsMade + 1 });

    try {
      const result = await fileOnPortal(complaint); // your Playwright code
      await setComplaintStatus(complaintId, "filed", {
        portal_reference: result.reference,
        last_error: null,
      });
      return result;
    } catch (err) {
      // Permanent problems: retrying will never help. Fail immediately.
      if (err.code === "VALIDATION_ERROR" || err.code === "PORTAL_REJECTED") {
        throw new UnrecoverableError(err.message);
      }
      // Temporary problems (timeout, portal down): let BullMQ retry.
      await setComplaintStatus(complaintId, "retrying", { last_error: err.message });
      throw err;
    }
  },
  {
    connection,
    // Playwright is heavy (a whole browser). Keep this low.
    concurrency: Number(process.env.FILING_CONCURRENCY ?? 2),
  }
);

worker.on("failed", async (job, err) => {
  if (!job) return;
  const exhausted =
    err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
  if (exhausted) {
    await setComplaintStatus(job.data.complaintId, "needs_attention", {
      last_error: err.message,
    });
    console.error(`[worker] complaint ${job.data.complaintId} needs attention:`, err.message);
  }
});

worker.on("completed", (job) => {
  console.log(`[worker] filed complaint ${job.data.complaintId}`);
});

// Shut down cleanly so a job is not killed halfway on deploy
async function shutdown() {
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

Run it as its own process:

```bash
node src/workers/filingWorker.js
```

### Honest limit: "at least once", not "exactly once"

If the worker crashes after Playwright submits on the portal but before it writes `filed` to Supabase, the retry could file a second time. Reduce the risk:

- Put your own complaint ID in the text you submit (for example "Ref: NAG-1234") and have the worker check whether the portal already shows it before filing again.
- Write a `submitting` status before the final submit click, and treat `submitting` plus a crash as "verify first".

Being able to explain this limit is a strong interview answer.

---

## 7. Database columns (Supabase)

Add to your `complaints` table if missing:

```sql
alter table complaints
  add column if not exists status text not null default 'draft',
  add column if not exists portal_reference text,
  add column if not exists attempts int not null default 0,
  add column if not exists last_error text;
-- statuses: draft | queued | filing | retrying | filed | needs_attention
```

---

## 8. API changes

`src/routes/complaints.js` (adapt to your router)

```js
import { enqueueFiling } from "../queues/filingQueue.js";
import { filingQueue } from "../queues/filingQueue.js";
import { rateLimit } from "../middleware/rateLimit.js";

router.post(
  "/complaints/:id/submit",
  rateLimit({ windowSec: 60, max: 5, keyFn: (req) => req.user.id }),
  async (req, res) => {
    const { id } = req.params;
    const complaint = await getComplaint(id);

    if (!complaint) return res.status(404).json({ error: "not_found" });
    if (complaint.status === "filed") {
      return res.status(200).json({ status: "filed", reference: complaint.portal_reference });
    }

    await setComplaintStatus(id, "queued");
    await enqueueFiling(id);                       // safe to call twice (same jobId)
    return res.status(202).json({ status: "queued" });
  }
);

// Optional: live status the app can poll
router.get("/complaints/:id/status", async (req, res) => {
  const complaint = await getComplaint(req.params.id);
  if (!complaint) return res.status(404).json({ error: "not_found" });
  const job = await filingQueue.getJob(`file-${req.params.id}`);
  res.json({
    status: complaint.status,
    reference: complaint.portal_reference,
    attempts: job ? job.attemptsMade : complaint.attempts,
    lastError: complaint.last_error,
  });
});
```

Keep the existing "confirm-before-submit" step (and admin review for uncertain office mappings) before this endpoint. The queue changes *how* filing runs, not *whether* it is allowed.

---

## 9. Cache helper (graceful, never breaks the app)

`src/redis/cache.js`

```js
import { connection as redis } from "./connection.js";

/**
 * Return cached value, or run loader() and cache the result.
 * If Redis is down, it just calls loader(), so the app keeps working.
 */
export async function getOrSet(key, ttlSec, loader) {
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit);
  } catch (e) {
    console.warn("[cache] read failed:", e.message);
  }

  const value = await loader();

  if (value != null) {
    try {
      await redis.set(key, JSON.stringify(value), "EX", ttlSec);
    } catch (e) {
      console.warn("[cache] write failed:", e.message);
    }
  }
  return value;
}
```

### Use it for the office lookup

```js
import { getOrSet } from "../redis/cache.js";

export async function findOffice({ category, lat, lng }) {
  // 3 decimals is roughly 110 m, so nearby complaints share one result
  const key = `office:${category}:${lat.toFixed(3)}:${lng.toFixed(3)}`;

  return getOrSet(key, 24 * 3600, async () => {
    const result = await runJurisdictionAgent({ category, lat, lng }); // your existing agent
    // IMPORTANT: do not cache uncertain results. Those go to admin review.
    return result.confidence === "high" ? result : null;
  });
}
```

Rule: never cache anything that needs human review or that depends on one user's private data.

---

## 10. Rate limiting

`src/middleware/rateLimit.js`

```js
import { connection as redis } from "../redis/connection.js";

export function rateLimit({ windowSec, max, keyFn }) {
  return async (req, res, next) => {
    try {
      const key = `rl:${req.path}:${keyFn(req)}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSec);

      if (count > max) {
        const ttl = await redis.ttl(key);
        res.set("Retry-After", String(Math.max(ttl, 1)));
        return res.status(429).json({ error: "too_many_requests" });
      }
    } catch (e) {
      console.warn("[ratelimit] redis error, allowing request:", e.message); // fail open
    }
    next();
  };
}
```

Use it on any endpoint that triggers Gemini or Playwright: for example 5 submissions a minute and 20 AI calls a minute per user.

---

## 11. Docker Compose (API + worker + Redis)

`docker-compose.yml`

```yaml
services:
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    ports: ["6379:6379"]
    volumes: ["redis-data:/data"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  api:
    build: .
    command: ["node", "src/server.js"]
    env_file: .env
    environment:
      REDIS_URL: redis://redis:6379
    depends_on:
      redis: { condition: service_healthy }
    ports: ["3000:3000"]

  worker:
    build: .
    command: ["node", "src/workers/filingWorker.js"]
    env_file: .env
    environment:
      REDIS_URL: redis://redis:6379
    depends_on:
      redis: { condition: service_healthy }

volumes:
  redis-data:
```

Notes:
- The API and worker use the same image and a different command. Your existing Dockerfile does not change.
- The worker needs Playwright's browsers. Use the official `mcr.microsoft.com/playwright` base image (match the version to your `playwright` package), or install browsers in the image.
- On Render, run the worker as a **Background Worker** service and the API as a **Web Service**. Both get the same `REDIS_URL`.

---

## 12. Tests

Install: `npm i -D vitest` (or use whatever you already use).

`tests/filingQueue.test.js`

```js
import { describe, it, expect, afterAll } from "vitest";
import { filingQueue, enqueueFiling } from "../src/queues/filingQueue.js";

afterAll(async () => {
  await filingQueue.obliterate({ force: true });
  await filingQueue.close();
});

describe("filing queue", () => {
  it("does not create a duplicate job for the same complaint", async () => {
    await enqueueFiling("abc123");
    await enqueueFiling("abc123");
    const jobs = await filingQueue.getJobs(["waiting", "delayed", "active"]);
    expect(jobs.filter((j) => j.data.complaintId === "abc123")).toHaveLength(1);
  });
});
```

Also test:
- Worker returns `alreadyFiled` when the complaint is already `filed`.
- A `PORTAL_REJECTED` error is not retried (status becomes `needs_attention`).
- A timeout error is retried and finally succeeds (mock `fileOnPortal` to fail twice).
- The rate limiter returns 429 on the 6th request in a minute.

### CI (GitHub Actions)

Add a Redis service to your existing test job:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7
        ports: ["6379:6379"]
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10
    env:
      REDIS_URL: redis://localhost:6379
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm test
```

---

## 13. Watching the queue (optional but impressive)

Bull Board gives you a web dashboard of waiting, active, failed and completed jobs.

```bash
npm install @bull-board/api @bull-board/express
```

```js
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter.js";
import { ExpressAdapter } from "@bull-board/express";
import { filingQueue } from "./queues/filingQueue.js";

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");
createBullBoard({ queues: [new BullMQAdapter(filingQueue)], serverAdapter });
app.use("/admin/queues", requireAdmin, serverAdapter.getRouter()); // protect it!
```

Never expose this without admin authentication.

---

## 14. Other projects

### Journi: replace the in-memory TTL cache

Your weather, currency and places data change slowly. Swap the in-memory cache for the same `getOrSet` helper:

```js
const weather = await getOrSet(`weather:${lat.toFixed(2)}:${lng.toFixed(2)}:${date}`, 1800, () =>
  fetchOpenMeteo(lat, lng, date)           // 30 min
);
const rate = await getOrSet(`fx:${from}:${to}`, 6 * 3600, () => fetchFx(from, to)); // 6 h
```

Benefits: survives restarts and is shared if you run more than one server instance. Add `rateLimit` to the itinerary-generation endpoint to cap Gemini cost per user.

### Haathi: answer cache

Cache by a hash of the normalised question and language:

```js
import crypto from "node:crypto";
const key = "qa:" + crypto.createHash("sha256").update(`${lang}|${question.trim().toLowerCase()}`).digest("hex");
```

Only cache answers that passed your citation check, and set a TTL (for example 24 hours) so updated scheme documents are not served stale. Clear the `qa:*` keys when you re-ingest PDFs.

---

## 15. Common mistakes

| Mistake | Fix |
|---|---|
| Worker crashes with `maxRetriesPerRequest` error | Set `maxRetriesPerRequest: null` on the connection |
| Custom jobId contains `:` | Use `-`, for example `file-123` |
| Running the worker inside the API process | Run it separately, so a Playwright crash does not take down the API |
| `concurrency` too high | Each job is a browser. Start at 1–2 |
| Retrying errors that can never succeed | Throw `UnrecoverableError` for validation and rejected-by-portal cases |
| Caching uncertain or private results | Cache only high-confidence, non-personal data |
| Using Redis as the main database | Complaints live in Supabase. Redis is disposable |
| No TTLs on keys | Always set an expiry on cache and rate-limit keys |
| Secrets in git | `REDIS_URL` goes in environment variables only |

---

## 16. Order of work (about 2–3 days)

1. **Day 1:** local Redis, `connection.js`, queue, worker, and the new submit route. Test one successful filing.
2. **Day 1:** force a failure and confirm retries, then `needs_attention`.
3. **Day 2:** idempotency tests, rate limiting, the `getOrSet` cache for office lookup.
4. **Day 2:** Docker Compose, CI with the Redis service, deploy API plus worker with a hosted Redis.
5. **Day 3:** Bull Board, a README section with the architecture diagram, and measurements.

### Measure before and after (this is what goes on your resume)

- Submit endpoint response time (p95) before and after.
- Percentage of complaints filed successfully on first try vs after retries.
- Duplicate filings (target: 0).
- Gemini and Nominatim calls saved by the cache (hit rate).

---

## 17. Resume line (use only after it works)

> Moved complaint filing to a **BullMQ + Redis** queue with exponential-backoff retries and idempotency keys, cutting submit latency from X s to under Y ms and eliminating duplicate filings.

Fill in X and Y from your own measurements. Do not publish numbers you did not measure.

## 18. Interview questions to prepare

1. Why a queue instead of calling Playwright inside the request?
2. What happens if the worker crashes mid-filing? (At-least-once delivery, and your mitigation.)
3. How do you stop the same complaint being filed twice?
4. Why `UnrecoverableError` for some failures?
5. Why is Redis not your main database? What happens if it restarts?
6. What do you cache, what do you refuse to cache, and why?
7. How does exponential backoff help when the portal is down?
8. Why run the worker as a separate process?
