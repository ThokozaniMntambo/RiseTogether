// Only explicitly constructed application errors may supply public messages.
// Provider error.message/body/headers can contain keys, SDP or user text: never print them.
class RealtimeError extends Error {
  constructor(code, status, message, retryable = false, retryAfter) {
    super(message);
    this.code = code; this.status = status; this.retryable = retryable; this.retryAfter = retryAfter;
  }
}
const localError = (...args) => new RealtimeError(...args);

function fields(error) {
  if (error instanceof RealtimeError) return { upstreamStatus: null, errorType: null, errorCode: null, requestId: null };
  const candidates = [error, error?.error, error?.cause, error?.cause?.error].filter(Boolean);
  const pick = key => candidates.find(value => value[key] !== undefined)?.[key];
  // Metadata must look like provider identifiers, never arbitrary payload text.
  const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) && !/^(sk-|sess_|ek_)/i.test(value) ? value : null;
  const status = pick('status') ?? pick('statusCode');
  return {
    upstreamStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    errorType: identifier(pick('type')),
    errorCode: identifier(pick('code')),
    requestId: identifier(pick('request_id') ?? pick('requestID')),
  };
}
function diagnose(error) {
  if (error instanceof RealtimeError) return { status: error.status, code: error.code, message: error.message, retryable: error.retryable, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) };
  const { upstreamStatus: status, errorCode: code, errorType: type } = fields(error);
  if (['insufficient_quota', 'billing_hard_limit_reached', 'billing_limit_reached', 'spend_limit_exceeded', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded'].includes(code) || type === 'insufficient_quota') {
    return { status: 429, code: 'VOICE_PROVIDER_BILLING_LIMIT', retryable: false, message: 'Live voice cannot start because the AI provider billing or spending limit has been reached. Contact the administrator.' };
  }
  if (error?.name === 'APIConnectionTimeoutError' || ['ETIMEDOUT', 'VOICE_SIDEBAND_TIMEOUT'].includes(code) || [408, 504].includes(status)) {
    return { status: 504, code: 'VOICE_PROVIDER_TIMEOUT', retryable: true, message: 'The live voice provider timed out. Please wait before retrying or use Text Mode.' };
  }
  if (status === 429) return { status: 429, code: 'VOICE_PROVIDER_RATE_LIMIT', retryable: true, retryAfter: 30, message: 'The live voice provider is rate limited. Wait at least 30 seconds before retrying.' };
  if ([401, 403, 404, 400, 422].includes(status)) {
    const [suffix, detail] = {
      401: ['AUTHENTICATION', 'its provider credentials are invalid'],
      403: ['ACCESS_DENIED', 'its provider project or key lacks permission'],
      404: ['MODEL_UNAVAILABLE', 'the configured provider model or resource is unavailable'],
      400: ['REQUEST_INVALID', 'the provider rejected its session configuration or WebRTC offer'],
      422: ['REQUEST_INVALID', 'the provider rejected its session configuration or WebRTC offer'],
    }[status];
    return { status: 502, code: `VOICE_PROVIDER_${suffix}`, retryable: false, message: `Live voice could not start because ${detail}. Contact the administrator or use Text Mode.` };
  }
  return { status: status >= 500 ? 502 : 503, code: 'VOICE_UNAVAILABLE', retryable: true, message: 'Live voice is temporarily unavailable. Please use Text Mode or try again later.' };
}
function logFailure(error, operation, stage = 'unknown') {
  const failure = diagnose(error);
  // operation and stage are hardcoded by server call sites, never supplied by clients.
  console.error('[realtime-interview]', JSON.stringify({ operation, stage, code: failure.code, ...fields(error) }));
}
module.exports = { RealtimeError, localError, fields, diagnose, logFailure };
