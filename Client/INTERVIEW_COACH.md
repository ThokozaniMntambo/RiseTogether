# AI Interview Coach

Voice Mode has been replaced with live WebRTC speech-to-speech. See [the current implementation and rollout guide](../REALTIME_INTERVIEW.md). The text interview documentation below describes the unchanged five-question Text Mode; references below to the previous turn-based Interview Voice Mode are historical.

The dashboard's Interview Coach is a working five-question practice interview. It uses the existing HTTP-only JWT cookie, Responses API SDK, safe provider-error mapper, and persistent shared AI quotas. Learning Roadmap and Career Analytics remain coming soon.

## Files

- Frontend: new `src/InterviewCoach.tsx`, `src/InterviewCoach.css`, and `src/interviewSession.ts`; updated `src/App.tsx` for the live route, badges and toolkit count. The existing `src/voice.ts` and `src/VoiceMode.css` are reused without modification.
- Backend: new `Server/routes/interviewCoach.js` and `Server/services/interviewCoach.js`; updated `Server/app.js` and `Server/.env.example`. No database models or authentication code changed.
- Tests: new `Client/test/interviewSession.test.mjs`, `Client/test/interview-theme.test.mjs`, `Client/test/interview-browser.mjs`, `Server/test/interviewCoach.test.js`, and `Server/test/interviewCoachService.test.js`.
- Documentation: this guide and the root `README.md`.

## Run

Use the repository's existing Node/MongoDB setup. `Server/.env` needs the existing `MONGODB_URI`, `JWT_SECRET`, `OPENAI_API_KEY`, and normal origin configuration. Do not put the API key in Client. Optional `OPENAI_INTERVIEW_MODEL` defaults to `gpt-4.1-mini`, as used by CV Coach. Unreviewed model overrides require an explicit reviewed `AI_REQUEST_RESERVE_USD`; no limits are increased or reset.

```sh
cd Server
npm install
npm run dev
# In a second terminal:
cd Client
npm install
npm run dev
```

Sign in and visit `/dashboard/interview-coach`. Enter a job title, optional company, type (Technical, Behavioural, General), and Text or Voice Mode. Starting generates five tailored questions. Each reviewed answer advances locally; the fifth submission triggers final evaluation. Results show five individual scores and feedback, their rounded mean, strengths, improvements, and practice recommendations. Scores assess relevance, clarity, evidence/reasoning, and role knowledge/technical accuracy; accent, voice characteristics and personal attributes are excluded. They are practice guidance, not employer assessments or hiring predictions.

## API and cost controls

- `POST /api/ai/interview-coach/questions`: `{ jobTitle, company?, interviewType }` → `{ questions: [five strings], interviewToken }`.
- `POST /api/ai/interview-coach/evaluate`: `{ interviewToken, answers: [five strings] }` → `{ evaluation: { overallScore, answers: [{ questionNumber, score, feedback }], strengths, improvements, recommendations } }`.

Both endpoints authenticate first, reject unknown request fields, validate lengths/types, reserve shared usage **before** the provider call, prevent concurrent Interview Coach requests per user within the process, and return `Cache-Control: no-store`. Each operation is one provider call and one usage reservation: normally two per completed interview. Answer progression and browser audio do not call OpenAI. No Realtime or paid speech API is used. Quota exhaustion or provider failure can prevent evaluation even after questions were generated; the page retains all answers and provides a deliberate retry. There are no automatic retries or refunds for potentially billed failures/timeouts.

