export type InterviewSetup = { jobTitle: string; company: string; interviewType: 'Technical' | 'Behavioural' | 'General' }
export type Evaluation = {
  overallScore: number
  answers: { questionNumber: number; score: number; feedback: string }[]
  strengths: string[]; improvements: string[]; recommendations: string[]
}
type Stage = 'setup' | 'practice' | 'review' | 'results'
type Snapshot = {
  stage: Stage; setup: InterviewSetup | null; questions: string[]; interviewToken: string
  answers: string[]; draft: string; evaluation: Evaluation | null
  busy: boolean; error: string; expired: boolean; unavailable: boolean
}
export type InterviewApi = { post(path: string, body: unknown, options: { signal: AbortSignal; timeout: number }): Promise<{ data: unknown }> }
const initial = (): Snapshot => ({ stage: 'setup', setup: null, questions: [], interviewToken: '', answers: [], draft: '', evaluation: null, busy: false, error: '', expired: false, unavailable: false })
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const score = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
const text = (value: unknown, max: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= max
const list = (value: unknown): value is string[] => Array.isArray(value) && value.length >= 1 && value.length <= 5 && value.every(item => text(item, 300))
export function validEvaluation(value: unknown): value is Evaluation {
  return record(value) && score(value.overallScore) && Array.isArray(value.answers) && value.answers.length === 5
    && value.answers.every((answer, index) => record(answer) && answer.questionNumber === index + 1 && score(answer.score) && text(answer.feedback, 800))
    && list(value.strengths) && list(value.improvements) && list(value.recommendations)
    && value.overallScore === Math.round(value.answers.reduce((sum, answer) => sum + answer.score, 0) / 5)
}

// Used by the UI and integration tests; never persists answers or results.
export class InterviewSession {
  api: InterviewApi
  snapshot = initial()
  listeners = new Set<() => void>()
  controller: AbortController | null = null
  constructor(api: InterviewApi) { this.api = api }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  update(value: Partial<Snapshot>) { this.snapshot = { ...this.snapshot, ...value }; this.listeners.forEach(listener => listener()) }
  setDraft = (draft: string) => { if (this.snapshot.stage === 'practice' && !this.snapshot.busy) this.update({ draft: draft.slice(0, 2000) }) }
  dispose = () => { this.controller?.abort(); this.controller = null }
  reset() { this.dispose(); this.snapshot = initial(); this.listeners.forEach(listener => listener()) }
  async request(path: string, body: unknown, success: (data: unknown) => void) {
    if (this.snapshot.busy || this.snapshot.expired || this.snapshot.unavailable) return
    const controller = new AbortController()
    this.controller = controller
    this.update({ busy: true, error: '' })
    try {
      const { data } = await this.api.post(`/ai/interview-coach/${path}`, body, { signal: controller.signal, timeout: 65000 })
      if (!controller.signal.aborted) success(data)
    } catch (failure) {
      if (controller.signal.aborted) return
      const response = record(failure) && record(failure.response) ? failure.response : null
      const data = response && record(response.data) ? response.data : null
      const code = record(failure) ? failure.code : null
      this.update({
        expired: response?.status === 401,
        unavailable: ['AI_CREDITS_EXHAUSTED', 'AI_CONFIGURATION_ERROR'].includes(String(data?.code)),
        error: code === 'ECONNABORTED' || code === 'ETIMEDOUT'
          ? 'The interview request timed out. Your work is kept. Wait before retrying; this attempt may still count toward your shared AI allowance.'
          : typeof data?.message === 'string' ? data.message : 'Interview Coach could not complete this request. Your work is kept. Please try again later.',
      })
    } finally {
      if (this.controller === controller) { this.controller = null; this.update({ busy: false }) }
    }
  }
  async start(setup: InterviewSetup) {
    if (this.snapshot.stage !== 'setup' || this.snapshot.busy) return
    if (!text(setup.jobTitle, 120) || setup.jobTitle.trim().length < 2 || typeof setup.company !== 'string' || setup.company.length > 120 || !['Technical', 'Behavioural', 'General'].includes(setup.interviewType)) {
      this.update({ error: 'Enter a job title (2–120 characters), optional company (up to 120 characters) and a valid interview type.' }); return
    }
    const clean = { ...setup, jobTitle: setup.jobTitle.trim(), company: setup.company.trim() }
    await this.request('questions', clean, data => {
      if (!record(data) || !Array.isArray(data.questions) || data.questions.length !== 5 || !data.questions.every(question => text(question, 500))
        || new Set(data.questions.map(question => question.trim().toLowerCase())).size !== 5 || !text(data.interviewToken, 16000)) throw new Error('Invalid interview questions')
      this.update({ setup: clean, questions: data.questions, interviewToken: data.interviewToken, answers: [], draft: '', evaluation: null, stage: 'practice' })
    })
  }
  async submitAnswer(expectedIndex: number) {
    const state = this.snapshot
    if (state.stage !== 'practice' || state.busy || expectedIndex !== state.answers.length) return
    if (!text(state.draft, 2000)) { this.update({ error: 'Enter or record an answer before continuing.' }); return }
    const answers = [...state.answers, state.draft.trim()]
    this.update({ answers, draft: '', error: '', stage: answers.length === 5 ? 'review' : 'practice' })
    if (answers.length === 5) await this.evaluate()
  }
  async evaluate() {
    if (this.snapshot.stage !== 'review' || this.snapshot.answers.length !== 5 || this.snapshot.busy) return
    await this.request('evaluate', { interviewToken: this.snapshot.interviewToken, answers: this.snapshot.answers }, data => {
      if (!record(data) || !validEvaluation(data.evaluation)) throw new Error('Invalid interview feedback')
      this.update({ evaluation: data.evaluation, stage: 'results' })
    })
  }
}
