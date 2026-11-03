import test from 'node:test'
import assert from 'node:assert/strict'
import { VoiceSession, englishVoice, voiceMessage } from '../src/voice.ts'

function harness(options = {}) {
  const recognizers = [], spoken = [], transcripts = []
  let cancellations = 0
  class Recognition {
    start() { this.started = true; if (options.startError) throw new Error('permission') }
    stop() { this.stopped = true; this.onend?.() }
    abort() { this.aborted = true }
    constructor() { recognizers.push(this) }
    result(...words) { this.onresult?.({ results: words.map(transcript => [{ transcript }]) }) }
    error(error) { this.onerror?.({ error }) }
  }
  class Utterance { constructor(text) { this.text = text } }
  const browser = {
    [options.prefixed ? 'webkitSpeechRecognition' : 'SpeechRecognition']: Recognition,
    SpeechSynthesisUtterance: Utterance,
    speechSynthesis: { getVoices: () => [], speak: utterance => { if (options.speakError) throw new Error('blocked'); spoken.push(utterance) }, cancel: () => { cancellations++ } },
  }
  const session = new VoiceSession(browser, value => transcripts.push(value))
  return { session, browser, recognizers, spoken, transcripts, get cancellations() { return cancellations } }
}

test('opening voice mode requests no microphone and closing is repeatable', () => {
  const h = harness()
  h.session.open()
  assert.equal(h.session.snapshot.phase, 'Ready')
  assert.equal(h.recognizers.length, 0)
  h.session.end(); h.session.open(); h.session.end()
  assert.equal(h.session.snapshot.active, false)
})

for (const prefixed of [false, true]) {
  test(`push-to-talk supports ${prefixed ? 'prefixed' : 'standard'} recognition and never auto-restarts`, () => {
    const h = harness({ prefixed })
    h.session.open(); h.session.listen('My question:')
    h.session.listen('duplicate')
    assert.equal(h.recognizers.length, 1)
    const mic = h.recognizers[0]
    assert.equal(mic.lang, 'en-ZA')
    assert.equal(mic.continuous, false)
    assert.equal(h.session.snapshot.phase, 'Listening')
    mic.result('Which skills'); mic.result('Which skills should I build?')
    assert.equal(h.transcripts.at(-1), 'My question: Which skills should I build?')
    h.session.finishListening()
    assert.equal(h.session.snapshot.phase, 'Ready')
    assert.equal(mic.aborted, true)
    assert.equal(h.recognizers.length, 1)
    h.session.end()
  })
}

test('transcripts respect the existing 2000-character API limit', () => {
  const h = harness(); h.session.open(); h.session.listen('')
  h.recognizers[0].result('x'.repeat(3000))
  assert.equal(h.transcripts[0].length, 2000)
  h.session.end()
})

for (const reason of ['not-allowed', 'service-not-allowed', 'audio-capture', 'no-speech', 'network', 'language-not-supported', 'unknown']) {
  test(`recognition error ${reason} releases microphone and retains transcript`, () => {
    const h = harness(); h.session.open(); h.session.listen('')
    h.recognizers[0].result('Explore careers')
    h.recognizers[0].error(reason)
    assert.equal(h.session.snapshot.phase, 'Error')
    assert.ok(h.session.snapshot.error)
    assert.equal(h.recognizers[0].aborted, true)
    assert.equal(h.transcripts.at(-1), 'Explore careers')
    h.session.end()
  })
}

test('a synchronous microphone failure and an empty recording have useful fallbacks', () => {
  const h = harness({ startError: true }); h.session.open(); h.session.listen('')
  assert.equal(h.session.snapshot.phase, 'Error')
  assert.equal(h.recognizers[0].aborted, true)
  const other = harness(); other.session.open(); other.session.listen(''); other.session.finishListening()
  assert.match(other.session.snapshot.error, /No speech/)
  h.session.end(); other.session.end()
})

