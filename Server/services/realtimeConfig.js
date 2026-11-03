const { localError } = require('./realtimeDiagnostics');
const { policy } = require('./realtimeCost');
const model = 'gpt-realtime-2.1-mini';
const transcriptionModel = 'gpt-transcribe';

// Read-only preflight. No user IDs, credentials, database writes or provider calls.
function inspect(userId) {
  const allowed = (process.env.REALTIME_ALLOWED_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  const seconds = Number(process.env.REALTIME_MAX_SECONDS || 600);
  const reserveUsd = Number(process.env.REALTIME_SESSION_RESERVE_USD);
  const sharedBudgetUsd = Number(process.env.AI_BUDGET_USD ?? '3.00');
  const failures = [];
  if (process.env.REALTIME_ENABLED !== 'true') failures.push(localError('VOICE_DISABLED', 503, 'Live voice is disabled on this server. The administrator must configure the restricted rollout. Text Mode is available.'));
  if (!allowed.length) failures.push(localError('VOICE_ALLOWLIST_EMPTY', 503, 'Live voice has no approved accounts configured. Contact the administrator or use Text Mode.'));
  else if (userId !== undefined && !allowed.includes(userId)) failures.push(localError('VOICE_ACCOUNT_NOT_ALLOWED', 403, 'This account is not approved for the live voice rollout. Please use Text Mode.'));
  if (process.env.REALTIME_PROJECT_HARD_CAP_CONFIRMED !== 'true') failures.push(localError('VOICE_SPENDING_CAP_UNCONFIRMED', 503, 'Live voice is unavailable until its provider spending cap is verified by the administrator. Please use Text Mode.'));
  if (!process.env.OPENAI_REALTIME_API_KEY?.trim()) failures.push(localError('VOICE_API_KEY_MISSING', 503, 'Live voice provider credentials are not configured on the server. Contact the administrator or use Text Mode.'));
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > policy.maxSeconds || !Number.isFinite(reserveUsd) || reserveUsd * 1e6 < policy.minReserveMicros || reserveUsd > 1000) failures.push(localError('VOICE_LIMITS_INVALID', 503, 'Live voice requires 60–600 seconds and a reviewed voice reservation of at least $2.75. Contact the administrator or use Text Mode.'));
  if (!Number.isFinite(sharedBudgetUsd) || sharedBudgetUsd <= 0 || (Number.isFinite(reserveUsd) && reserveUsd * 1e6 >= policy.minReserveMicros && sharedBudgetUsd < reserveUsd + policy.feedbackReserveMicros / 1e6)) failures.push(localError('VOICE_SHARED_BUDGET_TOO_SMALL', 503, 'The shared AI budget cannot fund the voice reservation plus feedback. Contact the administrator or use Text Mode.'));
  if ((process.env.OPENAI_INTERVIEW_MODEL?.trim() || 'gpt-4.1-mini') !== 'gpt-4.1-mini') failures.push(localError('VOICE_FEEDBACK_MODEL_UNREVIEWED', 503, 'The live voice feedback model needs a cost review. Use the reviewed gpt-4.1-mini model or Text Mode.'));
  return {
    model, transcriptionModel,
    enabled: process.env.REALTIME_ENABLED === 'true', approvedAccountCount: allowed.length,
    hardCapConfirmed: process.env.REALTIME_PROJECT_HARD_CAP_CONFIRMED === 'true',
    realtimeKeyPresent: Boolean(process.env.OPENAI_REALTIME_API_KEY?.trim()),
    standardKeyPresent: Boolean(process.env.OPENAI_API_KEY?.trim()),
    maxSeconds: Number.isFinite(seconds) ? seconds : null,
    reserveUsd: Number.isFinite(reserveUsd) && process.env.REALTIME_SESSION_RESERVE_USD?.trim() ? reserveUsd : null,
    sharedBudgetUsd: Number.isFinite(sharedBudgetUsd) ? sharedBudgetUsd : null,
    minimumVoiceReserveUsd: policy.minReserveMicros / 1e6,
    feedbackReserveUsd: policy.feedbackReserveMicros / 1e6,
    providerCreditBalance: 'unknown — check the billing console; model visibility is not a balance check',
    providerHardCapVerification: 'operator confirmation only; not verified by this script',
    failures,
  };
}
function config(userId) {
  const result = inspect(userId);
  if (result.failures.length) throw result.failures[0];
  return { seconds: result.maxSeconds, reserve: Math.ceil(result.reserveUsd * 1e6), feedbackReserve: policy.feedbackReserveMicros };
}
module.exports = { model, transcriptionModel, inspect, config };
