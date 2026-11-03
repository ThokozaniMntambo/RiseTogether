const express = require('express');
const { rateLimit } = require('express-rate-limit');
const live = require('../services/realtimeInterview');
const { diagnose, logFailure } = require('../services/realtimeDiagnostics');
const router = express.Router();
// Mounted after the existing interview router's JWT and no-store middleware.
router.post('/sessions', rateLimit({ windowMs: 60000, limit: 2, keyGenerator: req => String(req.user.id), standardHeaders: 'draft-8', legacyHeaders: false,
  message: { message: 'Please wait a minute before starting another voice interview.' } }), async (req, res, next) => {
  const { setup, sdp, voice = 'marin' } = req.body || {};
  if (!setup || typeof setup.jobTitle !== 'string' || setup.jobTitle.trim().length < 2 || setup.jobTitle.length > 120
    || (setup.company !== undefined && (typeof setup.company !== 'string' || setup.company.length > 120))
    || !['General', 'Technical', 'Behavioural'].includes(setup.interviewType)
    || !['marin', 'cedar'].includes(voice) || typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > 24000) {
    return res.status(422).json({ message: 'Provide valid interview details, voice and WebRTC offer.' });
  }
  try {
    const result = await live.create(String(req.user.id), { jobTitle: setup.jobTitle.trim(), company: (setup.company || '').trim(), interviewType: setup.interviewType }, sdp, voice);
    if (req.aborted || res.destroyed) { await live.stop(live.owned(result.id, String(req.user.id))); return; }
    res.json(result);
  } catch (e) { failure(e, res, next, 'create'); }
});
function failure(e, res, _next, operation) {
  logFailure(e, operation, 'route');
  const { status, retryAfter, ...body } = diagnose(e);
  if (retryAfter) res.set('Retry-After', String(retryAfter));
  res.status(status).json(body);
}
router.post('/sessions/:id/heartbeat', async (req, res, next) => {
  try { const s = live.owned(req.params.id, String(req.user.id)); await live.heartbeat(s); res.json({ ended: s.ended, reason: s.reason, failure: s.failure, oneMinuteWarning: Boolean(s.oneMinuteWarning), expiresAt: s.expiresAt }); }
  catch (e) { failure(e, res, next, 'heartbeat'); }
});
router.post('/sessions/:id/end', async (req, res, next) => {
  try { const s = live.owned(req.params.id, String(req.user.id)); await live.stop(s); res.json({ ended: true }); }
  catch (e) { failure(e, res, next, 'end'); }
});
router.post('/sessions/:id/feedback', async (req, res, next) => {
  try { res.json(await live.report(live.owned(req.params.id, String(req.user.id)))); }
  catch (e) { failure(e, res, next, 'feedback'); }
});
module.exports = router;
