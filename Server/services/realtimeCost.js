// Reviewed 2026-11-02 against official OpenAI pricing. USD micros, no cache discounts.
// These are planning controls, not a guaranteed provider invoice ceiling.
const policy = Object.freeze({
  minReserveMicros: 2750000, feedbackReserveMicros: 100000,
  maxSeconds: 600, maxResponses: 24, contextTokens: 8000, outputTokens: 700,
  instructionTokenAllowance: 8000, maxInstructionBytes: 7000,
  usageStopMicros: 1750000, transcriptionPerMinuteMicros: 4500,
});
function upperUsageMicros(usage) {
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  if (!valid(usage?.input_tokens) || !valid(usage?.output_tokens)) {
    // Missing usage on a cancelled/failed turn still consumes a conservative allowance.
    return (policy.contextTokens + policy.instructionTokenAllowance) * 10 + policy.outputTokens * 20;
  }
  const side = (total, details, rates, fallback) => {
    let classified = 0, micros = 0;
    for (const [key, rate] of Object.entries(rates)) {
      if (valid(details?.[key])) { classified += details[key]; micros += details[key] * rate; }
    }
    if (classified > total) return total * fallback;
    return micros + (total - classified) * fallback;
  };
  return Math.ceil(side(usage.input_tokens, usage.input_token_details, { audio_tokens: 10, text_tokens: .6, image_tokens: .8 }, 10)
    + side(usage.output_tokens, usage.output_token_details, { audio_tokens: 20, text_tokens: 2.4 }, 20));
}
function planningEstimate() {
  // Allow one extra response already starting while a server stop propagates.
  const responses = policy.maxResponses + 1;
  const audioContext = responses * policy.contextTokens * 10;
  const instructions = responses * policy.instructionTokenAllowance * .6;
  const output = responses * policy.outputTokens * 20;
  const transcription = policy.maxSeconds / 60 * policy.transcriptionPerMinuteMicros;
  return { reviewedAt: '2026-11-02', responseAllowance: responses,
    controlledPlanningUsd: (audioContext + instructions + output + transcription + policy.feedbackReserveMicros) / 1e6,
    voiceReservationUsd: policy.minReserveMicros / 1e6,
    feedbackReservationUsd: policy.feedbackReserveMicros / 1e6,
    combinedReservationUsd: (policy.minReserveMicros + policy.feedbackReserveMicros) / 1e6,
    guaranteedMaximum: false };
}
module.exports = { policy, upperUsageMicros, planningEstimate };
