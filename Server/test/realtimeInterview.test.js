const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const jwt = require('jsonwebtoken');
const live = require('../services/realtimeInterview');
const Lease = require('../models/RealtimeLease');
const usage = require('../services/aiUsage');
const coach = require('../services/interviewCoach');
const User = require('../models/User');
const user = '507f1f77bcf86cd799439011';
const setup = { jobTitle: 'Developer', company: 'Example', interviewType: 'Technical' };
const envKeys = ['REALTIME_ENABLED', 'REALTIME_ALLOWED_USER_IDS', 'REALTIME_PROJECT_HARD_CAP_CONFIRMED', 'OPENAI_REALTIME_API_KEY', 'REALTIME_SESSION_RESERVE_USD', 'REALTIME_MAX_SECONDS', 'AI_BUDGET_USD', 'JWT_SECRET'];
const env = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
const originals = { create: Lease.create, find: Lease.find, update: Lease.updateOne, delete: Lease.deleteOne, reserve: usage.reserve, evaluate: coach.evaluateConversation, user: User.findById };
let server, base, lease, reserveCalls = 0, hangups = 0;
function enable() { Object.assign(process.env, { REALTIME_ENABLED: 'true', REALTIME_ALLOWED_USER_IDS: user, REALTIME_PROJECT_HARD_CAP_CONFIRMED: 'true', OPENAI_REALTIME_API_KEY: 'mock-key', REALTIME_SESSION_RESERVE_USD: '10', REALTIME_MAX_SECONDS: '60', AI_BUDGET_USD: '20.00' }); }
function dependencies() {
  const socket = new EventEmitter(); socket.socket = new EventEmitter(); socket.close = () => socket.socket.emit('close');
  return { socket, provider: { realtime: { calls: { create: async input => {
    assert.equal(input.session.audio.input.turn_detection.interrupt_response, true);
    return new Response('v=0 answer', { headers: { location: '/v1/realtime/calls/rtc_mock' } });
  }, hangup: async () => { hangups++; } } } }, connect: () => { setImmediate(() => socket.socket.emit('open')); return socket; } };
}
before(async () => {
  process.env.JWT_SECRET = 'realtime-test-only-secret-with-at-least-32-characters';
  User.findById = async id => ({ id });
  Lease.create = async value => { if (lease) throw Object.assign(new Error('duplicate'), { code: 11000 }); lease = value; };
  Lease.updateOne = async () => ({}); Lease.deleteOne = async () => { lease = null; };
  usage.reserve = async (_id, _now, _model, amount) => { reserveCalls++; if (amount !== undefined) assert.equal(amount, 10100000); return { allowed: true }; };
  server = require('../app').listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}/api/ai/interview-coach/realtime`;
});
after(async () => {
  Object.assign(Lease, { create: originals.create, find: originals.find, updateOne: originals.update, deleteOne: originals.delete }); usage.reserve = originals.reserve; coach.evaluateConversation = originals.evaluate; User.findById = originals.user;
  for (const k of envKeys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  await new Promise(r => server.close(r));
});
test('rollout fails closed without explicit enablement, allowlist, project hard cap and reserve', () => {
  for (const key of ['REALTIME_ENABLED', 'REALTIME_ALLOWED_USER_IDS', 'REALTIME_PROJECT_HARD_CAP_CONFIRMED', 'OPENAI_REALTIME_API_KEY', 'REALTIME_SESSION_RESERVE_USD']) {
    enable(); delete process.env[key]; assert.throws(() => live.config(user));
  }
  enable(); assert.throws(() => live.config('other')); process.env.REALTIME_MAX_SECONDS = '901'; assert.throws(() => live.config(user)); enable();
});
test('authenticated routes reject missing JWT, foreign origins, invalid offers and session ownership', async () => {
  const post = (suffix, body, cookie = true, extra = {}) => fetch(base + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `rt_session=${jwt.sign({}, process.env.JWT_SECRET, { subject: user })}` } : {}), ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('/sessions', {}, false)).status, 401);
  assert.equal((await post('/sessions', {}, true, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/sessions', { setup, sdp: 'invalid' })).status, 422);
  assert.equal((await post('/sessions/not-owned/feedback', {})).status, 404);
  assert.equal(reserveCalls, 0);
});
test('server owns configuration, transcript, concurrency, shared budget and idempotent feedback', async () => {
  enable(); const deps = dependencies(); const result = await live.create(user, setup, 'v=0 offer', 'marin', deps);
  const s = live.owned(result.id, user); assert.throws(() => live.owned(result.id, 'other')); assert.equal(result.sdp, 'v=0 answer');
  await assert.rejects(live.create(user, setup, 'v=0 offer', 'marin', dependencies()), { status: 409 });
  deps.socket.emit('event', { type: 'response.output_audio_transcript.done', item_id: 'q', transcript: 'Describe your project.' });
  deps.socket.emit('event', { type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'I built a React app for students. I interviewed three users and added a search tool. Then I tested the results against their needs.' });
  deps.socket.emit('event', { type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'duplicate' });
  assert.equal(s.transcript.length, 2);
  coach.evaluateConversation = async input => { assert.equal(input.transcript[1].text, s.transcript[1].text); return { evaluation: { overallScore: 70 } }; };
  await live.stop(s); await live.stop(s); assert.equal(hangups, 1); assert.equal(lease, null);
  const report = await live.report(s); assert.equal(report.evaluation.overallScore, 70); await live.report(s); assert.equal(reserveCalls, 1);
});
test('session reconfiguration ends provider call and insufficient transcript is never scored', async () => {
  const deps = dependencies(); const result = await live.create(user, setup, 'v=0 offer', 'cedar', deps); const s = live.owned(result.id, user);
  deps.socket.emit('event', { type: 'session.updated' }); await live.stop(s);
  assert.equal(s.ended, true); assert.equal((await live.report(s)).evaluation, null); assert.equal(hangups, 2);
});
test('backend duration and abandoned-heartbeat timers terminate provider calls independently of client timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const deps = dependencies(); const first = await live.create(user, setup, 'v=0 offer', 'marin', deps); const s = live.owned(first.id, user);
  s.lastSeen += 600000; // Keep heartbeat alive to isolate the duration limit.
  t.mock.timers.tick(60001); await live.stop(s);
  assert.equal(s.reason, 'Session time limit reached'); assert.equal(lease, null);
  const second = await live.create(user, setup, 'v=0 offer', 'marin', dependencies()); const abandoned = live.owned(second.id, user);
  t.mock.timers.tick(35001); await live.stop(abandoned);
  assert.equal(abandoned.reason, 'Connection lost'); assert.equal(lease, null);
});

test('uncertain provider termination retains lease until orphan reaper confirms hangup', async () => {
  const deps = dependencies(); deps.provider.realtime.calls.hangup = async () => { throw new Error('Provider unavailable'); };
  const result = await live.create(user, setup, 'v=0 offer', 'marin', deps); const s = live.owned(result.id, user);
  await live.stop(s); assert.ok(lease); assert.match(s.reason, /cleanup pending/);
  Lease.find = () => ({ limit: async () => [{ _id: user, sessionId: result.id, callId: 'rtc_mock' }] });
  await live.reap(deps); assert.ok(lease, 'reaper also fails closed');
  const recovered = dependencies(); await live.reap(recovered); assert.equal(lease, null);
});

test('server transcript preserves conversation order when input transcription arrives late', () => {
  const s = { transcript: [] };
  live.capture(s, { type: 'conversation.item.created', item: { id: 'user-answer' } });
  live.capture(s, { type: 'conversation.item.created', item: { id: 'follow-up' }, previous_item_id: 'user-answer' });
  live.capture(s, { type: 'response.output_audio_transcript.done', item_id: 'follow-up', transcript: 'How did you test it?' });
  live.capture(s, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-answer', transcript: 'I built a project.' });
  assert.deepEqual(s.transcript.map(t => t.id), ['user-answer', 'follow-up']);
});

test('sideband handshake rejection retains upstream HTTP status and request ID for diagnostics', async () => {
  const deps = dependencies(); let resumed = false;
  deps.socket.socket.terminate = () => deps.socket.socket.emit('close');
  deps.connect = () => {
    setImmediate(() => deps.socket.socket.emit('unexpected-response', null, { statusCode: 403, headers: { 'x-request-id': 'req_handshake_test' }, resume: () => { resumed = true; } }));
    return deps.socket;
  };
  await assert.rejects(live.create(user, setup, 'v=0 offer', 'marin', deps), { status: 403, request_id: 'req_handshake_test' });
  assert.equal(resumed, true); assert.equal(lease, null);
});

test('one-minute warning and ten-minute deadline are server-owned and do not interrupt the candidate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  process.env.REALTIME_MAX_SECONDS = '600';
  const result = await live.create(user, setup, 'v=0 offer', 'marin', dependencies()); const s = live.owned(result.id, user);
  s.lastSeen += 700000;
  t.mock.timers.tick(539999); assert.equal(Boolean(s.oneMinuteWarning), false);
  t.mock.timers.tick(1); assert.equal(s.oneMinuteWarning, true); assert.equal(s.ended, false);
  t.mock.timers.tick(60001); await live.stop(s); assert.equal(s.reason, 'Session time limit reached');
  process.env.REALTIME_MAX_SECONDS = '60';
});

test('server usage cutoff and response ceiling end paid conversation with available transcript retained', async () => {
  const deps = dependencies(); const result = await live.create(user, setup, 'v=0 offer', 'marin', deps); const s = live.owned(result.id, user);
  deps.socket.emit('event', { type: 'conversation.item.input_audio_transcription.completed', item_id: 'answer', transcript: 'I tested a solution with real users.' });
  const event = { type: 'response.done', response: { id: 'usage1', usage: { input_tokens: 100000, output_tokens: 40000 } } };
  deps.socket.emit('event', event); await live.stop(s);
  assert.equal(s.reason, 'Session cost safety limit reached'); assert.equal(s.transcript.length, 1);
  const other = dependencies(); const next = await live.create(user, setup, 'v=0 offer', 'marin', other); const s2 = live.owned(next.id, user);
  for (let i = 0; i < 25; i++) other.socket.emit('event', { type: 'response.created' });
  await live.stop(s2); assert.equal(s2.reason, 'Conversation usage limit reached');
});

test('missing/cancelled usage consumes an allowance and repeated response.done events are not double counted', async () => {
  const deps = dependencies(); const result = await live.create(user, setup, 'v=0 offer', 'marin', deps); const s = live.owned(result.id, user);
  const event = { type: 'response.done', response: { id: 'cancelled', status: 'cancelled' } };
  deps.socket.emit('event', event); deps.socket.emit('event', event);
  assert.equal(s.usageUpperMicros, 174000); assert.equal(s.ended, false);
  await live.stop(s);
});

test('prepaid feedback attempts are single use; a provider retry requires another quota reservation', async () => {
  const deps = dependencies(); const result = await live.create(user, setup, 'v=0 offer', 'marin', deps); const s = live.owned(result.id, user);
  s.transcript.push({ id: 'answer', role: 'candidate', text: 'I created a student job board, interviewed three users, tested search results and improved the filters based on their feedback.' });
  const evaluate = coach.evaluateConversation; let attempts = 0;
  coach.evaluateConversation = async () => { if (++attempts === 1) throw new Error('Mock provider failure'); return { evaluation: { overallScore: 75 } }; };
  try {
    await live.stop(s); const before = reserveCalls;
    await assert.rejects(live.report(s)); assert.equal(reserveCalls, before); assert.equal(s.feedbackReserved, false);
    const report = await live.report(s); assert.equal(report.evaluation.overallScore, 75); assert.equal(reserveCalls, before + 1);
    await live.report(s); assert.equal(attempts, 2);
  } finally { coach.evaluateConversation = evaluate; }
});

test('quota denial creates no provider call and releases unused lease', async () => {
  const before = hangups;
  usage.reserve = async () => ({ allowed: false, message: 'Budget exhausted' });
  await assert.rejects(live.create(user, setup, 'v=0 offer', 'marin', dependencies()), { status: 429 });
  assert.equal(lease, null); assert.equal(hangups, before);
});
