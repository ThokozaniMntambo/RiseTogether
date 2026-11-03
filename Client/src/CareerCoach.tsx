import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import axios from 'axios'
import { ArrowUpRight, Compass, Leaf, LoaderCircle, Mic, MicOff, Plus, RotateCcw, Send, ShieldCheck, Sparkles, Volume2, VolumeX } from 'lucide-react'
import { api, errorMessage, useAuth } from './auth'
import { VoiceSession, voiceMessage } from './voice'
import type { VoiceBrowser } from './voice'
import './CareerCoach.css'
import './VoiceMode.css'

type Message = { role: 'user' | 'assistant'; content: string }
const starters = [
  { title: 'Find my direction', message: 'I am unsure which career to pursue. Can you help me explore my interests and strengths?' },
  { title: 'Start without experience', message: 'I am an unemployed graduate with little work experience. What practical steps can I take to get started?' },
  { title: 'Build the right skills', message: 'How can I identify useful skills to learn on a limited budget in South Africa?' },
]

// Bound context by the server's entry, character and JSON byte limits.
function recentHistory(messages: Message[], message: string) {
  const history = messages.slice(-10).map(item => ({ ...item, content: item.content.slice(0, 2000) }))
  while (history.length && (history.reduce((sum, item) => sum + item.content.length, message.length) > 10000
    || new TextEncoder().encode(JSON.stringify({ message, history })).length > 14000)) history.shift()
  return history
}

