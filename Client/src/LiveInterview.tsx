import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Mic, MicOff, Volume2, VolumeX, Square, ShieldCheck } from 'lucide-react'
import { RealtimeInterview } from './realtimeInterview'
import type { VoiceReport } from './realtimeInterview'
import type { InterviewSetup } from './interviewSession'
import { api, errorMessage } from './auth'
import './LiveInterview.css'

export default function LiveInterview({ setup, voice, onBack }: { setup: InterviewSetup; voice: string; onBack: () => void }) {
  const [session] = useState(() => new RealtimeInterview(api))
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const [report, setReport] = useState<VoiceReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [captions, setCaptions] = useState(true)
  useEffect(() => {
    // Defer initialization so React StrictMode's probe cannot acquire a microphone.
    const timer = setTimeout(() => void session.start(setup, voice), 0)
    const leave = () => session.dispose()
    window.addEventListener('pagehide', leave)
    return () => { clearTimeout(timer); window.removeEventListener('pagehide', leave); session.dispose() }
  }, [session, setup, voice])
  const feedback = useCallback(async () => {
    setBusy(true); setError('')
    try { setReport(await session.feedback()) } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }, [session])
  useEffect(() => {
    if (state.phase !== 'Ended' || !state.expiresAt) return
    const timer = setTimeout(() => void feedback(), 0)
    return () => clearTimeout(timer)
  }, [state.phase, state.expiresAt, feedback])
  const unavailable = state.phase === 'Unavailable'
  const ended = state.phase === 'Ended' || unavailable
  return <section className="interview-panel live-interview" aria-label="Live voice interview">
    <div className="interview-progress"><span className="badge">Live Voice Mode</span><span>{setup.interviewType} interview</span></div>
    <h2>{setup.jobTitle}{setup.company && ` at ${setup.company}`}</h2>
    <div className={`live-avatar ${state.phase === 'Speaking' ? 'is-speaking' : ''}`} aria-hidden="true">A</div>
    <h3>Alex <small>AI interviewer</small></h3>
    <div className={`live-wave ${state.phase === 'Speaking' || state.phase === 'Listening' ? 'is-active' : ''}`} aria-hidden="true">{Array.from({ length: 19 }, (_, i) => <i key={i} style={{ animationDelay: `${i * .07}s` }}/>)}</div>
    <p role="status" aria-live="polite" className="live-status">{state.phase}{state.muted && !ended ? ' · Microphone muted' : ''}</p>
    {!ended && state.expiresAt > 0 && <p className="interview-note">Session ends by {new Date(state.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Speak naturally; you can interrupt Alex.</p>}
    {!ended && state.oneMinuteWarning && <p className="warning live-time-warning" role="status" aria-live="polite">One minute remaining. Finish your current answer; the interview will end automatically.</p>}
    {(state.error || error) && <p className="error" role="alert">{state.error || error}</p>}
    {state.playbackBlocked && !ended && <button className="btn" onClick={() => void session.resumePlayback()}>Enable interview audio</button>}
    {!ended && <div className="live-controls">
      <button className="voice-control" onClick={() => session.toggleMic()} aria-pressed={state.muted}>{state.muted ? <MicOff size={18}/> : <Mic size={18}/>}{state.muted ? 'Unmute microphone' : 'Mute microphone'}</button>
      <button className="voice-control" onClick={() => session.toggleSpeaker()} aria-pressed={state.speakerMuted}>{state.speakerMuted ? <VolumeX size={18}/> : <Volume2 size={18}/>}{state.speakerMuted ? 'Unmute speaker' : 'Mute speaker'}</button>
      <button className="voice-control live-end" onClick={() => void session.finish()}><Square size={17}/>End Interview</button>
    </div>}
    <label className="live-caption-toggle"><input type="checkbox" checked={captions} onChange={e => setCaptions(e.target.checked)}/>Show live captions</label>
    {captions && <div className="live-captions" role="log" aria-label="Interview captions" aria-live="off">{(report?.transcript || state.captions).map((c, i) => <p key={`${c.id}-${i}`}><strong>{c.role === 'candidate' ? 'You' : 'Alex'}:</strong> {c.text}</p>)}{!state.captions.length && <p>Your conversation captions will appear here.</p>}</div>}
    <p className="interview-note">Captions may be incomplete or inaccurate. Interrupted speech may appear in captions even if you did not hear it all.</p>
    {ended && <div className="live-report">
      {state.endReason && <p role="status">{state.endReason}</p>}
      {unavailable && <p>No live interview was started. Return to setup to use Text Mode.</p>}
      {busy && <p role="status">Preparing feedback from the available conversation…</p>}
      {report?.message && <p>{report.message}</p>}
      {report?.evaluation && <><h2>Your interview feedback</h2><p>Overall score: <strong>{report.evaluation.overallScore === null ? 'Insufficient evidence' : `${report.evaluation.overallScore}/100`}</strong></p><p>{report.evaluation.evidenceSummary}</p>
        <dl className="live-scores">{([['Communication clarity', report.evaluation.communicationClarity], ['Answer relevance', report.evaluation.answerRelevance], ['Role competency', report.evaluation.competency]] as const).map(([label, score]) => <div key={label}><dt>{label}</dt><dd>{score === null ? 'Insufficient evidence' : `${score}/100`}</dd></div>)}</dl>
        {([['Strengths', report.evaluation.strengths], ['Areas for improvement', report.evaluation.improvements], ['Personalised recommendations', report.evaluation.recommendations]] as [string, string[]][]).map(([label, items]) => <div key={label}><h3>{label}</h3><ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul></div>)}
        <p className="interview-note">Practice feedback assesses answer content, never accent, vocal characteristics or protected traits.</p></>}
      {report?.incomplete && <p className="interview-note">This report uses a partial transcript; missing answers have not been invented.</p>}
      {!unavailable && !busy && !report && <button className="btn" onClick={() => void feedback()}>Retry feedback</button>}
      <button className="voice-control" onClick={onBack}>Return to setup / Text Mode</button>
    </div>}
    <div className="interview-privacy"><ShieldCheck size={20}/><p>Live audio is sent to OpenAI. RiseTogether does not record or store raw audio. Captions and feedback stay on this page; the server holds the transcript in memory for up to 15 minutes after the call for feedback, then clears it. Leaving clears this page. OpenAI processes data under its API data policies.</p></div>
  </section>
}
