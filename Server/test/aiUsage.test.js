const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const AiUsage = require('../models/AiUsage');
const { reserve } = require('../services/aiUsage');
const originalUpdate = AiUsage.updateOne;
const originalFind = AiUsage.findOneAndUpdate;
const keys = ['AI_USER_HOURLY_LIMIT', 'AI_USER_DAILY_LIMIT', 'AI_MAX_REQUESTS', 'AI_BUDGET_USD', 'AI_REQUEST_RESERVE_USD', 'OPENAI_MODEL'];
const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const user = index => index.toString(16).padStart(24, '0');
let records;
beforeEach(() => {
  for (const key of keys) delete process.env[key];
  records = new Map();
  // Isolate MongoDB; perform each conditional update synchronously to model atomic writes.
  AiUsage.updateOne = async ({ _id }, update) => {
    if (!records.has(_id)) records.set(_id, { _id, ...update.$setOnInsert });
  };
  AiUsage.findOneAndUpdate = async (query, update) => {
    const doc = records.get(query._id);
    if (!doc || (query.count && !(doc.count < query.count.$lt))
      || (query.reservedMicros && !(doc.reservedMicros <= query.reservedMicros.$lte))) return null;
    for (const [key, increment] of Object.entries(update.$inc)) doc[key] += increment;
    return { ...doc };
  };
});
after(() => {
  AiUsage.updateOne = originalUpdate; AiUsage.findOneAndUpdate = originalFind;
  for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
});

test('persistent hourly limit is independent per authenticated user', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await reserve(user(1), 1000)).allowed, true);
  const blocked = await reserve(user(1), 1000);
  assert.equal(blocked.allowed, false); assert.match(blocked.message, /hourly/);
  assert.equal(blocked.retryAfter, 3599);
  assert.equal((await reserve(user(2), 1000)).allowed, true);
  assert.equal(records.get('career-coach:global-budget:v1').count, 4);
});
test('daily cap survives an hour rollover and new service invocation', async () => {
  process.env.AI_USER_DAILY_LIMIT = '2';
  assert.equal((await reserve(user(1), 1000)).allowed, true);
  assert.equal((await reserve(user(1), 3601000)).allowed, true);
  const freshService = require('../services/aiUsage');
  const blocked = await freshService.reserve(user(1), 7201000);
  assert.equal(blocked.allowed, false); assert.match(blocked.message, /daily/);
  assert.equal((await reserve(user(1), 86401000)).allowed, true);
});
test('atomic shared budget cannot be exceeded by concurrent accounts', async () => {
  process.env.AI_BUDGET_USD = '0.20';
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => reserve(user(i + 1), 1000)));
  assert.equal(results.filter(result => result.allowed).length, 2);
  const budget = records.get('career-coach:global-budget:v1');
  assert.equal(budget.reservedMicros, 200000); assert.equal(budget.count, 2);
  assert.equal(budget.expiresAt, undefined);
  // A later day does not replenish the lifetime budget.
  assert.equal((await reserve(user(99), 86401000)).allowed, false);
});
test('lifetime request cap independently blocks further attempts', async () => {
  process.env.AI_MAX_REQUESTS = '1';
  assert.equal((await reserve(user(1), 1000)).allowed, true);
  assert.equal((await reserve(user(2), 1000)).allowed, false);
  assert.equal(records.get('career-coach:global-budget:v1').count, 1);
});
test('invalid config and unreviewed model pricing fail closed before reserving usage', async () => {
  process.env.AI_BUDGET_USD = 'NaN';
  await assert.rejects(reserve(user(1)), /Invalid AI_BUDGET_USD/);
  delete process.env.AI_BUDGET_USD;
  process.env.OPENAI_MODEL = 'different-model';
  await assert.rejects(reserve(user(1)), /Configure AI_REQUEST_RESERVE_USD/);
  delete process.env.OPENAI_MODEL;
  process.env.AI_REQUEST_RESERVE_USD = '0.01';
  await assert.rejects(reserve(user(1)), /at least/);
  assert.equal(records.size, 0);
});
test('database failures propagate without granting permission to call AI', async () => {
  AiUsage.findOneAndUpdate = async () => { throw new Error('Database unavailable'); };
  await assert.rejects(reserve(user(1)), /Database unavailable/);
  assert.equal(records.has('career-coach:global-budget:v1'), false);
});
