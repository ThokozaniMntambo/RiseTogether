import test from 'node:test'
import assert from 'node:assert/strict'
import { InterviewSession, validEvaluation } from '../src/interviewSession.ts'
import { VoiceSession } from '../src/voice.ts'

const setup = { jobTitle: 'Junior developer', company: 'Example', interviewType: 'General' }
const questions = Array.from({ length: 5 }, (_, i) => `Interview question ${i + 1}?`)
const evaluation = { overallScore: 70, answers: questions.map((_, i) => ({ questionNumber: i + 1, score: 70, feedback: 'Explain the result with a specific example.' })), strengths: ['Relevant example'], improvements: ['Clearer structure'], recommendations: ['Practise the STAR method.'] }
function harness(override) {
  const calls = []
  const session = new InterviewSession({ post: async (path, body, options) => {
    calls.push({ path, body, options })
    if (override) return override(path, body, options)
    return { data: path.endsWith('/questions') ? { questions, interviewToken: 'signed-questions' } : { evaluation } }
  } })
  return { session, calls }
}
async function answerFive(session) { for (let i = 0; i < 5; i++) { session.setDraft(`My answer ${i + 1}`); await session.submitAnswer(i) } }

test('five-question text interview completes end to end with one generation and one evaluation request', async () => {
  const { session, calls } = harness()
  await session.start(setup)
  for (let i = 0; i < 5; i++) {
    assert.equal(session.snapshot.stage, 'practice'); assert.equal(session.snapshot.answers.length, i); assert.equal(session.snapshot.questions[i], questions[i])
    session.setDraft(`Edited answer ${i + 1}`); await session.submitAnswer(i)
  }
  assert.equal(session.snapshot.stage, 'results'); assert.deepEqual(session.snapshot.evaluation, evaluation)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].body, setup)
  assert.deepEqual(calls[1].body, { interviewToken: 'signed-questions', answers: Array.from({ length: 5 }, (_, i) => `Edited answer ${i + 1}`) })
  assert.equal(calls[0].options.timeout, 65000); assert.ok(calls[0].options.signal instanceof AbortSignal)
})

test('invalid setup, empty answers and stale double submissions do not advance or call AI', async () => {
  const { session, calls } = harness()
  await session.start({ ...setup, jobTitle: ' ' }); assert.equal(calls.length, 0)
  await session.start(setup)
  session.setDraft('   '); await session.submitAnswer(0); assert.equal(session.snapshot.answers.length, 0)
  session.setDraft('First answer'); await session.submitAnswer(0)
  session.setDraft('Draft for second'); await session.submitAnswer(0)
  assert.equal(session.snapshot.answers.length, 1); assert.equal(session.snapshot.draft, 'Draft for second')
  assert.equal(calls.length, 1)
})

test('double-click start and evaluation are synchronously locked', async () => {
  let release
  const { session, calls } = harness(path => new Promise(resolve => { release = () => resolve({ data: path.endsWith('/questions') ? { questions, interviewToken: 'token' } : { evaluation } }) }))
  const start = session.start(setup); await session.start(setup); assert.equal(calls.length, 1); assert.equal(session.snapshot.busy, true); release(); await start
  for (let i = 0; i < 4; i++) { session.setDraft('A clear answer'); await session.submitAnswer(i) }
  session.setDraft('Last answer'); const final = session.submitAnswer(4)
  await session.submitAnswer(4); await session.evaluate(); assert.equal(calls.length, 2)
  assert.equal(session.snapshot.stage, 'review'); assert.equal(session.snapshot.busy, true)
  release(); await final
  await session.evaluate(); assert.equal(calls.length, 2); assert.equal(session.snapshot.stage, 'results')
})

test('evaluation quota or network failure retains all answers and supports a deliberate retry', async () => {
  for (const error of [{ response: { status: 429, data: { message: 'Shared quota exhausted' } } }, { code: 'ECONNABORTED' }, new Error('Network failure')]) {
    let fail = true
    const { session, calls } = harness(path => {
      if (path.endsWith('/questions')) return { data: { questions, interviewToken: 'token' } }
      if (fail) throw error
      return { data: { evaluation } }
    })
    await session.start(setup); await answerFive(session)
    assert.equal(session.snapshot.stage, 'review'); assert.equal(session.snapshot.answers.length, 5); assert.ok(session.snapshot.error)
    assert.equal(calls.length, 2); assert.equal(session.snapshot.busy, false)
    fail = false; await session.evaluate()
    assert.equal(session.snapshot.stage, 'results'); assert.equal(calls.length, 3)
  }
})

test('authentication and provider billing errors block repeated requests without discarding work', async () => {
  for (const [status, code, expected] of [[401, '', 'expired'], [503, 'AI_CREDITS_EXHAUSTED', 'unavailable'], [503, 'AI_CONFIGURATION_ERROR', 'unavailable']]) {
    const { session, calls } = harness(() => { throw { response: { status, data: { code, message: 'Unavailable' } } } })
    await session.start(setup); assert.equal(session.snapshot[expected], true); assert.equal(session.snapshot.busy, false)
    await session.start(setup); assert.equal(calls.length, 1)
  }
})