test('unsupported browser retains typed-input fallback and reports unavailable playback', () => {
  const session = new VoiceSession({}, () => assert.fail('Unexpected transcript'))
  session.open(); session.listen('Typed question')
  assert.equal(session.recognitionSupported, false)
  assert.match(session.snapshot.error, /Type your question/)
  session.speak('Read this reply')
  assert.equal(session.synthesisSupported, false)
  assert.match(session.snapshot.error, /Read the coach response/)
  session.end()
})

test('speech playback finishes, replays and cancels before microphone starts', () => {
  const h = harness(); h.session.open(); h.session.speak('A small next step.')
  assert.equal(h.session.snapshot.phase, 'Speaking')
  h.spoken[0].onend()
  assert.equal(h.session.snapshot.phase, 'Ready')
  h.session.speak('A small next step.')
  h.session.listen('')
  assert.equal(h.cancellations, 1)
  assert.equal(h.session.snapshot.phase, 'Listening')
  assert.equal(h.spoken[1].onend, null)
  h.session.end()
})

test('stop, mute and end prevent overlap and ignore late responses from ended sessions', () => {
  const h = harness(); h.session.open()
  const generation = h.session.generation
  h.session.speak('First'); h.session.speak('Second')
  assert.equal(h.cancellations, 1)
  h.session.toggleMute()
  assert.equal(h.cancellations, 2)
  h.session.speak('Muted')
  assert.equal(h.spoken.length, 2)
  h.session.toggleMute(); h.session.speak('Third'); h.session.end()
  assert.equal(h.cancellations, 3)
  h.session.open(); h.session.speak('Late response', generation)
  assert.equal(h.spoken.length, 3)
  h.session.end()
})

test('late microphone callbacks after navigation cannot change a transcript', () => {
  const h = harness(); h.session.open(); h.session.listen('')
  const result = h.recognizers[0].onresult
  h.session.end()
  result({ results: [[{ transcript: 'Late words' }]] })
  assert.deepEqual(h.transcripts, [])
  assert.equal(h.recognizers[0].aborted, true)
})

test('long replies play sequential chunks without dropping words', () => {
  const h = harness(); h.session.open()
  const text = 'Build one small portfolio project. '.repeat(30)
  h.session.speak(text)
  let index = 0
  while (h.session.snapshot.phase === 'Speaking' && index < 30) h.spoken[index++].onend()
  assert.equal(h.session.snapshot.phase, 'Ready')
  assert.equal(h.spoken.map(item => item.text).join(''), text)
  assert.ok(h.spoken.every(item => item.text.length <= 221))
  h.session.end()
})

test('playback errors never request recognition or another API response', () => {
  for (const speakError of [false, true]) {
    const h = harness({ speakError }); h.session.open(); h.session.speak('A reply')
    if (!speakError) h.spoken[0].onerror({ error: 'not-allowed' })
    assert.equal(h.session.snapshot.phase, 'Error')
    assert.equal(h.recognizers.length, 0)
    h.session.end()
  }
})

test('natural English voice selection excludes other languages and tolerates delayed voice loading', () => {
  assert.equal(englishVoice([]), undefined)
  const voices = [{ name: 'French Natural', lang: 'fr-FR' }, { name: 'English', lang: 'en-US' }, { name: 'English Natural', lang: 'en-ZA' }]
  assert.equal(englishVoice(voices), voices[2])
})

test('concise voice instruction preserves the full user question within existing request limits', () => {
  const edited = 'I corrected my question: how do I prepare for a first job?'
  assert.ok(voiceMessage(edited).startsWith(edited))
  assert.match(voiceMessage(edited), /under 100 words/)
  assert.equal(voiceMessage('x'.repeat(2000)), 'x'.repeat(2000))
})

test('microphone timeout and speech watchdog release browser resources', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(); h.session.open(); h.session.listen('')
  context.mock.timers.tick(30000)
  assert.equal(h.recognizers[0].aborted, true)
  assert.equal(h.session.snapshot.phase, 'Ready')
  h.session.speak('Reply'); context.mock.timers.tick(30000)
  assert.equal(h.session.snapshot.phase, 'Error')
  assert.equal(h.cancellations, 1)
  h.session.end()
})
