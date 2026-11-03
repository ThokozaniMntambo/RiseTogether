import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, Check, LoaderCircle, MessagesSquare, ShieldCheck } from 'lucide-react'
import { api, useAuth } from './auth'
import { InterviewSession } from './interviewSession'
import type { InterviewSetup } from './interviewSession'
import LiveInterview from './LiveInterview'
import './VoiceMode.css'
import './InterviewCoach.css'

export default function InterviewCoach() {
  const { refresh } = useAuth()
  const [session] = useState(() => new InterviewSession(api))
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const [setup, setSetup] = useState<InterviewSetup>({ jobTitle: '', company: '', interviewType: 'General' })
  const [voiceMode, setVoiceMode] = useState(false)
  const [live, setLive] = useState(false)
  const [selectedVoice, setSelectedVoice] = useState('marin')
  const [confirmEnd, setConfirmEnd] = useState(false)
  const focusTarget = useRef<HTMLHeadingElement>(null)
  const question = state.stage === 'practice' ? state.questions[state.answers.length] : ''
  useEffect(() => () => session.dispose(), [session])
  useEffect(() => { if (state.stage !== 'setup') focusTarget.current?.focus() }, [question, state.stage])

  function start(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (voiceMode) setLive(true); else void session.start(setup) }
  function answer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void session.submitAnswer(state.answers.length)
  }
  function reset() { session.reset(); setConfirmEnd(false) }
  const blocked = state.busy || state.expired || state.unavailable

  if (live) return <div className="interview-page"><h1 className="page-title">AI Interview Coach</h1><LiveInterview setup={setup} voice={selectedVoice} onBack={() => { setLive(false); setVoiceMode(false) }}/></div>

  return <div className="interview-page">
    <span className="eyebrow">PRACTISE TODAY. GROW YOUR CONFIDENCE.</span>
    <h1 className="page-title">AI Interview Coach</h1>
    <p className="page-subtitle">Five questions, room to practise, and practical feedback for your next interview.</p>
    {state.error && <div className="error" role="alert">{state.error}{state.expired && <> <button className="career-inline-button" type="button" onClick={() => void refresh()}>Sign in again</button></>}</div>}

    {state.stage === 'setup' ? <form className="interview-panel interview-setup" onSubmit={start} aria-busy={state.busy}>
      <div className="interview-panel-title"><span className="module-icon orange"><MessagesSquare/></span><div><h2>Make this interview yours</h2><p>Choose a role and how you would like to practise.</p></div></div>
      <label htmlFor="interview-job">Target job title</label>
      <input id="interview-job" required minLength={2} maxLength={120} value={setup.jobTitle} onChange={event => setSetup({ ...setup, jobTitle: event.target.value })} disabled={blocked} placeholder="e.g. Junior software developer"/>
      <label htmlFor="interview-company">Company name <span>Optional</span></label>
      <input id="interview-company" maxLength={120} value={setup.company} onChange={event => setSetup({ ...setup, company: event.target.value })} disabled={blocked} placeholder="A company you would like to join"/>
      <label htmlFor="interview-type">Interview type</label>
      <select id="interview-type" value={setup.interviewType} onChange={event => setSetup({ ...setup, interviewType: event.target.value as InterviewSetup['interviewType'] })} disabled={blocked}><option>General</option><option>Technical</option><option>Behavioural</option></select>
      <fieldset disabled={blocked}><legend>Practice mode</legend><label><input type="radio" name="interview-mode" checked={!voiceMode} onChange={() => setVoiceMode(false)}/>Text Mode</label><label><input type="radio" name="interview-mode" checked={voiceMode} onChange={() => setVoiceMode(true)}/>Voice Mode</label></fieldset>
      <p className="interview-note">Voice Mode is a live conversation with Alex. Starting requests microphone permission and sends live audio to OpenAI. You can speak freely and interrupt; no answer submission is needed. Voice access is limited during rollout. Text Mode is always available.</p>
      {voiceMode && <><label htmlFor="interview-voice">Interviewer voice</label><select id="interview-voice" value={selectedVoice} onChange={e => setSelectedVoice(e.target.value)}><option value="marin">Marin</option><option value="cedar">Cedar</option></select><p className="interview-note">Voice runs for up to ten minutes, with a one-minute warning. Starting reserves the timed session and one feedback request from your shared AI allowance; safety limits may end it earlier. RiseTogether stores no raw audio. The server keeps the transcript in memory for up to 15 minutes after the call to prepare feedback. Avoid sensitive information.</p></>}
      <div className="interview-privacy"><ShieldCheck size={20}/><p>Text Mode generates questions using AI. After five answers, a second AI request evaluates them. Both use your shared AI allowance; feedback may be unavailable if your allowance runs out. Your job details and submitted answers are sent to OpenAI. Do not include sensitive personal information. This interview stays only on this page and is cleared when you leave or refresh.</p></div>
      <button className="btn" disabled={blocked || setup.jobTitle.trim().length < 2}>{state.busy ? <LoaderCircle className="spin" size={18}/> : <ArrowRight size={18}/>} {state.busy ? 'Preparing five questions...' : 'Start interview'}</button>
      {state.busy && <p role="status" className="interview-note">Generating tailored questions. This can take up to a minute.</p>}
    </form> : <>
      <div className="interview-toolbar"><span>{state.setup?.jobTitle}{state.setup?.company && ` at ${state.setup.company}`} <small>{state.setup?.interviewType} interview</small></span><button className="voice-control" type="button" onClick={() => setConfirmEnd(true)} disabled={state.busy}>{state.stage === 'results' ? 'Start another interview' : 'End interview'}</button></div>
      {confirmEnd && <div className="interview-discard" role="group" aria-label="Confirm ending interview"><p>Clear this interview and return to setup? Your answers and feedback will be removed from this page.</p><button className="voice-control" type="button" onClick={reset}>Clear and return to setup</button><button className="voice-control" type="button" onClick={() => setConfirmEnd(false)}>Keep practising</button></div>}

      {state.stage === 'practice' && <section className="interview-panel" aria-label="Interview question">
        <div className="interview-progress"><span role="status">Question {state.answers.length + 1} of 5</span><span>{state.answers.length} answered</span></div>
        <progress value={state.answers.length} max={5} aria-label="Questions answered"/>
        <h2 className="interview-question" tabIndex={-1} ref={focusTarget}>{question}</h2>
        <div className="interview-mode-row"><span className="badge">Text Mode</span></div>
        <form onSubmit={answer} aria-busy={state.busy}>
          <label htmlFor="interview-answer">Your answer</label>
          <textarea id="interview-answer" rows={7} value={state.draft} onChange={event => session.setDraft(event.target.value)} maxLength={2000} disabled={blocked} required aria-describedby="interview-answer-hint" placeholder="Explain your thinking and include a specific example where you can."/>
          <div className="interview-answer-footer"><small id="interview-answer-hint">Review before sending. {state.draft.length.toLocaleString()} / 2,000</small><button className="btn" disabled={blocked || !state.draft.trim()}><Check size={17}/>{state.answers.length === 4 ? 'Submit & get feedback' : 'Submit answer'}</button></div>
        </form>
      </section>}

      {state.stage === 'review' && <section className="interview-panel" aria-busy={state.busy}>
        <h2 tabIndex={-1} ref={focusTarget}>{state.busy ? 'Preparing your interview feedback...' : 'Your five answers are ready'}</h2>
        <p role="status" className="interview-note">{state.busy ? 'Evaluating relevance, clarity, evidence and role knowledge. This can take up to a minute.' : 'Your answers are kept below. Retry evaluation when your shared AI allowance and connection are available.'}</p>
        {state.busy ? <LoaderCircle className="spin" aria-label="Evaluating interview"/> : <button className="btn" disabled={blocked} onClick={() => void session.evaluate()}>Retry evaluation<ArrowRight size={17}/></button>}
      </section>}

      {state.stage === 'results' && state.evaluation && <section className="interview-results" aria-label="Interview results">
        <div className="interview-panel interview-score"><div><span className="eyebrow">PRACTICE COMPLETE</span><h2 tabIndex={-1} ref={focusTarget}>Your interview feedback</h2><p>Scores reflect the content of your answers, not your accent or voice. This is practice guidance, not an employer assessment or hiring prediction.</p></div><div className="interview-score-value"><strong>{state.evaluation.overallScore}<small>/100</small></strong><span>Overall score</span></div></div>
        <div className="interview-feedback-grid">{([
          ['Strengths demonstrated', state.evaluation.strengths], ['Areas for improvement', state.evaluation.improvements], ['Your next practice steps', state.evaluation.recommendations],
        ] as [string, string[]][]).map(([title, items]) => <article className="interview-panel" key={title}><h3>{title}</h3><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></article>)}</div>
      </section>}
      {(state.stage === 'review' || state.stage === 'results') && <section className="interview-answer-review" aria-label="Your answers and feedback">{state.questions.map((item, index) => <article className="interview-panel" key={index}><div className="interview-progress"><span>Question {index + 1} of 5</span>{state.evaluation && <strong>{state.evaluation.answers[index].score}/100</strong>}</div><h3>{item}</h3><h4>Your answer</h4><p className="interview-answer-text">{state.answers[index]}</p>{state.evaluation && <><h4>Coach feedback</h4><p>{state.evaluation.answers[index].feedback}</p></>}</article>)}</section>}
    </>}
  </div>
}
