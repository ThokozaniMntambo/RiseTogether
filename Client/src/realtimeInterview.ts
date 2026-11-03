import type { AxiosInstance } from 'axios'
import type { InterviewSetup } from './interviewSession'

export type LivePhase = 'Connecting' | 'Listening' | 'Thinking' | 'Speaking' | 'Reconnecting' | 'Ended' | 'Unavailable'
export type Caption = { id: string; role: 'candidate' | 'interviewer'; text: string }
export type VoiceReport = { evaluation: null | { overallScore: number | null; communicationClarity: number | null; answerRelevance: number | null; competency: number | null; evidenceSummary: string; strengths: string[]; improvements: string[]; recommendations: string[] }; message?: string; incomplete: boolean; transcript: Caption[] }
const path = '/ai/interview-coach/realtime/sessions'

export class RealtimeInterview {
  private http: AxiosInstance
  constructor(http: AxiosInstance) { this.http = http }
  private peer?: RTCPeerConnection
  private stream?: MediaStream
  private channel?: RTCDataChannel
  private player?: HTMLAudioElement
  private heartbeat?: ReturnType<typeof setInterval>
  private deadline?: ReturnType<typeof setTimeout>
  private disconnectTimer?: ReturnType<typeof setTimeout>
  private warningTimer?: ReturnType<typeof setTimeout>
  private id?: string
  private cancelled = false
  private ending = false
  private connected = false
  private controller = new AbortController()
  private listeners = new Set<() => void>()
  private snapshot = { phase: 'Connecting' as LivePhase, error: '', muted: false, speakerMuted: false, captions: [] as Caption[], expiresAt: 0, playbackBlocked: false, oneMinuteWarning: false, endReason: '' }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot = () => this.snapshot
  private update(data: Partial<typeof this.snapshot>) { this.snapshot = { ...this.snapshot, ...data }; this.listeners.forEach(fn => fn()) }
  private send(event: object) { if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(event)) }
  async start(setup: InterviewSetup, voice: string) {
    this.cancelled = false
    this.controller = new AbortController()
    this.update({ phase: 'Connecting' })
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error('This browser cannot run a live audio interview. Use HTTPS and a WebRTC browser, or select Text Mode.')
      this.player = new Audio(); this.player.autoplay = true
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      if (this.cancelled) { stream.getTracks().forEach(t => t.stop()); return }
      this.stream = stream
      const peer = new RTCPeerConnection(); this.peer = peer
      stream.getTracks().forEach(track => { track.enabled = !this.snapshot.muted; peer.addTrack(track, stream); track.onended = () => { if (!this.ending && !this.cancelled) void this.fail('Microphone disconnected. Your interview has ended.') } })
      peer.ontrack = e => { if (this.player) { this.player.srcObject = e.streams[0] || new MediaStream([e.track]); void this.resumePlayback() } }
      peer.onconnectionstatechange = () => {
        if (this.ending || this.cancelled) return
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') void this.fail('Audio connection lost. You can review available feedback or return to Text Mode.')
        if (peer.connectionState === 'disconnected') {
          clearTimeout(this.disconnectTimer)
          this.update({ phase: 'Reconnecting' }); this.disconnectTimer = setTimeout(() => void this.fail('Audio reconnection timed out.'), 10000)
        }
        if (peer.connectionState === 'connected') { clearTimeout(this.disconnectTimer); this.update({ phase: 'Listening' }) }
      }
      const channel = peer.createDataChannel('oai-events'); this.channel = channel
      channel.onmessage = e => { try { this.event(JSON.parse(e.data)) } catch { /* Ignore malformed remote events. */ } }
      channel.onopen = () => {
        this.connected = true
        clearTimeout(this.deadline)
        this.update({ phase: 'Thinking' })
        // First response uses the server-owned interview instructions.
        this.send({ type: 'response.create' })
        this.deadline = setTimeout(() => { this.update({ endReason: 'Session time limit reached' }); void this.finish() }, Math.max(1, this.snapshot.expiresAt - Date.now()))
      }
      channel.onclose = () => { if (!this.cancelled && !this.ending) void this.fail('Voice connection closed.') }
      await peer.setLocalDescription(await peer.createOffer())
      this.deadline = setTimeout(() => void this.fail('Voice connection timed out. Please try Text Mode.'), 25000)
      // Do not abort creation on unmount: receive the call ID and close any late-created call.
      const { data } = await this.http.post(path, { setup, sdp: peer.localDescription?.sdp, voice }, { timeout: 25000 })
      this.id = data.id
      if (this.cancelled || this.ending) { await this.http.post(`${path}/${data.id}/end`); return }
      this.update({ expiresAt: data.expiresAt })
      this.warningTimer = setTimeout(() => this.update({ oneMinuteWarning: true }), Math.max(1, data.expiresAt - Date.now() - 60000))
      await peer.setRemoteDescription({ type: 'answer', sdp: data.sdp })
      this.heartbeat = setInterval(() => { void this.poll() }, 5000)
    } catch (e) {
      if (this.cancelled || this.ending) return
      const message = e instanceof DOMException && e.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow microphone access and try again, or use Text Mode.'
        : e instanceof Error && !('isAxiosError' in e) ? e.message : (e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Unable to reach the interview server. Please use Text Mode.'
      await this.fail(message)
    }
  }
  private async poll() {
    if (!this.id || this.ending || this.cancelled) return
    try {
      const { data } = await this.http.post(`${path}/${this.id}/heartbeat`, {}, { signal: this.controller.signal, timeout: 8000 })
      if (data.oneMinuteWarning) this.update({ oneMinuteWarning: true })
      if (data.ended) {
        this.update({ endReason: data.reason || 'Interview ended' })
        if (data.failure?.message) this.update({ error: data.failure.message })
        await this.finish()
      }
    } catch { if (!this.ending && !this.cancelled) await this.fail('Connection to the interview server was lost. Your microphone has been released.') }
  }
  // WebRTC + interrupt_response handles cancellation, buffer clearing and context truncation at the provider.
  event(e: { type: string; item_id?: string; transcript?: string; delta?: string }) {
    if (this.ending || this.cancelled) return
    if (e.type === 'input_audio_buffer.speech_started') this.update({ phase: 'Listening' })
    if (e.type === 'input_audio_buffer.speech_stopped' || e.type === 'response.created') this.update({ phase: 'Thinking' })
    if (e.type === 'output_audio_buffer.started') this.update({ phase: 'Speaking' })
    if (e.type === 'output_audio_buffer.stopped' || e.type === 'output_audio_buffer.cleared') this.update({ phase: 'Listening' })
    if (e.type === 'error') { void this.fail('The voice provider encountered an error. Please use Text Mode.'); return }
    const candidate = e.type === 'conversation.item.input_audio_transcription.completed'
    const assistant = ['response.output_audio_transcript.delta', 'response.output_audio_transcript.done'].includes(e.type)
    if ((candidate || assistant) && e.item_id) {
      const captions = [...this.snapshot.captions]
      const index = captions.findIndex(c => c.id === e.item_id)
      const previous = index >= 0 ? captions[index].text : ''
      const caption: Caption = { id: e.item_id, role: candidate ? 'candidate' : 'interviewer', text: e.transcript ?? (previous + (e.delta || '')) }
      if (index >= 0) captions[index] = caption; else captions.push(caption)
      this.update({ captions: captions.slice(-200) })
    }
  }
  toggleMic() { const muted = !this.snapshot.muted; this.stream?.getAudioTracks().forEach(t => { t.enabled = !muted }); this.update({ muted }) }
  toggleSpeaker() { const speakerMuted = !this.snapshot.speakerMuted; if (this.player) this.player.muted = speakerMuted; this.update({ speakerMuted }) }
  async resumePlayback() {
    try { await this.player?.play(); this.update({ playbackBlocked: false }) }
    catch { this.update({ playbackBlocked: true }) }
  }
  private cleanup() {
    clearInterval(this.heartbeat); clearTimeout(this.deadline); clearTimeout(this.disconnectTimer); clearTimeout(this.warningTimer)
    this.stream?.getTracks().forEach(t => { t.onended = null; t.stop() }); this.stream = undefined
    this.channel?.close(); this.peer?.close()
    if (this.player) { this.player.pause(); this.player.srcObject = null; this.player.removeAttribute('src'); this.player.load() }
    this.update({ phase: !this.connected && this.snapshot.error ? 'Unavailable' : 'Ended' })
  }
  private async fail(error: string) { this.update({ error }); await this.finish() }
  async finish() {
    if (this.ending) return
    this.ending = true; this.cleanup()
    if (this.id) { try { await this.http.post(`${path}/${this.id}/end`, {}, { timeout: 15000 }) } catch { this.update({ error: this.snapshot.error || 'Server cleanup could not be confirmed. The server timeout still applies.' }) } }
  }
  async feedback(): Promise<VoiceReport> {
    if (!this.id) return { evaluation: null, message: 'No interview conversation is available to evaluate.', incomplete: true, transcript: [] }
    return (await this.http.post(`${path}/${this.id}/feedback`, {}, { timeout: 60000 })).data
  }
  dispose = () => {
    this.cancelled = true; this.controller.abort(); this.cleanup()
    if (this.id) {
      // keepalive survives navigation and uses the existing HttpOnly authentication cookie.
      void fetch(`${this.http.defaults.baseURL}${path}/${this.id}/end`, { method: 'POST', credentials: 'include', keepalive: true }).catch(() => {})
    }
  }
}
