const AiUsage = require('../models/AiUsage');

function integer(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000) throw new Error(`Invalid ${name}`);
  return value;
}
function money(name, fallback) {
  const value = process.env[name] === undefined ? fallback : process.env[name];
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error(`Invalid ${name}`);
  const micros = Math.round(Number(value) * 1000000);
  if (!Number.isSafeInteger(micros) || micros < 1) throw new Error(`Invalid ${name}`);
  return micros;
}
async function initialise(id, expiresAt) {
  try {
    await AiUsage.updateOne({ _id: id }, { $setOnInsert: { count: 0, reservedMicros: 0, ...(expiresAt ? { expiresAt } : {}) } }, { upsert: true });
  } catch (error) {
    // Concurrent first requests can race to insert the same unique _id.
    if (error.code !== 11000) throw error;
  }
}

async function reserve(userId, now = Date.now(), model = process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra') {
  if (!/^[a-f\d]{24}$/i.test(userId)) throw new Error('Invalid quota user');
  const hourly = integer('AI_USER_HOURLY_LIMIT', 3);
  const daily = integer('AI_USER_DAILY_LIMIT', 5);
  const maxRequests = integer('AI_MAX_REQUESTS', 20);
  const budget = money('AI_BUDGET_USD', '3.00');
  // Unknown model pricing must be reviewed explicitly instead of inheriting a cheap-model estimate.
  const reviewedModel = ['gpt-5.6-terra', 'gpt-4.1-mini'].includes(model);
  if (!reviewedModel && process.env.AI_REQUEST_RESERVE_USD === undefined) throw new Error('Configure AI_REQUEST_RESERVE_USD for the selected model');
  const reserveMicros = money('AI_REQUEST_RESERVE_USD', '0.10');
  if (reviewedModel && reserveMicros < 100000) throw new Error('Default model reservation must be at least $0.10');

  for (const [period, duration, limit] of [['hour', 3600000, hourly], ['day', 86400000, daily]]) {
    const bucket = Math.floor(now / duration);
    const end = (bucket + 1) * duration;
    // Keep historical IDs: these buckets and the global budget serve ALL AI coaches.
    const id = `career-coach:${userId}:${period}:${bucket}`;
    await initialise(id, new Date(end + 86400000));
    const usage = await AiUsage.findOneAndUpdate({ _id: id, count: { $lt: limit } }, { $inc: { count: 1 } }, { new: true });
    if (!usage) return { allowed: false, retryAfter: Math.ceil((end - now) / 1000), message: `Your ${period === 'hour' ? 'hourly' : 'daily'} AI usage limit has been reached. Please try again later.` };
  }

  const id = 'career-coach:global-budget:v1';
  await initialise(id);
  // A single atomic write enforces both global caps across processes and restarts.
  const usage = await AiUsage.findOneAndUpdate({ _id: id, count: { $lt: maxRequests }, reservedMicros: { $lte: budget - reserveMicros } }, { $inc: { count: 1, reservedMicros: reserveMicros } }, { new: true });
  if (!usage) return { allowed: false, message: 'AI coaching has reached its shared usage budget. Please contact the administrator.' };
  // No refunds: failures/timeouts may still be billed, and crashes must not reopen the budget.
  return { allowed: true };
}

module.exports = { reserve };
