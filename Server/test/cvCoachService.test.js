const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, matches } = require('../services/cvCoach');
const analysis = { professionalSummary: 'Clarify your focus.', strengths: ['Project work'], improvements: ['Describe your contribution.'], jobKeywords: [], skillGaps: [], formatting: ['Use clear headings.'], rewrittenBullets: [{ original: 'Built a website.', suggested: 'Developed a website.' }], nextSteps: ['Review your summary.'] };
const input = { cv: 'Built a website.', jobDescription: '' };
const client = response => ({ responses: { create: async () => response } });
test('CV request bounds output, separates untrusted documents and uses strict JSON without storage', async () => {
  let calls = 0;
  const result = await analyze(input, { responses: { create: async request => {
    calls++;
    assert.equal(request.model, process.env.OPENAI_CV_MODEL?.trim() || 'gpt-4.1-mini');
    assert.equal(request.store, false); assert.equal(request.max_output_tokens, 3000);
    assert.equal(request.text.format.strict, true); assert.equal(request.text.format.type, 'json_schema');
    assert.equal(request.text.format.schema.additionalProperties, false);
    assert.deepEqual(JSON.parse(request.input), input);
    assert.match(request.instructions, /untrusted data/); assert.match(request.instructions, /Do not invent/);
    return { status: 'completed', output_text: JSON.stringify(analysis) };
  } } });
  assert.deepEqual(result, { analysis }); assert.equal(calls, 1);
});
test('CV model override is configurable without imposing model-specific options', async () => {
  const previous = process.env.OPENAI_CV_MODEL;
  process.env.OPENAI_CV_MODEL = ' custom-model ';
  try {
    await analyze(input, { responses: { create: async request => {
      assert.equal(request.model, 'custom-model'); assert.equal(request.reasoning, undefined);
      return { status: 'completed', output_text: JSON.stringify(analysis) };
    } } });
  } finally { if (previous === undefined) delete process.env.OPENAI_CV_MODEL; else process.env.OPENAI_CV_MODEL = previous; }
});
test('CV schema rejects extra, missing, empty, oversized and incorrectly typed fields', () => {
  assert.equal(matches(analysis), true);
  for (const value of [{}, { ...analysis, score: 90 }, { ...analysis, professionalSummary: '' }, { ...analysis, professionalSummary: 'x'.repeat(1201) }, { ...analysis, strengths: 'good' }, { ...analysis, nextSteps: [] }, { ...analysis, rewrittenBullets: [{ original: 'a' }] }]) assert.equal(matches(value), false);
});
test('CV incomplete, refused, malformed and ungrounded responses fail without retry', async () => {
  for (const response of [
    { status: 'incomplete', output_text: JSON.stringify(analysis) },
    { status: 'completed', output_text: 'invalid json' },
    { status: 'completed', output_text: '{}' },
    { status: 'completed', output_text: JSON.stringify({ ...analysis, rewrittenBullets: [{ original: 'Invented employment', suggested: 'CEO' }] }) },
  ]) await assert.rejects(analyze(input, client(response)));
  await assert.rejects(analyze(input, client({ output: [{ type: 'message', content: [{ type: 'refusal' }] }] })), { code: 'AI_REFUSAL' });
  let calls = 0;
  await assert.rejects(analyze(input, { responses: { create: async () => { calls++; throw new Error('offline'); } } }));
  assert.equal(calls, 1);
});