Question generation is capped at 1,300 output tokens, evaluation at 2,500, with 45-second provider timeouts, zero SDK retries, and `store: false`. The existing known-model minimum reservation remains $0.10 per attempt; it is an estimate, not actual billing telemetry. Both calls share the historical Career/CV hourly, daily, lifetime-request and budget records. Database reservation failures block calls. The implementation follows [OpenAI structured-output guidance](https://developers.openai.com/api/docs/guides/structured-outputs) and additionally checks every string, array count, integer score range, and question number before returning/displaying feedback. The server derives the total score to prevent inconsistent arithmetic.

The generated questions and setup are signed into a user-bound, 24-hour interview token using a key derived separately from the login JWT key. The client cannot change the generated question set, submit it for another user, or use that token as a login cookie. Evaluation submits answers and the signed token, not client-authored scoring instructions. Model prompts treat all setup and answers as untrusted data. The separate interview request-body limit is 96 KB for five Unicode answers plus the token; other routes keep their existing limits. Titles/company are capped at 120 characters, questions at 500, and answers at 2,000 each.

## Voice and privacy

Voice Mode reuses `VoiceSession` from Career Coach. This is **voice-assisted, turn-based practice**, not streaming audio conversation. Questions are read aloud when shown where browser autoplay allows it; Replay Question provides an explicit playback gesture if blocked. Start Recording is always an explicit action. Stop Recording finalizes recognition; recognized text stays editable before submission. Recording stops after a turn or 30 seconds. Starting recognition cancels playback, and question changes, mode changes, page hiding, leaving, and unmount stop audio. Failure or denial leaves typed input available for all five questions.

Speech recognition is feature-detected through `SpeechRecognition`/`webkitSpeechRecognition`; support varies by Chrome/Android Chrome, Safari/iOS, browser settings, device policy and operating system. Firefox and some Chromium configurations need text fallback. Speech synthesis has broader support but available English voices and playback policies vary. Use HTTPS or localhost. Recognition may send audio to the browser vendor's online service and can require connectivity; synthesis voices may also be remote. No raw audio recording is created or persisted by RiseTogether.

Questions, answers, results and the interview token live only in frontend memory. No interview MongoDB collection, browser persistence or transcript logging is added. Refreshing, clearing or leaving the page loses the interview. Only the existing AI usage counters are persisted. A provider may retain submitted data under its own API policies despite `store: false`; the setup screen discloses that submitted text goes to OpenAI. Ending or navigating away does not undo a provider request already started or its usage reservation.

Browser references: [SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition), [SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis).

## Automated tests

```sh
cd Client
npm test
npm run build
npm run lint
cd ../Server
npm test
```

Use Node 24 for the native TypeScript imports in the tests. No new dependencies are needed. Backend tests mock MongoDB and provider responses, including a complete frontend-session → real authenticated Express routes → real interview service → mocked Responses API flow. Tests cover five-question progression, blank answers, duplicate submissions, question integrity/ownership/expiry, schema rejection, scoring, all shared caps, safe provider errors, and retained work on failure. Browser speech mocks cover recognition denial, unsupported APIs, edited transcripts, playback/replay, cancellation, timeouts and text fallback. Core theme tests verify contrast in both themes. No automated test loads `.env` or makes a live OpenAI call.

For optional headless browser UI checks, start Vite at `http://127.0.0.1:5173`, then run `node test/interview-browser.mjs` from Client. This uses an installed Chrome/Edge (or `CHROME_PATH`), Node's native WebSocket/CDP support, and mocked authentication, AI responses and speech APIs. It completes desktop light/text, mobile dark/voice with permission denial and quota retry, and unsupported-recognition/text-fallback interviews. Artifacts are written under the ignored `Client/node_modules/.tmp/interview-ui` directory. This does not verify physical microphones, real permission dialogs, actual voice quality, or live provider credentials.

## Manual checks on the demonstration device

1. Sign in; configure a role and type; start a text interview. Verify five different questions, Question 1–5 progress, blocked empty submissions, and no duplicate progress on a double click. Submit five substantive answers and inspect all feedback and integer scores. A real completed interview normally uses **two paid text-model requests**.
2. Choose Voice Mode, verify no automatic recording, hear/replay/stop a question, explicitly record an answer, stop, edit the transcript and submit. Repeat and verify that previous audio stops on question changes.
3. Deny microphone permission or use an unsupported browser. Complete all five questions by typing. Verify browser playback restrictions leave questions readable and Replay Question usable where supported.
4. Check light and dark themes, mobile width, keyboard focus and reduced-motion settings. Switch modes during practice without losing the draft. Hide/navigate away and confirm audio stops.
5. Simulate quota/network/provider failures using mocks, not by spending the actual allowance. Confirm generation errors retain setup and evaluation errors retain all five answers for a deliberate retry. Billing/configuration errors block repeated attempts. A 24-hour-expired interview requires a new question set.

Real microphone/speaker behavior and live AI response quality require this manual verification on the target device. They cannot be established by synthetic audio or mocked-provider tests.
