const { test } = require('node:test');
const assert = require('node:assert/strict');
const coach = require('../services/interviewCoach');
const setup = { jobTitle: 'Junior developer', company: 'Example', interviewType: 'Technical' };
const questions = Array.from({ length: 5 }, (_, i) => `How would you solve development problem ${i + 1}?`);
const evaluation = { overallScore: 70, answers: questions.map((_, i) => ({ questionNumber: i + 1, score: 60 + i, feedback: 'Explain a concrete example and check the result.' })), strengths: ['Clear example'], improvements: ['Explain tradeoffs'], recommendations: ['Practise a short structured answer.'] };
function provider(value, capture = () => {}) { return { responses: { create: async request => { capture(request); return { status: 'completed', output_text: JSON.stringify(value) }; } } }; }

test('conversational feedback accepts partial evidence, derives rubric total and preserves null scores', async () => {
  const value = { overallScore: 99, communicationClarity: 80, answerRelevance: 60, competency: 70, evidenceSummary: 'One relevant project answer is available.', strengths: ['Specific example'], improvements: ['Explain testing'], recommendations: ['Practise explaining tradeoffs.'] };
  let request;
  const input = { setup, transcript: [{ role: 'candidate', text: 'I built and tested an app.' }], incomplete: true };
  const result = await coach.evaluateConversation(input, provider(value, r => { request = r; }));
  assert.equal(result.evaluation.overallScore, 70); assert.equal(request.store, false);
  assert.deepEqual(JSON.parse(request.input), input); assert.match(request.instructions, /Never score accent/);
  const partial = await coach.evaluateConversation(input, provider({ ...value, competency: null }));
  assert.equal(partial.evaluation.overallScore, null); assert.equal(partial.evaluation.competency, null);
  for (const invalid of [-1, 101, 0.5, '80', undefined]) await assert.rejects(coach.evaluateConversation(input, provider({ ...value, communicationClarity: invalid })));
});

test('questions use the existing Responses API with strict schema, bounded output and untrusted setup', async () => {
  let request;
  assert.deepEqual(await coach.generateQuestions(setup, provider({ questions }, value => { request = value; })), { questions });
  assert.equal(request.model, process.env.OPENAI_INTERVIEW_MODEL?.trim() || 'gpt-4.1-mini');
  assert.equal(request.store, false); assert.equal(request.max_output_tokens, 1300);
  assert.equal(request.text.format.type, 'json_schema'); assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.equal(request.text.format.schema.properties.questions.minItems, 5);
  assert.deepEqual(JSON.parse(request.input), setup);
  assert.match(request.instructions, /untrusted data/); assert.match(request.instructions, /hypothetical/);
});

test('evaluation uses the content-only rubric, checks all scores and derives the overall mean', async () => {
  const input = { ...setup, questions, answers: questions.map(() => 'I tested a small change.') };
  let request;
  const { evaluation: result } = await coach.evaluate(input, provider(evaluation, value => { request = value; }));
  assert.equal(result.overallScore, 62); assert.equal(result.answers.length, 5);
  assert.deepEqual(JSON.parse(request.input), input);
  assert.equal(request.max_output_tokens, 2500); assert.equal(request.store, false);
  assert.equal(request.text.format.strict, true);
  assert.match(request.instructions, /Never score accent/); assert.match(request.instructions, /untrusted data/);
  const score = request.text.format.schema.properties.answers.items.properties.score;
  assert.deepEqual(score, { type: 'integer', minimum: 0, maximum: 100 });
});

test('rejects invalid, duplicate or incomplete question sets', async () => {
  for (const value of [{}, { questions: questions.slice(1) }, { questions: [...questions, 'extra'] }, { questions: Array(5).fill('Same question') }, { questions: [' ', ...questions.slice(1)] }, { questions: [2, ...questions.slice(1)] }, { questions: ['x'.repeat(501), ...questions.slice(1)] }, { questions, extra: true }]) {
    await assert.rejects(coach.generateQuestions(setup, provider(value)));
  }
});

test('rejects noninteger, nonfinite, out-of-range and mismatched scores or missing feedback', async () => {
  for (const value of [-1, 101, 50.5, '70', null, NaN, Infinity]) {
    assert.equal(coach.matchesEvaluation({ ...evaluation, overallScore: value }), false);
    const invalid = { ...evaluation, answers: evaluation.answers.map((answer, i) => i ? answer : { ...answer, score: value }) };
    assert.equal(coach.matchesEvaluation(invalid), false);
    await assert.rejects(coach.evaluate(setup, provider(invalid)));
  }
  for (const invalid of [
    { ...evaluation, answers: evaluation.answers.slice(1) },
    { ...evaluation, answers: evaluation.answers.map(answer => ({ ...answer, questionNumber: 1 })) },
    { ...evaluation, answers: evaluation.answers.map(answer => ({ ...answer, feedback: '' })) },
    { ...evaluation, recommendations: [] }, { ...evaluation, strengths: ['x'.repeat(301)] }, { ...evaluation, extra: true },
  ]) await assert.rejects(coach.evaluate(setup, provider(invalid)));
});

test('incomplete, refused and malformed provider responses fail without retries', async () => {
  for (const operation of [coach.generateQuestions, coach.evaluate]) {
    for (const response of [{ status: 'incomplete', output_text: '{}' }, { status: 'completed', output_text: 'not json' }, { status: 'completed', output_text: '' }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }]) {
      let calls = 0;
      await assert.rejects(operation(setup, { responses: { create: async () => { calls++; return response; } } }));
      assert.equal(calls, 1);
    }
  }
});

test('model override is supported without imposing model-specific options', async () => {
  const previous = process.env.OPENAI_INTERVIEW_MODEL;
  process.env.OPENAI_INTERVIEW_MODEL = 'reviewed-custom-model';
  try {
    await coach.generateQuestions(setup, provider({ questions }, request => { assert.equal(request.model, 'reviewed-custom-model'); assert.equal(request.temperature, undefined); assert.equal(request.reasoning, undefined); }));
  } finally { if (previous === undefined) delete process.env.OPENAI_INTERVIEW_MODEL; else process.env.OPENAI_INTERVIEW_MODEL = previous; }
});