test('malformed question sets and feedback never become a successful interview', async () => {
  for (const value of [{ questions: questions.slice(1), interviewToken: 'token' }, { questions: Array(5).fill('Duplicate?'), interviewToken: 'token' }, { questions }]) {
    const { session } = harness(() => ({ data: value })); await session.start(setup)
    assert.equal(session.snapshot.stage, 'setup'); assert.ok(session.snapshot.error)
  }
  for (const value of [{}, { ...evaluation, overallScore: 101 }, { ...evaluation, overallScore: 65 }, { ...evaluation, answers: evaluation.answers.map(answer => ({ ...answer, score: '70' })) }, { ...evaluation, answers: evaluation.answers.map(answer => ({ ...answer, questionNumber: 1 })) }]) {
    assert.equal(validEvaluation(value), false)
    const { session } = harness(path => ({ data: path.endsWith('/questions') ? { questions, interviewToken: 'token' } : { evaluation: value } }))
    await session.start(setup); await answerFive(session)
    assert.equal(session.snapshot.stage, 'review'); assert.equal(session.snapshot.evaluation, null); assert.equal(session.snapshot.answers.length, 5)
  }
})

test('reset and navigation abort requests and ignore late responses', async () => {
  let release
  const { session, calls } = harness(() => new Promise(resolve => { release = () => resolve({ data: { questions, interviewToken: 'token' } }) }))
  const pending = session.start(setup); session.reset()
  assert.equal(calls[0].options.signal.aborted, true)
  release(); await pending
  assert.equal(session.snapshot.stage, 'setup'); assert.equal(session.snapshot.questions.length, 0); assert.equal(session.snapshot.busy, false)
})

test('unsupported speech recognition leaves the complete typed interview available', async () => {
  const { session } = harness(); const voice = new VoiceSession({}, session.setDraft)
  await session.start(setup); voice.open(); voice.listen('')
  assert.equal(voice.snapshot.phase, 'Error'); assert.equal(voice.recognitionSupported, false)
  await answerFive(session)
  assert.equal(session.snapshot.stage, 'results'); voice.end()
})

test('microphone denial keeps the typed draft and text fallback completes all five questions', async () => {
  let microphone
  class Recognition { constructor() { microphone = this } start() {} stop() { this.onend?.() } abort() { this.aborted = true } }
  const { session } = harness(); const voice = new VoiceSession({ SpeechRecognition: Recognition }, session.setDraft)
  await session.start(setup); session.setDraft('Keep my draft')
  voice.open(); voice.listen(session.snapshot.draft); microphone.onerror({ error: 'not-allowed' })
  assert.match(voice.snapshot.error, /permission was denied/); assert.equal(session.snapshot.draft, 'Keep my draft'); assert.equal(microphone.aborted, true)
  await answerFive(session); assert.equal(session.snapshot.stage, 'results'); voice.end()
})

test('recorded answers can be edited before sending and recording never auto-submits', async () => {
  let microphone
  class Recognition { constructor() { microphone = this } start() {} stop() { this.onend?.() } abort() {} }
  const { session, calls } = harness(); const voice = new VoiceSession({ webkitSpeechRecognition: Recognition }, session.setDraft)
  await session.start(setup); voice.open(); voice.listen('')
  microphone.onresult({ results: [[{ transcript: 'A recognised answer' }]] }); voice.finishListening()
  assert.equal(session.snapshot.draft, 'A recognised answer'); assert.equal(calls.length, 1); assert.equal(session.snapshot.answers.length, 0)
  session.setDraft('A corrected answer'); voice.end(); await session.submitAnswer(0)
  assert.equal(session.snapshot.answers[0], 'A corrected answer'); assert.equal(calls.length, 1)
})

test('new questions cancel the previous question and replay does not call the interview API', async () => {
  const spoken = []; let cancels = 0
  class Utterance { constructor(text) { this.text = text } }
  const { session, calls } = harness()
  const voice = new VoiceSession({ SpeechSynthesisUtterance: Utterance, speechSynthesis: { speak: value => spoken.push(value), getVoices: () => [], cancel: () => { cancels++ } } }, session.setDraft)
  await session.start(setup); voice.open(); voice.speak(questions[0]); voice.speak(questions[0])
  assert.equal(cancels, 1); assert.equal(calls.length, 1)
  voice.end(); session.setDraft('A relevant answer'); await session.submitAnswer(0); voice.open(); voice.speak(questions[1])
  assert.equal(spoken.at(-1).text, questions[1]); assert.equal(cancels, 2)
  voice.end(); assert.equal(cancels, 3)
})

test('drafts are bounded, reset clears all content, and subscribers observe progression', async () => {
  const { session } = harness(); let updates = 0; const unsubscribe = session.subscribe(() => { updates++ })
  await session.start(setup); session.setDraft('x'.repeat(3000)); assert.equal(session.snapshot.draft.length, 2000)
  await answerFive(session); session.reset()
  assert.equal(session.snapshot.answers.length, 0); assert.equal(session.snapshot.interviewToken, ''); assert.equal(session.snapshot.evaluation, null)
  assert.ok(updates > 10); unsubscribe()
})
