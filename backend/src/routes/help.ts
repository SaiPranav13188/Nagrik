import { Router, type Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { repo } from '../db/index.js';
import { requireUser } from '../auth.js';
import { answerHelp } from '../services/help.js';
import { TOPIC_IDS } from '../services/helpAnswers.js';

/** In-app help assistant: see services/help.ts for how answers are chosen. */
export const helpRouter = Router();
helpRouter.use(requireUser);

const perUser = (limit: number, message: string) =>
  rateLimit({
    windowMs: 60 * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req as Request).userId ?? ipKeyGenerator(req.ip ?? 'unknown'),
    message: { error: message },
  });

const chatBody = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(1000) }))
    .min(1)
    .max(12)
    .refine((m) => m[m.length - 1].role === 'user', 'The last message must be from the user'),
  lang: z.enum(['en', 'te', 'hi']).default('en'),
  // A tapped suggestion names its topic, so it always gets the approved answer.
  intent: z.enum(['my_complaint', ...TOPIC_IDS]).optional(),
  complaintId: z.string().uuid().optional(),
});

helpRouter.post('/chat', perUser(40, "You've asked a lot of questions in the last hour. Please try again later, or email support."), async (req, res) => {
  const body = chatBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid request' });
  res.json(await answerHelp({ userId: req.userId, ...body.data }));
});

// 👍 / 👎 on an answer. Stored with the agent tool logs (agent_name "help") so wrong answers can be
// found and the fixed answers or help guide corrected.
const feedbackBody = z.object({
  question: z.string().max(1000),
  answer: z.string().max(4000),
  source: z.enum(['faq', 'status', 'ai', 'none']),
  topic: z.string().max(40).nullable().optional(),
  helpful: z.boolean(),
});

helpRouter.post('/feedback', perUser(60, 'Too many requests. Please try again later.'), async (req, res) => {
  const body = feedbackBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Invalid feedback' });
  const { helpful, answer, ...rest } = body.data;
  await repo.addToolLog({
    agent_name: 'help',
    complaint_id: null,
    tool_name: helpful ? 'feedback_helpful' : 'feedback_not_helpful',
    arguments: { ...rest, user_id: req.userId },
    result: { answer },
    duration_ms: null,
    error: null,
  });
  res.json({ ok: true });
});
