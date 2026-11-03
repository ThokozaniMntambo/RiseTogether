import test from 'node:test'
import assert from 'node:assert/strict'
import { RealtimeInterview } from '../src/realtimeInterview.ts'

const setup = { jobTitle: 'Developer', company: '', interviewType: 'Technical' }
function harness({ permission, blockedPlayback = false, create } = {}) {
  const calls = [], sent = []
  const track = { enabled: true, stopped: false, stop() { this.stopped = true }, onended: null }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  let peer, player
  class Peer {
    constructor() { peer = this; this.connectionState = 'new' }
    addTrack() {}
    createDataChannel() { this.channel = { readyState: 'open', send: e => sent.push(JSON.parse(e)), close() { this.readyState = 'closed'; this.onclose?.() } }; return this.channel }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nmock-offer' } }
    async setLocalDescription(offer) { this.localDescription = offer }
    async setRemoteDescription(answer) { this.answer = answer; this.channel.onopen() }
    close() { this.closed = true; this.connectionState = 'closed'; this.onconnectionstatechange?.() }
  }
  globalThis.window = { isSecureContext: true, RTCPeerConnection: Peer }
  globalThis.RTCPeerConnection = Peer
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: permission || (async () => stream) } } })
  globalThis.Audio = class { constructor() { player = this } async play() { if (blockedPlayback) throw new Error('blocked') } pause() { this.paused = true } load() {} removeAttribute() {} }
  const http = { defaults: { baseURL: '/api' }, post: async (path, body) => {
    calls.push({ path, body })
    if (path.endsWith('/sessions')) return create ? create() : { data: { id: 'owned-session', sdp: 'v=0 answer', expiresAt: Date.now() + 600000 } }
    if (path.endsWith('/feedback')) return { data: { evaluation: null, transcript: [], incomplete: true } }
    return { data: {} }
  } }
  return { session: new RealtimeInterview(http), calls, sent, track, stream, get peer() { return peer }, get player() { return player } }
}
test('live WebRTC requests the first response once, accepts continuous turns, captions events and releases resources', async () => {
  const h = harness()
  await h.session.start(setup, 'marin')
  assert.deepEqual(h.sent, [{ type: 'response.create' }])
  assert.equal(h.peer.answer.type, 'answer')
  h.session.event({ type: 'output_audio_buffer.started' }); assert.equal(h.session.getSnapshot().phase, 'Speaking')
  h.session.event({ type: 'input_audio_buffer.speech_started' }); assert.equal(h.session.getSnapshot().phase, 'Listening')
  h.session.event({ type: 'response.output_audio_transcript.delta', item_id: 'q', delta: 'How are ' })
  h.session.event({ type: 'response.output_audio_transcript.done', item_id: 'q', transcript: 'How are you?' })
  h.session.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Feeling ready.' })
  assert.equal(h.session.getSnapshot().captions.length, 2)
  assert.equal(h.session.getSnapshot().captions[1].text, 'Feeling ready.')
  assert.equal(h.calls.length, 1, 'spoken answers never call a submit endpoint')
  h.session.toggleMic(); assert.equal(h.track.enabled, false)
  h.session.toggleMic(); assert.equal(h.track.enabled, true)
  h.session.toggleSpeaker(); assert.equal(h.player.muted, true)
  await h.session.finish(); await h.session.finish()
  assert.equal(h.track.stopped, true); assert.equal(h.peer.closed, true); assert.equal(h.player.paused, true)
  assert.equal(h.session.getSnapshot().phase, 'Ended')
  assert.equal(h.calls.filter(c => c.path.endsWith('/end')).length, 1)
  await h.session.feedback(); assert.ok(h.calls.at(-1).path.endsWith('/feedback'))
})
test('microphone denial and unsupported browser explain Text Mode fallback without creating a call', async () => {
  const h = harness({ permission: async () => { throw new DOMException('Denied', 'NotAllowedError') } })
  await h.session.start(setup, 'marin'); assert.match(h.session.getSnapshot().error, /permission was denied/); assert.equal(h.calls.length, 0)
  const h2 = harness(); window.isSecureContext = false
  await h2.session.start(setup, 'marin'); assert.match(h2.session.getSnapshot().error, /Text Mode/); assert.equal(h2.calls.length, 0)
})
test('navigation while microphone permission is pending stops late tracks', async () => {
  let resolve
  const h = harness({ permission: () => new Promise(r => { resolve = r }) })
  const starting = h.session.start(setup, 'cedar'); h.session.dispose(); resolve(h.stream); await starting
  assert.equal(h.track.stopped, true); assert.equal(h.calls.length, 0)
})
test('late session creation after End Interview is closed without attaching remote audio', async () => {
  let resolve
  const h = harness({ create: () => new Promise(r => { resolve = r }) })
  const starting = h.session.start(setup, 'marin')
  while (!resolve) await new Promise(r => setTimeout(r, 0))
  await h.session.finish(); resolve({ data: { id: 'late', sdp: 'answer' } }); await starting
  assert.ok(h.calls.some(c => c.path.endsWith('/late/end'))); assert.equal(h.peer.answer, undefined)
})
test('blocked playback is visible and provider error cleans up microphone', async () => {
  const h = harness({ blockedPlayback: true }); await h.session.start(setup, 'marin')
  await h.session.resumePlayback(); assert.equal(h.session.getSnapshot().playbackBlocked, true)
  h.session.event({ type: 'error' }); assert.equal(h.track.stopped, true); assert.equal(h.session.getSnapshot().phase, 'Ended')
})

test('session creation rejection displays Unavailable, retains the safe server reason and releases media', async () => {
  const h = harness({ create: async () => { throw { response: { status: 503, data: { code: 'VOICE_DISABLED', message: 'Live voice is disabled on this server. Text Mode is available.' } } } } })
  await h.session.start(setup, 'marin')
  assert.equal(h.session.getSnapshot().phase, 'Unavailable')
  assert.match(h.session.getSnapshot().error, /disabled on this server/)
  assert.equal(h.track.stopped, true); assert.equal(h.peer.closed, true)
  assert.equal(h.sent.length, 0)
})

test('one-minute warning fires once near expiry and End Interview clears its timer', async t => {
  const h = harness();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() })
  await h.session.start(setup, 'marin')
  // Stop heartbeat polling in this timer-only unit test without ending media.
  clearInterval(h.session.heartbeat)
  t.mock.timers.tick(539999); assert.equal(h.session.getSnapshot().oneMinuteWarning, false)
  t.mock.timers.tick(1); assert.equal(h.session.getSnapshot().oneMinuteWarning, true)
  assert.equal(h.track.stopped, false)
  await h.session.finish(); assert.equal(h.track.stopped, true)
})
