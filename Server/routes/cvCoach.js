const express = require('express');
const auth = require('../middleware/auth');
const coach = require('../services/cvCoach');
const aiUsage = require('../services/aiUsage');
const coachError = require('../services/coachError');
const router = express.Router();
router.use(auth);
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

function validate(req, res, next) {
  const data = req.body;
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['cv', 'jobDescription'].includes(key))) {
    return res.status(422).json({ message: 'Send only CV text and an optional job description.' });
  }
  if (typeof data.cv !== 'string' || data.cv.trim().length < 100 || data.cv.length > 18000) {
    return res.status(422).json({ message: 'Paste your CV using 100 to 18,000 characters.' });
  }
  const jobDescription = data.jobDescription === undefined ? '' : data.jobDescription;
  if (typeof jobDescription !== 'string' || jobDescription.length > 8000) {
    return res.status(422).json({ message: 'The optional job description must be text with at most 8,000 characters.' });
  }
  req.cvInput = { cv: data.cv.trim(), jobDescription: jobDescription.trim() };
  next();
}

const active = new Set();
router.post('/', validate, async (req, res, next) => {
  if (!process.env.OPENAI_API_KEY?.trim()) return res.status(503).json({ message: 'CV Coach is not configured yet. Please try again later.' });
  const userId = String(req.user.id);
  if (active.has(userId)) return res.status(409).json({ message: 'Your CV analysis is still being prepared. Please wait.' });
  active.add(userId);
  try {
    const quota = await aiUsage.reserve(userId, undefined, coach.model());
    if (!quota.allowed) {
      if (quota.retryAfter) res.set('Retry-After', String(quota.retryAfter));
      return res.status(429).json({ message: quota.message });
    }
    try {
      const result = await coach.analyze(req.cvInput);
      if (!coach.matches(result.analysis) || result.analysis.rewrittenBullets.some(item => !req.cvInput.cv.includes(item.original))) throw new Error('InvalidCoachResponse');
      // Deliberately no CV/session model: documents and feedback are not persisted.
      return res.json({ analysis: result.analysis });
    } catch (error) {
      const { status, retryAfter, ...failure } = coachError(error);
      failure.message = failure.code === 'AI_REFUSAL'
        ? 'CV Coach could not analyze this text. Please provide CV content about your education, skills and experience.'
        : failure.message.replaceAll('Career Coach', 'CV Coach');
      console.error('CV Coach provider failed:', failure.code);
      if (retryAfter) res.set('Retry-After', String(retryAfter));
      return res.status(status).json(failure);
    }
  } catch (error) { next(error); }
  finally { active.delete(userId); }
});
module.exports = router;
