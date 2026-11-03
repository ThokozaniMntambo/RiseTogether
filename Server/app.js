const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('./models/User');
const auth = require('./middleware/auth');

const app = express();
app.use(helmet());
const allowedOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin: allowedOrigin, credentials: true }));
// Larger pasted CVs are allowed only on this endpoint; retain existing API limits.
app.use('/api/ai/cv-coach', express.json({ limit: '160kb' }));
// Five Unicode answers plus the signed, generated question set.
app.use('/api/ai/interview-coach', express.json({ limit: '96kb' }));
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());
// Reject cross-origin browser mutations, including logout (CSRF protection).
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') && req.get('origin') !== allowedOrigin) {
    return res.status(403).json({ message: 'This origin is not allowed.' });
  }
  next();
});
app.get('/api/health', (_req, res) => res.json({ status: 'ok', database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Too many attempts. Please try again in 15 minutes.' } });
const emailRule = body('email').isString().trim().isEmail().isLength({ max: 254 }).withMessage('Enter a valid email address.').toLowerCase();
function validate(req, res, next) {
  const result = validationResult(req);
  if (!result.isEmpty()) return res.status(422).json({ message: 'Please check your details.', errors: result.array().map(e => ({ field: e.path, message: e.msg })) });
  next();
}
function publicUser(user) { return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt }; }
const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 });
function session(res, user, status) {
  const token = jwt.sign({}, process.env.JWT_SECRET, { subject: user.id, expiresIn: '7d', algorithm: 'HS256' });
  res.cookie('rt_session', token, cookieOptions()).status(status).json({ user: publicUser(user) });
}
app.post('/api/auth/register', limiter, [
  body('name').isString().trim().isLength({ min: 2, max: 80 }).withMessage('Name must be between 2 and 80 characters.'),
  emailRule,
  body('password').isString().isLength({ min: 8 }).withMessage('Password must contain at least 8 characters.').custom(value => Buffer.byteLength(value, 'utf8') <= 72).withMessage('Password must be at most 72 UTF-8 bytes.'),

], validate, async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    const user = await User.create({ name, email, password: await bcrypt.hash(password, 12) });
    session(res, user, 201);
  } catch (error) { next(error); }
});
app.post('/api/auth/login', limiter, [emailRule, body('password').isString().notEmpty().isLength({ max: 256 }).withMessage('Enter your password.')], validate, async (req, res, next) => {
  try {
    const user = await User.findOne({ email: req.body.email }).select('+password');
    if (!user || !(await bcrypt.compare(req.body.password, user.password))) return res.status(401).json({ message: 'Email or password is incorrect.' });
    session(res, user, 200);
  } catch (error) { next(error); }
});
app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
app.post('/api/auth/logout', (_req, res) => { const { maxAge, ...options } = cookieOptions(); res.clearCookie('rt_session', options).json({ message: 'Signed out.' }); });
app.use(['/api/ai/career-coach', '/api/career-coach'], require('./routes/careerCoach'));
app.use('/api/ai/cv-coach', require('./routes/cvCoach'));
app.use('/api/ai/interview-coach', require('./routes/interviewCoach'));
app.use('/api', (_req, res) => res.status(404).json({ message: 'Endpoint not found.' }));
app.use((error, _req, res, _next) => {
  if (error.code === 11000) return res.status(409).json({ message: 'An account with this email already exists.' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON body.' });
  if (error.type === 'entity.too.large') return res.status(413).json({ message: 'Request is too large.' });
  console.error('Request failed:', error.name);
  res.status(503).json({ message: 'The service is temporarily unavailable. Please try again.' });
});
module.exports = app;
