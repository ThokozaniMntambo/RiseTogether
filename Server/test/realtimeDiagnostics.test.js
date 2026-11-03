const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const OpenAI = require('openai');
const { inspect, config } = require('../services/realtimeConfig');
const { diagnose, logFailure, localError, fields } = require('../services/realtimeDiagnostics');
const live = require('../services/realtimeInterview');
const Lease = require('../models/RealtimeLease');
const usage = require('../services/aiUsage');
const User = require('../models/User');
const user = '507f1f77bcf86cd799439011';
const envKeys = ['REALTIME_ENABLED', 'REALTIME_ALLOWED_USER_IDS', 'REALTIME_PROJECT_HARD_CAP_CONFIRMED', 'OPENAI_REALTIME_API_KEY', 'REALTIME_MAX_SECONDS', 'REALTIME_SESSION_RESERVE_USD', 'AI_BUDGET_USD', 'JWT_SECRET'];
const env = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
const originals = { create: live.create, user: User.findById, lease: Lease.create, reserve: usage.reserve, log: console.error };
let server, base, logs, sequence = 0;
before(async () => {
  User.findById = async id => ({ id });
  server = require('../app').listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/ai/interview-coach/realtime/sessions`;
});
beforeEach(() => {
  for (const k of envKeys) delete process.env[k];
  process.env.JWT_SECRET = 'test-realtime-diagnostic-secret-at-least-32-characters';
  logs = []; console.error = (...args) => logs.push(args.join(' '));
  live.create = originals.create; Lease.create = originals.lease; usage.reserve = originals.reserve;
});
after(async () => {
  live.create = originals.create; User.findById = originals.user; Lease.create = originals.lease; usage.reserve = originals.reserve; console.error = originals.log;
  for (const k of envKeys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  await new Promise(r => server.close(r));
});
function configured() {
  Object.assign(process.env, { REALTIME_ENABLED: 'true', REALTIME_ALLOWED_USER_IDS: user, REALTIME_PROJECT_HARD_CAP_CONFIRMED: 'true', OPENAI_REALTIME_API_KEY: 'mock-key', REALTIME_SESSION_RESERVE_USD: '10', AI_BUDGET_USD: '20' });
}
async function post() {
  const id = (++sequence).toString(16).padStart(24, '0');
  const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `rt_session=${jwt.sign({}, process.env.JWT_SECRET, { subject: id })}` }, body: JSON.stringify({ setup: { jobTitle: 'Developer', interviewType: 'General' }, sdp: 'v=0 mock-offer' }) });
  return { status: response.status, body: await response.json(), retryAfter: response.headers.get('retry-after') };
}
test('reported generic 503 is a local preflight rejection: no lease, quota reservation or upstream call', async () => {
  let leaseCalls = 0, quotaCalls = 0, upstreamCalls = 0;
  Lease.create = async () => { leaseCalls++; };
  usage.reserve = async () => { quotaCalls++; };
  await assert.rejects(live.create(user, {}, 'v=0 offer', 'marin', { provider: { realtime: { calls: { create: async () => { upstreamCalls++; } } } } }), { code: 'VOICE_DISABLED' });
  assert.deepEqual([leaseCalls, quotaCalls, upstreamCalls], [0, 0, 0]);
  const response = await post(); assert.equal(response.status, 503); assert.equal(response.body.code, 'VOICE_DISABLED');
  assert.ok(logs.some(line => line.includes('"stage":"configuration"')));
  assert.ok(logs.every(line => line.includes('"upstreamStatus":null')));
});
test('configuration diagnostics distinguish all gates and identify the default $3 budget mismatch', () => {
  assert.deepEqual(inspect().failures.map(e => e.code), ['VOICE_DISABLED', 'VOICE_ALLOWLIST_EMPTY', 'VOICE_SPENDING_CAP_UNCONFIRMED', 'VOICE_API_KEY_MISSING', 'VOICE_LIMITS_INVALID']);
  configured(); assert.doesNotThrow(() => config(user));
  assert.throws(() => config('other'), { code: 'VOICE_ACCOUNT_NOT_ALLOWED', status: 403 });
  process.env.OPENAI_REALTIME_API_KEY = '  '; assert.ok(inspect().failures.some(e => e.code === 'VOICE_API_KEY_MISSING'));
  configured(); process.env.AI_BUDGET_USD = '2.00';
  assert.throws(() => config(user), { code: 'VOICE_SHARED_BUDGET_TOO_SMALL' });
});

test('lower reservation only passes with all gates and enough ceiling for feedback; never enables rollout', () => {
  configured(); process.env.REALTIME_SESSION_RESERVE_USD = '2.75'; process.env.AI_BUDGET_USD = '3.00';
  assert.equal(config(user).reserve, 2750000); assert.equal(config(user).feedbackReserve, 100000);
  process.env.REALTIME_SESSION_RESERVE_USD = '2.74'; assert.throws(() => config(user), { code: 'VOICE_LIMITS_INVALID' });
  process.env.REALTIME_SESSION_RESERVE_USD = '2.75'; process.env.AI_BUDGET_USD = '2.75'; assert.throws(() => config(user), { code: 'VOICE_SHARED_BUDGET_TOO_SMALL' });
  process.env.REALTIME_ENABLED = 'false'; assert.throws(() => config(user), { code: 'VOICE_DISABLED' });
});
test('OpenAI failures retain distinct codes/statuses without returning provider messages', async () => {
  for (const [status, errorCode, expectedStatus, expectedCode] of [
    [401, 'invalid_api_key', 502, 'VOICE_PROVIDER_AUTHENTICATION'],
    [403, 'permission_denied', 502, 'VOICE_PROVIDER_ACCESS_DENIED'],
    [404, 'model_not_found', 502, 'VOICE_PROVIDER_MODEL_UNAVAILABLE'],
    [400, 'invalid_value', 502, 'VOICE_PROVIDER_REQUEST_INVALID'],
    [422, 'invalid_value', 502, 'VOICE_PROVIDER_REQUEST_INVALID'],
    [429, 'rate_limit_exceeded', 429, 'VOICE_PROVIDER_RATE_LIMIT'],
    [429, 'insufficient_quota', 429, 'VOICE_PROVIDER_BILLING_LIMIT'],
    [429, 'billing_hard_limit_reached', 429, 'VOICE_PROVIDER_BILLING_LIMIT'],
    [500, 'server_error', 502, 'VOICE_UNAVAILABLE'],
    [504, 'timeout', 504, 'VOICE_PROVIDER_TIMEOUT'],
  ]) {
    live.create = async () => { throw Object.assign(new Error('secret provider text containing sk-key and candidate words'), { status, code: errorCode, type: 'invalid_request_error', request_id: 'req_diagnostic123' }); };
    const result = await post(); assert.equal(result.status, expectedStatus); assert.equal(result.body.code, expectedCode);
    assert.ok(!JSON.stringify(result).includes('secret')); assert.ok(!JSON.stringify(result).includes('req_diagnostic123'));
    if (expectedCode === 'VOICE_PROVIDER_RATE_LIMIT') assert.equal(result.retryAfter, '30');
    const last = logs.at(-1); assert.ok(last.includes(`"upstreamStatus":${status}`)); assert.ok(last.includes(`"errorCode":"${errorCode}"`)); assert.ok(last.includes('req_diagnostic123'));
  }
});
test('only typed application errors can expose local messages; arbitrary provider statuses cannot', () => {
  assert.equal(diagnose(localError('VOICE_USAGE_LIMIT', 429, 'Your hourly allowance is exhausted.')).message, 'Your hourly allowance is exhausted.');
  for (const status of [404, 409, 429, 503]) assert.ok(!diagnose({ status, message: 'secret candidate words', headers: { authorization: 'Bearer secret' } }).message.includes('secret'));
});
test('diagnostic logger extracts only safe metadata from HTTP and nested WebSocket failures', () => {
  logFailure({ status: 403, error: { code: 'permission_denied', type: 'invalid_request_error', message: 'secret text' }, request_id: 'req_safe123', headers: { authorization: 'sk-secret' }, body: 'sensitive SDP' }, 'create', 'provider_create');
  const value = JSON.parse(logs[0].slice('[realtime-interview] '.length));
  assert.deepEqual(value, { operation: 'create', stage: 'provider_create', code: 'VOICE_PROVIDER_ACCESS_DENIED', upstreamStatus: 403, errorType: 'invalid_request_error', errorCode: 'permission_denied', requestId: 'req_safe123' });
  assert.ok(!logs.join('').includes('secret')); assert.ok(!logs.join('').includes('sensitive'));
  assert.equal(fields({ cause: { statusCode: 401, code: 'invalid_api_key' } }).upstreamStatus, 401);
  assert.equal(fields({ code: 'sk-secret', type: 'ek_secret', request_id: 'secret\nline' }).requestId, null);
  assert.equal(fields({ code: 'sk-secret', type: 'ek_secret' }).errorCode, null);
  assert.equal(diagnose({ name: 'APIConnectionTimeoutError' }).status, 504);
});

test('installed SDK sends the supported multipart Realtime call request and exposes OpenAI error metadata', async () => {
  let target, payload, headers;
  const provider = new OpenAI({ apiKey: 'mock-sdk-key', maxRetries: 0, fetch: async (url, options) => {
    target = url; payload = options.body; headers = new Headers(options.headers);
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'model_not_found', message: 'sensitive provider message' } }), { status: 404, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_sdk_checked' } });
  } });
  let failure;
  try { await provider.realtime.calls.create({ sdp: 'v=0 mock-offer', session: live.sessionConfig({ jobTitle: 'Developer', interviewType: 'Technical' }, 'marin') }); }
  catch (error) { failure = error; }
  assert.equal(String(target), 'https://api.openai.com/v1/realtime/calls');
  assert.equal(headers.get('authorization'), 'Bearer mock-sdk-key');
  assert.ok(payload instanceof FormData);
  const sdp = payload.get('sdp'), session = payload.get('session');
  assert.equal(await sdp.text(), 'v=0 mock-offer');
  const value = JSON.parse(await session.text());
  assert.equal(value.type, 'realtime'); assert.equal(value.model, 'gpt-realtime-2.1-mini');
  assert.equal(value.audio.input.transcription.model, 'gpt-transcribe');
  assert.deepEqual(value.output_modalities, ['audio']); assert.equal(value.max_output_tokens, 700);
  assert.deepEqual(fields(failure), { upstreamStatus: 404, errorCode: 'model_not_found', errorType: 'invalid_request_error', requestId: 'req_sdk_checked' });
});
