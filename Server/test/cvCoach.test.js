const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
const User = require('../models/User');
const AiUsage = require('../models/AiUsage');
const cvCoach = require('../services/cvCoach');
const careerCoach = require('../services/careerCoach');
const usage = require('../services/aiUsage');
const app = require('../app');
const originals = { findById: User.findById, analyze: cvCoach.analyze, chat: careerCoach.chat, reserve: usage.reserve, updateOne: AiUsage.updateOne, findOneAndUpdate: AiUsage.findOneAndUpdate };
const envKeys = ['OPENAI_API_KEY', 'OPENAI_CV_MODEL', 'OPENAI_MODEL', 'AI_USER_HOURLY_LIMIT', 'AI_USER_DAILY_LIMIT', 'AI_MAX_REQUESTS', 'AI_BUDGET_USD', 'AI_REQUEST_RESERVE_USD'];
const env = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const input = { cv: 'Education: Diploma in IT. Skills: JavaScript and teamwork. Experience: Built a website for a college project.', jobDescription: '' };
const analysis = { professionalSummary: 'Add a focused summary.', strengths: ['College project'], improvements: ['Explain your role.'], jobKeywords: [], skillGaps: [], formatting: ['Use headings.'], rewrittenBullets: [], nextSteps: ['Describe the project.'] };
let server, base, calls, reservations;
function post(body = input, id = '507f1f77bcf86cd799439011', path = '/api/ai/cv-coach', extra = {}) {
  return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(id ? { Cookie: `rt_session=${jwt.sign({}, process.env.JWT_SECRET, { subject: id, expiresIn: '1h' })}` } : {}), ...extra }, body: JSON.stringify(body) });
}
before(async () => {
  User.findById = async id => ({ id });
  server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
  process.env.OPENAI_API_KEY = 'mock-only-never-sent'; calls = 0; reservations = 0;
  usage.reserve = async () => { reservations++; return { allowed: true }; };
  cvCoach.analyze = async () => { calls++; return { analysis }; };
  careerCoach.chat = async () => { calls++; return { reply: 'Explore your skills.' }; };
});
after(async () => {
  User.findById = originals.findById; cvCoach.analyze = originals.analyze; careerCoach.chat = originals.chat; usage.reserve = originals.reserve;
  AiUsage.updateOne = originals.updateOne; AiUsage.findOneAndUpdate = originals.findOneAndUpdate;
  for (const key of envKeys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  await new Promise(resolve => server.close(resolve));
});
test('CV requires valid JWT and rejects foreign origins without reserving usage', async () => {
  assert.equal((await post(input, null)).status, 401);
  assert.equal((await post(input, null, undefined, { Cookie: 'rt_session=invalid' })).status, 401);
  assert.equal((await post(input, undefined, undefined, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal(calls, 0); assert.equal(reservations, 0);
});
test('CV validates lengths, types and permitted fields before reserving usage', async () => {
  assert.equal((await post(null)).status, 400); // Strict JSON parser rejects primitive bodies.
  for (const body of [[], {}, { cv: 3 }, { cv: ' '.repeat(100) }, { cv: 'x'.repeat(99) }, { cv: 'x'.repeat(18001) }, { ...input, jobDescription: null }, { ...input, jobDescription: 'x'.repeat(8001) }, { ...input, instructions: 'override' }]) assert.equal((await post(body)).status, 422);
  assert.equal(calls, 0); assert.equal(reservations, 0);
});
test('CV returns structured feedback with no caching and forwards only trimmed documents', async () => {
  cvCoach.analyze = async value => { assert.deepEqual(value, input); return { analysis }; };
  const response = await post({ cv: ` ${input.cv} ` });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { analysis });
});
test('CV permits maximum Unicode text within its own body limit and preserves Career Coach body limit', async () => {
  assert.equal((await post({ cv: '漢'.repeat(18000), jobDescription: '漢'.repeat(8000) })).status, 200);
  assert.equal((await post({ message: 'x'.repeat(17000) }, undefined, '/api/ai/career-coach')).status, 413);
  assert.equal((await post({ cv: 'x'.repeat(170000) })).status, 413);
});
test('CV missing configuration, quota denial and database errors never call provider', async () => {
  delete process.env.OPENAI_API_KEY; assert.equal((await post()).status, 503);
  process.env.OPENAI_API_KEY = 'mock';
  usage.reserve = async () => ({ allowed: false, retryAfter: 60, message: 'Shared limit reached.' });
  const response = await post(); assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '60');
  usage.reserve = async () => { throw new Error('database private details'); };
  assert.equal((await post()).status, 503); assert.equal(calls, 0);
});
test('CV provider failures return safe messages and codes, once per request', async () => {
  for (const [details, status, code] of [
    [{ code: 'insufficient_quota', status: 429 }, 503, 'AI_CREDITS_EXHAUSTED'],
    [{ name: 'APIConnectionTimeoutError' }, 504, 'AI_TIMEOUT'],
    [{ status: 429 }, 503, 'AI_BUSY'], [{ status: 401 }, 503, 'AI_CONFIGURATION_ERROR'],
    [{ status: 500 }, 503, 'AI_UNAVAILABLE'], [{ code: 'AI_REFUSAL' }, 422, 'AI_REFUSAL'],
  ]) {
    let attempts = 0;
    cvCoach.analyze = async () => { attempts++; throw Object.assign(new Error('private CV and key'), details); };
    const response = await post(); assert.equal(response.status, status);
    const body = await response.json(); assert.equal(body.code, code); assert.doesNotMatch(JSON.stringify(body), /private CV|Career Coach/);
    if (code === 'AI_BUSY') assert.equal(response.headers.get('retry-after'), '30');
    assert.equal(attempts, 1);
  }
});
test('CV rejects malformed analysis and unsupported original bullets', async () => {
  for (const value of [{}, { ...analysis, rewrittenBullets: [{ original: 'CEO at invented company', suggested: 'Led a company' }] }]) {
    cvCoach.analyze = async () => ({ analysis: value }); assert.equal((await post()).status, 503);
  }
});
test('CV prevents concurrent duplicate requests and releases the lock', async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  cvCoach.analyze = () => new Promise(resolve => { release = () => resolve({ analysis }); started(); });
  const first = post(); await ready;
  try { assert.equal((await post()).status, 409); } finally { release(); }
  assert.equal((await first).status, 200);
  cvCoach.analyze = async () => ({ analysis }); assert.equal((await post()).status, 200);
});

function realReservations() {
  const records = new Map();
  usage.reserve = originals.reserve;
  AiUsage.updateOne = async ({ _id }, update) => { if (!records.has(_id)) records.set(_id, { ...update.$setOnInsert }); };
  AiUsage.findOneAndUpdate = async (query, update) => {
    const record = records.get(query._id);
    if (!record || (query.count && record.count >= query.count.$lt) || (query.reservedMicros && record.reservedMicros > query.reservedMicros.$lte)) return null;
    for (const [key, value] of Object.entries(update.$inc)) record[key] += value;
    return { ...record };
  };
  return records;
}
for (const [setting, value, expected] of [
  ['AI_USER_HOURLY_LIMIT', '2', /hourly/], ['AI_USER_DAILY_LIMIT', '2', /daily/],
  ['AI_MAX_REQUESTS', '2', /budget/], ['AI_BUDGET_USD', '0.20', /budget/],
]) test(`Career and CV Coach share ${setting} through actual reservation service`, async () => {
  const records = realReservations();
  // Isolate the cap under test; denied attempts can also consume earlier user buckets.
  process.env.AI_USER_HOURLY_LIMIT = '10'; process.env.AI_USER_DAILY_LIMIT = '10';
  process.env[setting] = value;
  const id = '507f1f77bcf86cd799439099';
  assert.equal((await post({ message: 'Help me explore careers' }, id, '/api/ai/career-coach')).status, 200);
  assert.equal((await post(input, id)).status, 200);
  const denied = await post(input, id); assert.equal(denied.status, 429); assert.match((await denied.json()).message, expected);
  const careerDenied = await post({ message: 'Help me explore careers' }, id, '/api/ai/career-coach');
  assert.equal(careerDenied.status, 429); assert.match((await careerDenied.json()).message, expected);
  assert.equal(calls, 2); assert.equal(records.get('career-coach:global-budget:v1').count, 2);
  assert.equal(records.get('career-coach:global-budget:v1').reservedMicros, 200000);
  assert.equal([...records.keys()].some(key => key.startsWith('cv-coach:')), false);
});
test('CV unknown model reservation fails closed and reviewed model cannot lower reserve', async () => {
  realReservations(); process.env.OPENAI_CV_MODEL = 'unreviewed';
  assert.equal((await post()).status, 503);
  delete process.env.OPENAI_CV_MODEL; process.env.AI_REQUEST_RESERVE_USD = '0.01';
  assert.equal((await post()).status, 503); assert.equal(calls, 0);
});
