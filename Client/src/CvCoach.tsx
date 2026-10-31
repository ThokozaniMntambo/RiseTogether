import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import axios from 'axios'
import { FileText, LoaderCircle, ShieldCheck, Sparkles, ArrowRight } from 'lucide-react'
import { api, errorMessage, useAuth } from './auth'
import './CvCoach.css'

type Analysis = {
  professionalSummary: string
  strengths: string[]
  improvements: string[]
  jobKeywords: string[]
  skillGaps: string[]
  formatting: string[]
  rewrittenBullets: { original: string; suggested: string }[]
  nextSteps: string[]
}

export default function CvCoach() {
  const { refresh } = useAuth()
  const [cv, setCv] = useState(''), [jobDescription, setJobDescription] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [expired, setExpired] = useState(false), [unavailable, setUnavailable] = useState(false)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const inFlight = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const results = useRef<HTMLElement | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => { if (analysis) results.current?.focus() }, [analysis])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current || expired || unavailable) return
    if (cv.trim().length < 100 || cv.length > 18000 || jobDescription.length > 8000) {
      setError('Enter 100 to 18,000 characters of CV text and at most 8,000 characters for the optional job description.'); return
    }
    inFlight.current = true; setBusy(true); setError(''); setAnalysis(null)
    const request = new AbortController()
    controller.current = request
    try {
      const { data } = await api.post<{ analysis: Analysis }>('/ai/cv-coach', { cv: cv.trim(), jobDescription: jobDescription.trim() }, { timeout: 65000, signal: request.signal })
      if (!data.analysis || typeof data.analysis.professionalSummary !== 'string') throw new Error('Missing analysis')
      setAnalysis(data.analysis)
    } catch (failure) {
      if (request.signal.aborted) return
      if (axios.isAxiosError(failure)) {
        if (failure.response?.status === 401) setExpired(true)
        if (['AI_CREDITS_EXHAUSTED', 'AI_CONFIGURATION_ERROR'].includes(failure.response?.data?.code)) setUnavailable(true)
        setError(['ECONNABORTED', 'ETIMEDOUT'].includes(failure.code || '')
          ? 'The analysis took too long. Your text is still here. Wait before trying again; this attempt may count toward your shared AI allowance.'
          : errorMessage(failure))
      } else setError('Your CV analysis could not be displayed. Please try again later.')
    } finally {
      inFlight.current = false
      if (!request.signal.aborted) setBusy(false)
    }
  }

  const sections: { key: 'strengths' | 'improvements' | 'jobKeywords' | 'skillGaps' | 'formatting' | 'nextSteps'; title: string; empty: string }[] = [
    { key: 'strengths', title: 'CV strengths', empty: 'No clear strengths identified from the supplied text.' },
    { key: 'improvements', title: 'Areas needing improvement', empty: 'No specific improvements identified.' },
    { key: 'jobKeywords', title: 'Relevant job-description keywords', empty: 'No keywords identified. Add a job description for tailored feedback.' },
    { key: 'skillGaps', title: 'Missing or weakly evidenced skills', empty: 'No specific gaps identified. This does not establish that all required skills are covered.' },
    { key: 'formatting', title: 'ATS-friendly formatting', empty: 'No specific formatting changes identified from the pasted text.' },
    { key: 'nextSteps', title: 'Prioritized next steps', empty: 'Review your CV and add more detail.' },
  ]
  return <div className="cv-page">
    <div className="cv-heading"><div><span className="eyebrow">YOUR EXPERIENCE. TOLD WITH CONFIDENCE.</span><h1 className="page-title">AI CV Coach</h1><p className="page-subtitle">Make the most of what you already bring to the table.</p></div><span className="cv-ai-tag"><Sparkles size={14}/>Personalised AI guidance</span></div>
    <div className="cv-layout">
      <form className="cv-panel cv-form" onSubmit={submit} aria-busy={busy}>
        <div className="cv-panel-heading"><span className="module-icon blue"><FileText size={23}/></span><div><h2>A fresh perspective on your CV</h2><p>Paste your text. Get practical ways to make it clearer.</p></div></div>
        <label htmlFor="cv-text">Your CV <span>Required</span></label>
        <textarea id="cv-text" value={cv} onChange={event => { setCv(event.target.value); setAnalysis(null) }} maxLength={18000} rows={13} disabled={busy || expired} required aria-describedby="cv-hint cv-privacy" placeholder="Paste your professional summary, education, skills, projects and experience here…"/>
        <div className="cv-field-hint" id="cv-hint"><span>100–18,000 characters · Text only</span><span>{cv.length.toLocaleString()} / 18,000</span></div>
        <label htmlFor="cv-job">Job description <span>Optional</span></label>
        <textarea id="cv-job" value={jobDescription} onChange={event => { setJobDescription(event.target.value); setAnalysis(null) }} maxLength={8000} rows={5} disabled={busy || expired} aria-describedby="cv-job-hint" placeholder="Paste a job description to tailor the feedback to a role you have in mind…"/>
        <div className="cv-field-hint" id="cv-job-hint"><span>For relevant keywords and skill evidence</span><span>{jobDescription.length.toLocaleString()} / 8,000</span></div>
        <div className="cv-disclosure" id="cv-privacy"><ShieldCheck size={20}/><p>When you select Analyze CV, your CV text and optional job description are sent to OpenAI. Remove ID numbers, contact details and other sensitive information first. RiseTogether does not save your CV or analysis; leaving or refreshing clears this page. OpenAI processes the text under its API data policies. Shared AI usage limits apply.</p></div>
        {error && <div className="error" role="alert">{error}{expired && <> <button className="cv-inline" type="button" onClick={() => void refresh()}>Sign in again</button></>}</div>}
        <button className="btn cv-submit" type="submit" disabled={busy || expired || unavailable || cv.trim().length < 100}>{busy ? <LoaderCircle size={18} className="spin"/> : <Sparkles size={18}/>} {busy ? 'Analyzing your CV…' : 'Analyze CV'}{!busy && <ArrowRight size={17}/>}</button>
        {busy && <p className="cv-wait" role="status">Reading your CV and preparing feedback. This can take up to a minute.</p>}
      </form>
      <aside className="cv-aside"><div className="cv-guide"><span className="eyebrow">LET YOUR POTENTIAL SHOW</span><h2>A stronger CV starts with your story.</h2><p>You do not need years of experience. Education, projects and volunteering can help show what you can do.</p><ol><li>Paste the CV you have today.</li><li>Add a role you want to work towards.</li><li>Use the feedback to make one improvement at a time.</li></ol></div><div className="cv-note"><ShieldCheck size={22}/><h3>Guidance, with perspective.</h3><p>This is AI-generated guidance, not a real employer ATS score or hiring prediction. AI can make mistakes.</p><p>Check every suggestion. Only include qualifications, employment, achievements and experience that are true. Pasted text cannot reveal your original document layout.</p></div></aside>
    </div>
    {analysis && <section className="cv-results" ref={results} tabIndex={-1} aria-label="Your CV feedback">
      <div className="cv-results-heading"><span className="eyebrow">YOUR NEXT DRAFT STARTS HERE</span><h2>Your CV feedback</h2><p>AI-generated guidance · Review each suggestion before updating your CV.</p></div>
      <article className="cv-panel cv-summary"><h3>Professional summary feedback</h3><p>{analysis.professionalSummary}</p></article>
      <div className="cv-result-grid">{sections.map(section => <article className="cv-panel" key={section.key}><h3>{section.title}</h3>{analysis[section.key].length ? section.key === 'nextSteps' ? <ol>{analysis[section.key].map((item, index) => <li key={index}>{item}</li>)}</ol> : <ul>{analysis[section.key].map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>{section.empty}</p>}</article>)}</div>
      <article className="cv-panel cv-rewrites"><h3>Suggested rewritten bullet points</h3><p>Keep the meaning accurate. These suggestions should only rephrase evidence already in your CV.</p>{analysis.rewrittenBullets.length ? analysis.rewrittenBullets.map((item, index) => <div className="cv-rewrite" key={index}><div><span>YOUR ORIGINAL</span><p>{item.original}</p></div><div><span>SUGGESTED WORDING</span><p>{item.suggested}</p></div></div>) : <p>No suitable source bullets were found to rewrite.</p>}</article>
    </section>}
  </div>
}
