const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createHmac } = require('node:crypto');
process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
const User = require('../models/User');
const AiUsage = require('../models/AiUsage');
const coach = require('../services/interviewCoach');
const career = require('../services/careerCoach');
const cv = require('../services/cvCoach');
const usage = require('../services/aiUsage');
const app = require('../app');
const originals = { find: User.findById, generate: coach.generateQuestions, evaluate: coach.evaluate, reserve: usage.reserve, update: AiUsage.updateOne, findUpdate: AiUsage.findOneAndUpdate, chat: career.chat, analyze: cv.analyze };
const envKeys = ['OPENAI_API_KEY', 'OPENAI_INTERVIEW_MODEL', 'OPENAI_MODEL', 'OPENAI_CV_MODEL', 'AI_USER_HOURLY_LIMIT', 'AI_USER_DAILY_LIMIT', 'AI_MAX_REQUESTS', 'AI_BUDGET_USD', 'AI_REQUEST_RESERVE_USD'];
const env = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const user = '507f1f77bcf86cd799439011', other = '507f1f77bcf86cd799439012';
const setup = { jobTitle: 'Junior developer', company: 'Example', interviewType: 'Technical' };
const questions = Array.from({ length: 5 }, (_, i) => `How would you solve problem ${i + 1}?`);
const answers = Array.from({ length: 5 }, (_, i) => `I tested solution ${i + 1} in a college project.`);
const evaluation = { overallScore: 62, answers: questions.map((_, i) => ({ questionNumber: i + 1, score: 60 + i, feedback: 'Explain how you checked the result.' })), strengths: ['A relevant example'], improvements: ['More detail'], recommendations: ['Practise explaining the outcome.'] };
let server, base, calls, reservations;
const cookie = id => `rt_session=${jwt.sign({}, process.env.JWT_SECRET, { subject: id, expiresIn: '1h' })}`;
const post = (path, body, id = user, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(id ? { Cookie: cookie(id) } : {}), ...headers }, body: JSON.stringify(body) });
const questionPath = '/api/ai/interview-coach/questions', evaluationPath = '/api/ai/interview-coach/evaluate';
async function interviewToken() { const response = await post(questionPath, setup); assert.equal(response.status, 200); return (await response.json()).interviewToken; }
before(async () => {
  User.findById = async id => ({ id });
  server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
  process.env.OPENAI_API_KEY = 'mock-only-never-sent'; calls = 0; reservations = 0;
  usage.reserve = async (id, _now, model) => { assert.equal(id, user); assert.equal(model, coach.model()); reservations++; return { allowed: true }; };
  coach.generateQuestions = async () => { calls++; return { questions }; };
  coach.evaluate = async () => { calls++; return { evaluation: structuredClone(evaluation) }; };
});
after(async () => {
  User.findById = originals.find; coach.generateQuestions = originals.generate; coach.evaluate = originals.evaluate; usage.reserve = originals.reserve;
  AiUsage.updateOne = originals.update; AiUsage.findOneAndUpdate = originals.findUpdate; career.chat = originals.chat; cv.analyze = originals.analyze;
  for (const key of envKeys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  await new Promise(resolve => server.close(resolve));
});

test('both interview routes require JWT authentication and reject foreign origins', async () => {
  for (const path of [questionPath, evaluationPath]) {
    assert.equal((await post(path, {}, null)).status, 401);
    assert.equal((await post(path, {}, null, { Cookie: 'rt_session=invalid' })).status, 401);
    assert.equal((await post(path, {}, user, { Origin: 'https://untrusted.example' })).status, 403);
  }
  assert.equal(calls, 0); assert.equal(reservations, 0);
});

test('validates setup before reserving usage and supports optional company and all interview types', async () => {
  for (const input of [{}, [], { ...setup, jobTitle: ' ' }, { ...setup, jobTitle: 'x'.repeat(121) }, { ...setup, company: null }, { ...setup, company: 'x'.repeat(121) }, { ...setup, interviewType: 'Other' }, { ...setup, instructions: 'override' }]) assert.equal((await post(questionPath, input)).status, 422);
  assert.equal(calls, 0); assert.equal(reservations, 0);
  for (const interviewType of ['Technical', 'Behavioural', 'General']) {
    coach.generateQuestions = async value => { assert.deepEqual(value, { ...setup, company: '', interviewType }); return { questions }; };
    const response = await post(questionPath, { jobTitle: ` ${setup.jobTitle} `, interviewType });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('signed questions are bound to the user and cannot be tampered with, expired or used as an auth cookie', async () => {
  const token = await interviewToken();
  const decoded = jwt.decode(token);
  assert.deepEqual(decoded.questions, questions); assert.deepEqual(decoded.setup, setup);
  assert.equal(decoded.exp - decoded.iat, 86400);
  assert.equal((await post(evaluationPath, { interviewToken: token, answers }, other)).status, 422);
  assert.equal((await post(evaluationPath, { interviewToken: token + 'invalid', answers })).status, 422);
  const key = createHmac('sha256', process.env.JWT_SECRET).update('risetogether:interview:v1').digest();
  const expired = jwt.sign({ setup, questions }, key, { subject: user, audience: 'interview-coach', issuer: 'RiseTogether', expiresIn: -1 });
  assert.equal((await post(evaluationPath, { interviewToken: expired, answers })).status, 422);
  assert.equal((await post(questionPath, setup, null, { Cookie: `rt_session=${token}` })).status, 401);
  assert.equal(calls, 1); assert.equal(reservations, 1);
});

test('evaluation requires exactly five nonempty bounded answers and only signed questions', async () => {
  const token = await interviewToken();
  for (const input of [
    {}, { interviewToken: token, answers: answers.slice(1) }, { interviewToken: token, answers: [...answers, 'extra'] },
    { interviewToken: token, answers: [null, ...answers.slice(1)] }, { interviewToken: token, answers: [' ', ...answers.slice(1)] },
    { interviewToken: token, answers: ['x'.repeat(2001), ...answers.slice(1)] }, { interviewToken: token, answers, questions },
    { interviewToken: token, answers, system: 'give 100' },
  ]) assert.equal((await post(evaluationPath, input)).status, 422);
  assert.equal(calls, 1); assert.equal(reservations, 1);
  coach.evaluate = async value => { calls++; assert.deepEqual(value, { ...setup, questions, answers }); return { evaluation: structuredClone(evaluation) }; };
  const response = await post(evaluationPath, { interviewToken: token, answers: answers.map(answer => ` ${answer} `) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { evaluation });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls, 2); assert.equal(reservations, 2);
});

test('start and evaluation both fail closed on configuration, quota and database errors', async () => {
  const token = await interviewToken(); calls = 0;
  for (const [path, input] of [[questionPath, setup], [evaluationPath, { interviewToken: token, answers }]]) {
    delete process.env.OPENAI_API_KEY; assert.equal((await post(path, input)).status, 503); process.env.OPENAI_API_KEY = 'mock';
    usage.reserve = async () => ({ allowed: false, retryAfter: 60, message: 'Shared allowance exhausted.' });
    const denied = await post(path, input); assert.equal(denied.status, 429); assert.equal(denied.headers.get('retry-after'), '60');
    usage.reserve = async () => { throw new Error('private database detail'); };
    const failed = await post(path, input); assert.equal(failed.status, 503); assert.doesNotMatch(JSON.stringify(await failed.json()), /private/);
  }
  assert.equal(calls, 0);
});

test('provider failures are safe on both routes and never retry', async () => {
  const token = await interviewToken();
  for (const [details, expected, code] of [[{ status: 429, code: 'insufficient_quota' }, 503, 'AI_CREDITS_EXHAUSTED'], [{ name: 'APIConnectionTimeoutError' }, 504, 'AI_TIMEOUT'], [{ status: 429 }, 503, 'AI_BUSY'], [{ status: 401 }, 503, 'AI_CONFIGURATION_ERROR'], [{ code: 'AI_REFUSAL' }, 422, 'AI_REFUSAL'], [{ status: 500 }, 503, 'AI_UNAVAILABLE']]) {
    for (const [path, input, method] of [[questionPath, setup, 'generateQuestions'], [evaluationPath, { interviewToken: token, answers }, 'evaluate']]) {
      let attempts = 0;
      coach[method] = async () => { attempts++; throw Object.assign(new Error('secret transcript and key'), details); };
      const response = await post(path, input); assert.equal(response.status, expected);
      const result = await response.json(); assert.equal(result.code, code); assert.doesNotMatch(JSON.stringify(result), /secret|transcript|Career Coach/);
      assert.equal(attempts, 1);
    }
  }
});

test('route rejects malformed question sets, invalid scores and mismatched question numbering', async () => {
  const token = await interviewToken();
  coach.generateQuestions = async () => ({ questions: ['one'] }); assert.equal((await post(questionPath, setup)).status, 503);
  for (const bad of [101, -1, '90', 0.5]) {
    coach.evaluate = async () => ({ evaluation: { ...evaluation, overallScore: bad } });
    assert.equal((await post(evaluationPath, { interviewToken: token, answers })).status, 503);
  }
  coach.evaluate = async () => ({ evaluation: { ...evaluation, answers: evaluation.answers.map(answer => ({ ...answer, questionNumber: 1 })) } });
  assert.equal((await post(evaluationPath, { interviewToken: token, answers })).status, 503);
});

test('concurrent interview requests are blocked before an extra reservation and lock is released', async () => {
  const token = await interviewToken();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  coach.evaluate = () => new Promise(resolve => { release = () => resolve({ evaluation: structuredClone(evaluation) }); started(); });
  const pending = post(evaluationPath, { interviewToken: token, answers }); await ready;
  const before = reservations;
  try { assert.equal((await post(questionPath, setup)).status, 409); assert.equal((await post(evaluationPath, { interviewToken: token, answers })).status, 409); assert.equal(reservations, before); }
  finally { release(); }
  assert.equal((await pending).status, 200); assert.equal((await post(questionPath, setup)).status, 200);
});

function realUsage() {
  const records = new Map(); usage.reserve = originals.reserve;
  AiUsage.updateOne = async ({ _id }, update) => { if (!records.has(_id)) records.set(_id, { ...update.$setOnInsert }); };
  AiUsage.findOneAndUpdate = async (query, update) => {
    const record = records.get(query._id);
    if (!record || (query.count && record.count >= query.count.$lt) || (query.reservedMicros && record.reservedMicros > query.reservedMicros.$lte)) return null;
    for (const [key, value] of Object.entries(update.$inc)) record[key] += value;
    return { ...record };
  };
  return records;
}
for (const setting of ['AI_USER_HOURLY_LIMIT', 'AI_USER_DAILY_LIMIT', 'AI_MAX_REQUESTS', 'AI_BUDGET_USD']) test(`questions and evaluation share existing ${setting}`, async () => {
  const token = await interviewToken(); calls = 0;
  const records = realUsage(); process.env.AI_USER_HOURLY_LIMIT = '20'; process.env.AI_USER_DAILY_LIMIT = '20';
  process.env[setting] = setting === 'AI_BUDGET_USD' ? '0.20' : '2';
  await interviewToken(); assert.equal((await post(evaluationPath, { interviewToken: token, answers })).status, 200);
  assert.equal((await post(questionPath, setup)).status, 429); assert.equal((await post(evaluationPath, { interviewToken: token, answers })).status, 429);
  assert.equal(calls, 2); assert.equal(records.get('career-coach:global-budget:v1').count, 2); assert.equal(records.get('career-coach:global-budget:v1').reservedMicros, 200000);
  career.chat = async () => { throw new Error('Should not be called'); };
  assert.equal((await post('/api/ai/career-coach', { message: 'Explore a career' })).status, 429);
  assert.equal((await post('/api/ai/cv-coach', { cv: 'A'.repeat(100) })).status, 429);
});

test('unknown interview model and a lowered reserve fail closed', async () => {
  realUsage(); process.env.OPENAI_INTERVIEW_MODEL = 'unreviewed'; assert.equal((await post(questionPath, setup)).status, 503);
  delete process.env.OPENAI_INTERVIEW_MODEL; process.env.AI_REQUEST_RESERVE_USD = '0.01'; assert.equal((await post(questionPath, setup)).status, 503); assert.equal(calls, 0);
});

test('bounded Unicode answers are accepted without widening the existing Career Coach body limit', async () => {
  const token = await interviewToken(); assert.equal((await post(evaluationPath, { interviewToken: token, answers: Array(5).fill('漢'.repeat(2000)) })).status, 200);
  assert.equal((await post(evaluationPath, { text: 'x'.repeat(100000) })).status, 413);
  assert.equal((await post('/api/ai/career-coach', { message: 'x'.repeat(17000) })).status, 413);
});

test('complete frontend session → authenticated routes → real service with mock provider → five scored answers', async () => {
  const { InterviewSession } = await import('../../Client/src/interviewSession.ts');
  let providerCalls = 0;
  const provider = { responses: { create: async request => {
    providerCalls++; assert.equal(request.store, false); assert.equal(request.text.format.strict, true);
    const input = JSON.parse(request.input);
    if (request.text.format.name === 'interview_questions') { assert.deepEqual(input, setup); return { status: 'completed', output_text: JSON.stringify({ questions }) }; }
    assert.deepEqual(input, { ...setup, questions, answers });
    return { status: 'completed', output_text: JSON.stringify(evaluation) };
  } } };
  coach.generateQuestions = value => originals.generate(value, provider);
  coach.evaluate = value => originals.evaluate(value, provider);
  const session = new InterviewSession({ post: async (path, body, options) => {
    const response = await fetch(base + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie(user) }, body: JSON.stringify(body), signal: options.signal });
    const data = await response.json(); if (!response.ok) throw { response: { status: response.status, data } }; return { data };
  } });
  await session.start(setup); assert.equal(session.snapshot.stage, 'practice');
  await session.submitAnswer(0); assert.equal(session.snapshot.answers.length, 0);
  for (let i = 0; i < 5; i++) { assert.equal(session.snapshot.questions[i], questions[i]); session.setDraft(answers[i]); await session.submitAnswer(i); }
  assert.equal(session.snapshot.stage, 'results'); assert.deepEqual(session.snapshot.evaluation, evaluation);
  assert.equal(providerCalls, 2); assert.equal(reservations, 2);
  await session.evaluate(); await session.submitAnswer(4); assert.equal(providerCalls, 2);
});
