import express from 'express';
import { validTimeZone } from '../reports/index.js';
import { loopContext, MAX_WINDOW } from './context.js';
import { SYSTEM, userMessage } from './prompt.js';
import { apiErrorMessage } from './claude.js';

const READ = 'This needs an account that may read glucose entries, treatments and device status.';
const MAX_QUESTION = 2000;
const MAX_ANSWER = 40000;
// The first answer and up to 10 follow-up questions with their answers.
const MAX_TURNS = 21;

/**
 * The conversation after the first request, as Messages API turns, or a
 * reason it is not valid: Claude's answers and the person's questions in
 * turn, starting with an answer and ending with a question.
 */
export function followUps (conversation) {
  if (conversation == null) return { messages: [] };
  if (!Array.isArray(conversation) || conversation.length % 2 || conversation.length > MAX_TURNS - 1) {
    return { error: `A conversation is an answer and a question in turn, at most ${MAX_TURNS} entries, ending with a question` };
  }
  const messages = [];
  for (const [i, turn] of conversation.entries()) {
    const role = i % 2 ? 'user' : 'assistant';
    const limit = role === 'user' ? MAX_QUESTION : MAX_ANSWER;
    if (turn?.role !== role || typeof turn.text !== 'string' || !turn.text.trim() || turn.text.length > limit) {
      return { error: `Entry ${i + 1} of the conversation must be ${role === 'user' ? 'a question' : 'an answer'} of at most ${limit} characters` };
    }
    messages.push({ role, content: turn.text });
  }
  return { messages };
}

/**
 * POST /api/analysis { from, to, tz, question?, conversation? }: Claude's
 * review of what the loop did from `from` to `to` (ms), streamed as Markdown
 * text; with a conversation ([{ role: 'assistant', text }, { role: 'user',
 * text }, ...] after the first request), its answer to the last question.
 * For people signed in to the web page only: each answer costs API credit.
 */
export function createAnalysisRoutes (ctx) {
  const router = express.Router();
  const { auth, pool } = ctx;
  const read = [
    auth.require('api:entries:read', READ),
    auth.require('api:treatments:read', READ),
    auth.require('api:devicestatus:read', READ),
  ];
  const fail = (res, status, message) => res.status(status).json({ status, message });

  router.post('/', read, express.json({ limit: '16kb' }), async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const a = await auth.fromRequest(req);
      if (!a.user) return fail(res, a.attempted && !a.failed ? 403 : 401, 'Reviews are for people signed in to the web page');
      const reviewer = ctx.reviewer;
      if (!reviewer?.available) return fail(res, 503, 'Reviews need an Anthropic API key: an admin can add one on the Access page');

      const { from, to, tz = 'UTC', question = '', conversation } = req.body || {};
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return fail(res, 400, 'from and to must be times in ms, from before to');
      if (to - from > MAX_WINDOW) return fail(res, 400, `Select at most ${MAX_WINDOW / 3600000} hours`);
      if (typeof tz !== 'string' || !validTimeZone(tz)) return fail(res, 400, `Unknown time zone ${tz}`);
      if (typeof question !== 'string' || question.length > MAX_QUESTION) return fail(res, 400, `The note must be text of at most ${MAX_QUESTION} characters`);

      const later = followUps(conversation);
      if (later.error) return fail(res, 400, later.error);

      const records = await loopContext(pool, { from, to, timeZone: tz });
      if (!records.readings.some((r) => r.date >= from && r.date < to)) return fail(res, 422, 'There are no glucose readings in the selected time');

      const abort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      res.status(200).type('text/markdown; charset=utf-8');
      res.flushHeaders();
      try {
        const result = await reviewer.review({
          system: SYSTEM,
          // The records again, as in the first request, so they come from the cache.
          messages: [{ role: 'user', content: userMessage(records, { question }) }, ...later.messages],
          onText: (text) => res.write(text),
          signal: abort.signal,
        });
        if (result.stopReason === 'refusal') res.write('\n\n*Claude declined to review this period.*');
        else if (result.stopReason === 'max_tokens') res.write('\n\n*The review was cut off at its length limit.*');
      } catch (err) {
        if (abort.signal.aborted) return;
        console.error('analysis:', err);
        res.write(`\n\n**The review failed:** ${apiErrorMessage(err)}`);
      }
      res.end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