export default function CareerCoach() {
  const { user, refresh } = useAuth()
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [expired, setExpired] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const inFlight = useRef(false)
  const transcript = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const busy = Boolean(pending)
  const [voice] = useState(() => new VoiceSession(window as unknown as VoiceBrowser, setDraft))
  const voiceState = useSyncExternalStore(voice.subscribe, voice.getSnapshot)
  const listening = voiceState.phase === 'Listening'
  const lastReply = messages.filter(message => message.role === 'assistant').at(-1)?.content
  const voiceStatus = busy ? 'Processing' : voiceState.phase !== 'Ready' ? voiceState.phase : error ? 'Error' : 'Ready'

  useEffect(() => {
    const hide = () => { if (document.hidden) voice.end() }
    window.addEventListener('pagehide', voice.end)
    document.addEventListener('visibilitychange', hide)
    return () => {
      voice.end()
      window.removeEventListener('pagehide', voice.end)
      document.removeEventListener('visibilitychange', hide)
    }
  }, [voice])

  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    const region = transcript.current
    if (region) region.scrollTop = region.scrollHeight
  }, [messages, pending])

  function chooseStarter(message: string) {
    setDraft(message)
    composer.current?.focus()
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = draft.trim()
    if (!message || message.length > 2000 || inFlight.current || expired || unavailable || voice.recognition) return
    inFlight.current = true
    const voiceGeneration = voice.snapshot.active ? voice.generation : null
    const requestMessage = voiceGeneration === null ? message : voiceMessage(message)
    voice.stopSpeech()
    voice.update({ phase: 'Ready', error: '' })
    setPending(message); setError('')
    const request = new AbortController()
    controller.current = request
    try {
      const { data } = await api.post<{ reply: string }>('/ai/career-coach', { message: requestMessage, history: recentHistory(messages, requestMessage) }, { timeout: 65000, signal: request.signal })
      if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('Missing coach reply')
      setMessages(previous => [...previous, { role: 'user', content: message }, { role: 'assistant', content: data.reply.trim() }])
      setDraft('')
      if (voiceGeneration !== null) voice.speak(data.reply.trim(), voiceGeneration)
    } catch (failure) {
      if (request.signal.aborted) return
      if (axios.isAxiosError(failure)) {
        if (failure.response?.status === 401) setExpired(true)
        if (['AI_CREDITS_EXHAUSTED', 'AI_CONFIGURATION_ERROR'].includes(failure.response?.data?.code)) setUnavailable(true)
        setError(['ECONNABORTED', 'ETIMEDOUT'].includes(failure.code || '')
          ? 'Your coach took too long to respond. Your message is still below. Wait before sending again; this attempt may count toward your usage limit.'
          : errorMessage(failure))
      } else setError('Your coach could not return a reply. Your message is still below. Please try again later.')
    } finally {
      inFlight.current = false
      if (!request.signal.aborted) {
        setPending('')
        requestAnimationFrame(() => composer.current?.focus())
      }
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  function newConversation() {
    if (inFlight.current) return
    voice.end()
    setMessages([]); setDraft(''); setError('')
    composer.current?.focus()
  }

  return <div className="career-chat-page">
    <div className="career-chat-heading">
      <div><span className="eyebrow">A LITTLE DIRECTION. MORE POSSIBILITY.</span><h1 className="page-title">AI Career Coach</h1><p className="page-subtitle">A space to explore your strengths, your options and your next step.</p></div>
      <span className="career-chat-tag"><Sparkles size={14}/>Personalised AI guidance</span>
    </div>
    <div className="career-chat-grid">
      <section className="career-chat" aria-label="Career Coach chat">
        <header className="career-chat-header">
          <span className="career-coach-avatar"><Compass size={23}/></span>
          <div><h2>Your career coach</h2><p>Built around your next chapter</p></div>
          <button className="career-new-chat" onClick={newConversation} disabled={busy || expired || unavailable} aria-label="Start a new conversation"><Plus size={17}/><span>New chat</span></button>
        </header>
        <div className="career-voice-entry"><button type="button" className="voice-control" onClick={() => { voice.open(); setError('') }} disabled={voiceState.active || busy} aria-expanded={voiceState.active} aria-controls="career-voice-mode"><Mic size={17} aria-hidden="true"/>Voice Mode</button></div>
        {voiceState.active && <section className="voice-mode" id="career-voice-mode" aria-label="Voice Mode">
          <div className="voice-heading"><h3><Mic size={18} aria-hidden="true"/>Voice Mode</h3><span className={`voice-status ${listening ? 'is-listening' : ''}`} role="status" aria-live="polite"><span className="voice-indicator"/>{voiceStatus}</span></div>
          <p id="voice-instructions">Select Speak, then review or edit your transcript in the message box before sending. The microphone stops after each question or 30 seconds.</p>
          <div className="voice-controls">
            <button className="voice-control" type="button" onClick={() => listening ? voice.finishListening() : voice.listen(draft)} disabled={busy || expired || unavailable || !voice.recognitionSupported} aria-describedby="voice-instructions">{listening ? <MicOff size={17}/> : <Mic size={17}/>} {listening ? 'Finish listening' : 'Speak'}</button>
            <button className="voice-control" type="button" onClick={() => voice.toggleMute()} aria-pressed={voiceState.muted} disabled={!voice.synthesisSupported}>{voiceState.muted ? <VolumeX size={17}/> : <Volume2 size={17}/>}Mute speech</button>
            <button className="voice-control" type="button" onClick={() => voice.stopSpeech()} disabled={voiceState.phase !== 'Speaking'}>Stop speech</button>
            <button className="voice-control" type="button" onClick={() => lastReply && voice.speak(lastReply)} disabled={!lastReply || busy || listening || voiceState.muted || !voice.synthesisSupported}><RotateCcw size={16}/>Replay response</button>
            <button className="voice-control voice-end" type="button" onClick={voice.end}>End Voice Session</button>
          </div>
          {!voice.recognitionSupported && <p role="status">This browser does not support speech recognition. Type your question below; you can still hear replies if speech playback is available.</p>}
          {!voice.synthesisSupported && <p role="status">Speech playback is unavailable in this browser. Coach replies will still appear in the chat.</p>}
          {voiceState.error && <p className="error" role="alert">{voiceState.error}</p>}
          <p className="voice-privacy">Your browser may send audio to its speech service. RiseTogether does not record or store audio. Only confirmed text is sent to the coach, using the same AI usage limits.</p>
        </section>}
        <div className="career-transcript" ref={transcript} role="log" aria-label="Career coaching conversation" aria-live="polite" aria-relevant="additions" tabIndex={0}>
          {messages.length === 0 && !busy && <div className="career-chat-welcome">
            <div className="career-welcome-icon"><Sparkles size={30}/></div>
            <span className="eyebrow">YOUR FUTURE HAS ROOM TO GROW</span>
            <h2>You do not need it all<br/>figured out.</h2>
            <p>Hi {user?.name.split(' ')[0] || 'there'}. Start with what is on your mind. Explore career paths, make the most of your skills or find a small step forward.</p>
            <div className="career-starters">{starters.map(starter => <button key={starter.title} type="button" disabled={expired || unavailable} onClick={() => chooseStarter(starter.message)}><span>{starter.title}</span><ArrowUpRight size={17}/></button>)}</div>
            <small>Choose a starting point or write your own question below.</small>
          </div>}
          {messages.map((message, index) => <div className={`career-message ${message.role}`} key={index}>
            <span className="career-message-avatar" aria-hidden="true">{message.role === 'assistant' ? <Compass size={17}/> : user?.name.charAt(0).toUpperCase() || 'Y'}</span>
            <div className="career-message-content"><span className="career-message-name">{message.role === 'assistant' ? 'Career Coach · AI-generated' : 'You'}</span><p>{message.content}</p></div>
          </div>)}
          {busy && <><div className="career-message user"><span className="career-message-avatar" aria-hidden="true">{user?.name.charAt(0).toUpperCase() || 'Y'}</span><div className="career-message-content"><span className="career-message-name">You</span><p>{pending}</p></div></div><div className="career-thinking" role="status"><Compass size={18}/><LoaderCircle size={15} className="spin"/>Your coach is thinking...</div></>}
        </div>
        <div className="career-composer-wrap">
          {error && <div className="error" role="alert">{error}{expired && <> <button className="career-inline-button" onClick={() => void refresh()}>Sign in again</button></>}</div>}
          <form className="career-composer" onSubmit={submit} aria-busy={busy}>
            <label className={voiceState.active ? "voice-transcript-label" : "career-sr-only"} htmlFor="career-message">{voiceState.active ? "Your transcript: review or edit before sending" : "Your message to Career Coach"}</label>
            <textarea ref={composer} id="career-message" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} maxLength={2000} rows={3} disabled={busy || expired || unavailable || listening} placeholder="What would you like to explore about your career?" aria-describedby="career-composer-hint"/>
            <div className="career-composer-actions"><span id="career-composer-hint">{draft.length.toLocaleString()} / 2,000<span className="career-key-hint"> · Enter to send, Shift + Enter for a new line</span></span><button className="btn" type="submit" disabled={!draft.trim() || busy || expired || unavailable || listening} aria-label={busy ? 'Waiting for Career Coach' : 'Send message'}>{busy ? <LoaderCircle className="spin" size={17}/> : <Send size={17}/>}<span>{busy ? 'Thinking' : voiceState.active ? 'Confirm & send' : 'Send'}</span></button></div>
          </form>
          <p className="career-chat-footnote">Messages are shared with OpenAI. Avoid sensitive details. AI can make mistakes; check important information with official sources.</p>
        </div>
      </section>
      <aside className="career-chat-aside" aria-label="Coaching tips">
        <div className="career-tip-card"><span className="module-icon green"><Leaf size={23}/></span><span className="eyebrow">ONE STEP AT A TIME</span><h2>Small questions.<br/>Fresh possibilities.</h2><p>Your next move does not need to be a big leap. We can work through it together.</p><ul><li>Explore careers that interest you</li><li>Recognise your transferable skills</li><li>Find practical ways to get started</li></ul></div>
        <div className="career-privacy-card"><ShieldCheck size={20}/><div><h3>Your conversation, with care.</h3><p>Your message and recent conversation are shared with OpenAI for guidance. Avoid ID numbers, contact details and sensitive information.</p><p>This chat is kept only on this page. Leaving or refreshing clears it. Usage limits apply to each request.</p></div></div>
      </aside>
    </div>
  </div>
}
