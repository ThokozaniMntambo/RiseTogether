// Translate provider failures into fixed, safe messages. Never return or log raw errors.
module.exports = function coachError(error) {
  if (error?.code === 'insufficient_quota' || error?.type === 'insufficient_quota'
    || error?.code === 'billing_hard_limit_reached') {
    return { status: 503, code: 'AI_CREDITS_EXHAUSTED', retryable: false, message: 'Career Coach is unavailable because its AI credits or billing limit have been reached. Please contact the administrator.' };
  }
  if (error?.name === 'APIConnectionTimeoutError' || error?.code === 'ETIMEDOUT' || error?.status === 408 || error?.status === 504) {
    return { status: 504, code: 'AI_TIMEOUT', retryable: true, message: 'Career Coach took too long to respond. Please wait before trying again. This attempt may still count toward your usage limit.' };
  }
  if (error?.status === 429) {
    return { status: 503, code: 'AI_BUSY', retryable: true, retryAfter: 30, message: 'Career Coach is busy right now. Please wait at least 30 seconds before trying again.' };
  }
  if ([400, 401, 403, 404, 422].includes(error?.status)) {
    return { status: 503, code: 'AI_CONFIGURATION_ERROR', retryable: false, message: 'Career Coach could not connect with its current configuration. Please contact the administrator.' };
  }
  if (error?.code === 'AI_REFUSAL') {
    return { status: 422, code: 'AI_REFUSAL', retryable: false, message: 'Career Coach could not answer this request. Please rephrase your question around your career goals, skills or studies.' };
  }
  return { status: 503, code: 'AI_UNAVAILABLE', retryable: true, message: 'Your AI guidance could not be generated. Please try again later. No automatic retry was made.' };
};
