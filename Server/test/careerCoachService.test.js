const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generate, chat } = require('../services/careerCoach');

const guidance = { summary: 'Explore your interests.', strengths: ['Communication'], careerPaths: Array.from({ length: 3 }, () => ({ title: 'Career direction', reason: 'A transferable strength.', skillsToBuild: ['Research'], firstStep: 'Research entry requirements.' })), nextSteps: ['Explore a qualification.'], encouragement: 'Take one step.' };

test('provider request uses structured output, bounded tokens, no response storage and separate untrusted profile', async () => {
  const profile = { goals: 'Find work' };
  let request;
  const client = { responses: { create: async value => { request = value; return { status: 'completed', output_text: JSON.stringify(guidance) }; } } };
  const result = await generate(profile, client);
  assert.deepEqual(result.guidance, guidance);
  assert.equal(result.model, process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra');
  assert.equal(request.store, false);
  assert.equal(request.max_output_tokens, 3000);
  assert.equal(request.temperature, undefined);
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.strict, true);
  assert.deepEqual(JSON.parse(request.input), profile);
  assert.match(request.instructions, /untrusted data/);
});
test('OPENAI_MODEL overrides the default without imposing reasoning options', async () => {
  const previous = process.env.OPENAI_MODEL;
  process.env.OPENAI_MODEL = ' custom-text-model ';
  try {
    const client = { responses: { create: async request => {
      assert.equal(request.model, 'custom-text-model');
      assert.equal(request.reasoning, undefined);
      assert.equal(request.temperature, undefined);
      return { status: 'completed', output_text: JSON.stringify(guidance) };
    } } };
    assert.equal((await generate({}, client)).model, 'custom-text-model');
  } finally {
    if (previous === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previous;
  }
});
test('incomplete, refused, invalid JSON and invalid structured results are rejected', async () => {
  for (const response of [
    { status: 'incomplete', output_text: JSON.stringify(guidance) },
    { status: 'completed', output_text: '' },
    { status: 'completed', output_text: '{bad' },
    { status: 'completed', output_text: '{}' },
  ]) {
    await assert.rejects(generate({}, { responses: { create: async () => response } }));
  }
});

test('chat forwards recent history before the latest message and keeps server instructions separate', async () => {
  const conversation = { message: 'How can I start?', history: [{ role: 'user', content: 'I enjoy coding.' }, { role: 'assistant', content: 'What have you built?' }] };
  const client = { responses: { create: async request => {
    assert.deepEqual(request.input, [...conversation.history, { role: 'user', content: conversation.message }]);
    assert.equal(request.store, false);
    assert.equal(request.max_output_tokens, 1200);
    assert.equal(request.temperature, undefined);
    assert.match(request.instructions, /untrusted context/);
    return { status: 'completed', output_text: ' Build a small project. ' };
  } } };
  assert.deepEqual(await chat(conversation, client), { reply: 'Build a small project.' });
});

test('explicit refusals are distinguished from malformed and incomplete output', async () => {
  const client = { responses: { create: async () => ({ status: 'completed', output_text: '', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Not answered' }] }] }) } };
  await assert.rejects(chat({ message: 'Question', history: [] }, client), { code: 'AI_REFUSAL' });
  await assert.rejects(generate({}, client), { code: 'AI_REFUSAL' });
});
