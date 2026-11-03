const { test } = require('node:test');
const assert = require('node:assert/strict');
const { policy, upperUsageMicros, planningEstimate } = require('../services/realtimeCost');
const { sessionConfig } = require('../services/realtimeInterview');
test('reviewed price arithmetic includes replayed context, an extra response, transcription and feedback', () => {
  const plan = planningEstimate();
  assert.equal(plan.controlledPlanningUsd, 2.615);
  assert.equal(plan.combinedReservationUsd, 2.85);
  assert.equal(plan.guaranteedMaximum, false);
  assert.ok(plan.controlledPlanningUsd < plan.combinedReservationUsd);
});
test('usage upper bound charges cached tokens at full price and unclassified tokens conservatively', () => {
  assert.equal(upperUsageMicros({ input_tokens: 1500, output_tokens: 600, input_token_details: { audio_tokens: 1000, text_tokens: 500, cached_tokens: 900 }, output_token_details: { audio_tokens: 500, text_tokens: 100 } }), 20540);
  assert.equal(upperUsageMicros({ input_tokens: 1000, output_tokens: 500 }), 20000);
  assert.equal(upperUsageMicros(null), 174000);
  assert.equal(upperUsageMicros({ input_tokens: -1 }), 174000);
});
test('session preserves patient turn detection and constrains generation/context for the reviewed model', () => {
  const c = sessionConfig({ jobTitle: 'Developer', company: 'Example', interviewType: 'Technical' }, 'marin');
  assert.equal(c.max_output_tokens, policy.outputTokens);
  assert.equal(c.truncation.token_limits.post_instructions, 8000);
  assert.equal(c.audio.input.turn_detection.eagerness, 'low');
  assert.equal(c.audio.input.turn_detection.interrupt_response, true);
  assert.match(c.instructions, /WAIT for their reply/); assert.match(c.instructions, /1–3 sentences/);
});
