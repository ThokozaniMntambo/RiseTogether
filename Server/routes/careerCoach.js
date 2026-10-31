const express = require('express');
const { rateLimit } = require('express-rate-limit');
const auth = require('../middleware/auth');
const CareerSession = require('../models/CareerSession');
const coach = require('../services/careerCoach');
const aiUsage = require('../services/aiUsage');
const coachError = require('../services/coachError');
const router = express.Router();
router.use(auth);
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const fields = ['education', 'interests', 'skills', 'experience', 'goals', 'constraints'];
function validateProfile(req, res, next) {
  const data = req.body;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(422).json({ message: 'Enter your career profile.' });
  const profile = {};
  for (const field of fields) {
    const value = data[field] ?? (field === 'constraints' ? '' : undefined);
    if (typeof value !== 'string' || value.trim().length > 1000 || (field !== 'constraints' && value.trim().length < 2)) {
      return res.status(422).json({ message: `Please enter ${field} using ${field === 'constraints' ? 'up to' : '2 to'} 1000 characters.` });
    }
    profile[field] = value.trim();
  }
  req.careerProfile = profile;
  next();
}

function validateRequest(req, res, next) {
  const data = req.body;
  if (data && typeof data === 'object' && Object.keys(data).some(key => /system|developer|instruction|prompt/i.test(key) || ['messages', 'role'].includes(key))) {
    return res.status(422).json({ message: 'Coaching instructions are managed by the server. Send only your message and recent conversation history, or career profile fields.' });
  }
  // Preserve the existing profile form while supporting conversational requests.
  if (!data || (!Object.hasOwn(data, 'message') && !Object.hasOwn(data, 'history'))) return validateProfile(req, res, next);
  if (Object.keys(data).some(key => !['message', 'history'].includes(key))) {
    return res.status(422).json({ message: 'Conversation requests accept only message and history fields.' });
  }
  if (typeof data.message !== 'string' || !data.message.trim() || data.message.length > 2000) {
    return res.status(422).json({ message: 'Enter a message between 1 and 2000 characters.' });
  }
  const history = data.history === undefined ? [] : data.history;
  if (!Array.isArray(history) || history.length > 10) {
    return res.status(422).json({ message: 'History must contain at most 10 recent messages.' });
  }
  const cleanHistory = [];
  let characters = data.message.length;
  for (const item of history) {
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['role', 'content'].includes(key)) || !['user', 'assistant'].includes(item.role)
      || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 2000) {
      return res.status(422).json({ message: 'Each history entry must have a user or assistant role and content between 1 and 2000 characters.' });
    }
    characters += item.content.length;
    cleanHistory.push({ role: item.role, content: item.content.trim() });
  }
  if (characters > 10000) return res.status(422).json({ message: 'Message and history must total at most 10000 characters.' });
  req.careerConversation = { message: data.message.trim(), history: cleanHistory };
  next();
}

router.get('/sessions', async (req, res, next) => {
  try {
    const sessions = await CareerSession.find({ user: req.user.id }).sort({ createdAt: -1 }).limit(10).select('-user -__v').lean();
    res.json({ sessions });
  } catch (error) { next(error); }
});

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, keyGenerator: req => String(req.user.id), standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'You have reached the coaching limit. Please try again in an hour.' } });
const active = new Set();
router.post(['/', '/sessions'], validateRequest, limiter, async (req, res, next) => {
  if (!process.env.OPENAI_API_KEY?.trim()) return res.status(503).json({ message: 'Career Coach is not configured yet. Please try again later.' });
  const userId = String(req.user.id);
  if (active.has(userId)) return res.status(409).json({ message: 'Your guidance is still being prepared. Please wait.' });
  active.add(userId);
  try {
    const quota = await aiUsage.reserve(userId);
    if (!quota.allowed) {
      if (quota.retryAfter) res.set('Retry-After', String(quota.retryAfter));
      return res.status(429).json({ message: quota.message });
    }
    let result;
    try {
      if (req.careerConversation) {
        const { reply } = await coach.chat(req.careerConversation);
        if (typeof reply !== 'string' || !reply.trim()) throw new Error('InvalidCoachResponse');
        return res.json({ reply });
      }
      result = await coach.generate(req.careerProfile);
      if (!coach.matches(result.guidance)) throw new Error('InvalidCoachResponse');
    } catch (error) {
      const { status, retryAfter, ...failure } = coachError(error);
      console.error('Career Coach provider failed:', failure.code);
      if (retryAfter) res.set('Retry-After', String(retryAfter));
      return res.status(status).json(failure);
    }
    const session = await CareerSession.create({ user: req.user.id, profile: req.careerProfile, ...result });
    res.status(201).json({ session: { _id: session.id, profile: session.profile, guidance: session.guidance, model: session.model, createdAt: session.createdAt } });
  } catch (error) { next(error); }
  finally { active.delete(userId); }
});

module.exports = router;
