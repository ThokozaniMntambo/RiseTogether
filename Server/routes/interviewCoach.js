const express = require('express');
const jwt = require('jsonwebtoken');
const { createHmac } = require('node:crypto');
const auth = require('../middleware/auth');
const coach = require('../services/interviewCoach');
const aiUsage = require('../services/aiUsage');
const coachError = require('../services/coachError');
const router = express.Router();
router.use(auth);
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// A distinct derived signing key prevents interview tokens being used as login cookies.
const signingKey = () => createHmac('sha256', process.env.JWT_SECRET).update('risetogether:interview:v1').digest();
const permitted = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
function setupInput(value) {
  if (!permitted(value, ['jobTitle', 'company', 'interviewType']) || typeof value.jobTitle !== 'string' || value.jobTitle.trim().length < 2 || value.jobTitle.length > 120
    || (value.company !== undefined && (typeof value.company !== 'string' || value.company.length > 120))
    || !['Technical', 'Behavioural', 'General'].includes(value.interviewType)) return null;
  return { jobTitle: value.jobTitle.trim(), company: (value.company || '').trim(), interviewType: value.interviewType };
}
function validateQuestions(req, res, next) {
  const setup = setupInput(req.body);
  if (!setup) return res.status(422).json({ message: 'Enter a job title (2–120 characters), optional company (up to 120 characters) and a valid interview type.' });
  req.interviewInput = setup;
  next();
}
function validateEvaluation(req, res, next) {
  const data = req.body;
  if (!permitted(data, ['interviewToken', 'answers']) || typeof data.interviewToken !== 'string' || data.interviewToken.length > 16000
    || !Array.isArray(data.answers) || data.answers.length !== 5 || data.answers.some(answer => typeof answer !== 'string' || !answer.trim() || answer.length > 2000)) {
    return res.status(422).json({ message: 'Submit the interview token and exactly five nonempty answers of up to 2,000 characters each.' });
  }
  try {
    const payload = jwt.verify(data.interviewToken, signingKey(), { algorithms: ['HS256'], audience: 'interview-coach', issuer: 'RiseTogether' });
    if (payload.sub !== String(req.user.id) || !setupInput(payload.setup) || !coach.matchesQuestions({ questions: payload.questions })) throw new Error('Invalid interview');
    req.interviewInput = { ...payload.setup, questions: payload.questions, answers: data.answers.map(answer => answer.trim()) };
    next();
  } catch {
    return res.status(422).json({ code: 'INTERVIEW_EXPIRED', message: 'This interview is invalid or has expired. Start a new interview; existing answers remain visible on this page.' });
  }
}

const active = new Set();
function run(operation) {
  return async (req, res, next) => {
    if (!process.env.OPENAI_API_KEY?.trim()) return res.status(503).json({ message: 'Interview Coach is not configured yet. Please try again later.' });
    const userId = String(req.user.id);
    if (active.has(userId)) return res.status(409).json({ message: 'Your interview request is still being prepared. Please wait.' });
    active.add(userId);
    try {
      const quota = await aiUsage.reserve(userId, undefined, coach.model());
      if (!quota.allowed) {
        if (quota.retryAfter) res.set('Retry-After', String(quota.retryAfter));
        return res.status(429).json({ message: quota.message });
      }
      try {
        if (operation === 'questions') {
          const result = await coach.generateQuestions(req.interviewInput);
          if (!coach.matchesQuestions(result)) throw new Error('InvalidCoachResponse');
          const interviewToken = jwt.sign({ setup: req.interviewInput, questions: result.questions }, signingKey(), { subject: userId, audience: 'interview-coach', issuer: 'RiseTogether', expiresIn: '24h', algorithm: 'HS256' });
          return res.json({ questions: result.questions, interviewToken });
        }
        const result = await coach.evaluate(req.interviewInput);
        if (!coach.matchesEvaluation(result.evaluation)) throw new Error('InvalidCoachResponse');
        result.evaluation.overallScore = Math.round(result.evaluation.answers.reduce((sum, answer) => sum + answer.score, 0) / 5);
        // No MongoDB session or transcript writes; all interview content is transient.
        return res.json({ evaluation: result.evaluation });
      } catch (error) {
        const { status, retryAfter, ...failure } = coachError(error);
        failure.message = failure.code === 'AI_REFUSAL' ? 'Interview Coach could not process this content. Use a job-related interview topic.' : failure.message.replaceAll('Career Coach', 'Interview Coach');
        console.error('Interview Coach provider failed:', failure.code);
        if (retryAfter) res.set('Retry-After', String(retryAfter));
        return res.status(status).json(failure);
      }
    } catch (error) { next(error); }
    finally { active.delete(userId); }
  };
}
router.post('/questions', validateQuestions, run('questions'));
router.post('/evaluate', validateEvaluation, run('evaluate'));
router.use('/realtime', require('./realtimeInterview'));
module.exports = router;
