// Browser-only audio. This module never uploads audio or calls a paid API.
export type VoicePhase = 'Ready' | 'Listening' | 'Speaking' | 'Error'
type RecognitionEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> }
export type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void; stop(): void; abort(): void
}
export type VoiceBrowser = {
  SpeechRecognition?: new () => Recognition
  webkitSpeechRecognition?: new () => Recognition
  speechSynthesis?: Pick<SpeechSynthesis, 'getVoices' | 'speak' | 'cancel'>
  SpeechSynthesisUtterance?: new (text: string) => SpeechSynthesisUtterance
}
type Snapshot = { active: boolean; phase: VoicePhase; error: string; muted: boolean }

const recognitionErrors: Record<string, string> = {
  'not-allowed': 'Microphone permission was denied. Allow the microphone in your browser settings or type your question below.',
  'service-not-allowed': 'Speech recognition is blocked by this browser. You can type your question below.',
  'audio-capture': 'No microphone is available. Check your microphone or type your question below.',
  'no-speech': 'No speech was detected. Try Speak again or type your question below.',
  'network': 'The browser speech service could not connect. Your transcript is kept; you can edit or type it below.',
  'language-not-supported': 'English speech recognition is unavailable on this device. Please type your question below.',
}

export function voiceMessage(message: string) {
  const instruction = '\n\nPlease answer conversationally in under 100 words, with one practical next step.'
  return message.length + instruction.length <= 2000 ? message + instruction : message
}

export function englishVoice(voices: SpeechSynthesisVoice[]) {
  return voices.filter(voice => /^en(?:-|$)/i.test(voice.lang)).sort((a, b) => {
    const score = (voice: SpeechSynthesisVoice) => Number(/natural|neural|premium/i.test(voice.name)) * 4 + Number(/^en-ZA$/i.test(voice.lang)) * 2 + Number(Boolean(voice.default))
    return score(b) - score(a)
  })[0]
}

export class VoiceSession {
  browser: VoiceBrowser
  onTranscript: (value: string) => void
  snapshot: Snapshot = { active: false, phase: 'Ready', error: '', muted: false }
  listeners = new Set<() => void>()
  recognition: Recognition | null = null
  utterance: SpeechSynthesisUtterance | null = null
  timer: ReturnType<typeof setTimeout> | undefined
  speechTimer: ReturnType<typeof setTimeout> | undefined
  generation = 0
  audioGeneration = 0
  constructor(browser: VoiceBrowser, onTranscript: (value: string) => void) {
    this.browser = browser
    this.onTranscript = onTranscript
  }
  get recognitionSupported() { return Boolean(this.browser.SpeechRecognition || this.browser.webkitSpeechRecognition) }
  get synthesisSupported() { return Boolean(this.browser.speechSynthesis && this.browser.SpeechSynthesisUtterance) }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  update(value: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...value }
    this.listeners.forEach(listener => listener())
  }
  open() { this.generation++; this.update({ active: true, phase: 'Ready', error: '' }) }
  stopRecognition() {
    clearTimeout(this.timer)
    const recognition = this.recognition
    this.recognition = null
    if (recognition) {
      recognition.onresult = recognition.onerror = recognition.onend = null
      try { recognition.abort() } catch { /* Already stopped. */ }
    }
  }
  stopSpeech() {
    this.audioGeneration++
    clearTimeout(this.speechTimer)
    if (this.utterance) {
      this.utterance.onend = this.utterance.onerror = null
      this.utterance = null
      try { this.browser.speechSynthesis?.cancel() } catch { /* Playback may already be unavailable. */ }
    }
    if (this.snapshot.phase === 'Speaking') this.update({ phase: 'Ready' })
  }
  end = () => {
    this.generation++
    this.stopRecognition()
    this.stopSpeech()
    this.update({ active: false, phase: 'Ready', error: '' })
  }
  toggleMute() {
    this.stopSpeech()
    this.update({ muted: !this.snapshot.muted })
  }
  listen(draft: string) {
    if (!this.snapshot.active || this.recognition) return
    this.stopSpeech()
    const Constructor = this.browser.SpeechRecognition || this.browser.webkitSpeechRecognition
    if (!Constructor) return this.update({ phase: 'Error', error: 'Speech recognition is unavailable. Type your question below.' })
    try {
      const recognition = new Constructor()
      this.recognition = recognition
      recognition.lang = 'en-ZA'
      recognition.continuous = false
      recognition.interimResults = true
      recognition.maxAlternatives = 1
      const base = draft.trim()
      let heard = false
      recognition.onresult = event => {
        if (this.recognition !== recognition) return
        const words = Array.from(event.results, result => result[0]?.transcript || '').join(' ').trim()
        if (words) { heard = true; this.onTranscript([base, words].filter(Boolean).join(' ').slice(0, 2000)) }
      }
      recognition.onerror = event => {
        if (this.recognition !== recognition) return
        this.stopRecognition()
        this.update({ phase: 'Error', error: recognitionErrors[event.error] || 'Speech recognition stopped. Your transcript is kept. Try again or type below.' })
      }
      recognition.onend = () => {
        if (this.recognition !== recognition) return
        this.stopRecognition()
        this.update({ phase: heard ? 'Ready' : 'Error', error: heard ? '' : recognitionErrors['no-speech'] })
      }
      this.update({ phase: 'Listening', error: '' })
      recognition.start()
      // Never leave a microphone running indefinitely if a browser misses onend.
      this.timer = setTimeout(() => {
        this.stopRecognition()
        this.update({ phase: 'Ready' })
      }, 30000)
    } catch {
      this.stopRecognition()
      this.update({ phase: 'Error', error: 'The microphone could not start. Check browser permissions or type your question below.' })
    }
  }
  finishListening() {
    try { this.recognition?.stop() } catch { this.stopRecognition(); this.update({ phase: 'Ready' }) }
  }
  speak(text: string, generation = this.generation) {
    if (!this.snapshot.active || generation !== this.generation || this.snapshot.muted) return
    this.stopRecognition()
    this.stopSpeech()
    const synth = this.browser.speechSynthesis
    const Utterance = this.browser.SpeechSynthesisUtterance
    if (!synth || !Utterance) return this.update({ phase: 'Error', error: 'Speech playback is unavailable. Read the coach response in the chat.' })
    const audioGeneration = this.audioGeneration
    // Short chunks avoid long-utterance truncation in some browser engines.
    const chunks = text.match(/.{1,220}(?:\s|$)|\S{1,220}/gs) || []
    let index = 0
    const fail = () => {
      this.stopSpeech()
      this.update({ phase: 'Error', error: 'Speech playback stopped. Read the reply or select Replay response to try again.' })
    }
    const next = () => {
      if (!this.snapshot.active || generation !== this.generation || audioGeneration !== this.audioGeneration) return
      clearTimeout(this.speechTimer)
      if (index >= chunks.length) { this.utterance = null; this.update({ phase: 'Ready' }); return }
      try {
        const utterance = new Utterance(chunks[index++])
        this.utterance = utterance
        utterance.lang = 'en-ZA'
        const voice = englishVoice(synth.getVoices())
        if (voice) { utterance.voice = voice; utterance.lang = voice.lang }
        utterance.rate = 1
        utterance.onend = () => {
          if (this.utterance !== utterance) return
          utterance.onend = utterance.onerror = null
          next()
        }
        utterance.onerror = () => { if (this.utterance === utterance) fail() }
        this.update({ phase: 'Speaking', error: '' })
        synth.speak(utterance)
        this.speechTimer = setTimeout(fail, 30000)
      } catch { fail() }
    }
    next()
  }
}
