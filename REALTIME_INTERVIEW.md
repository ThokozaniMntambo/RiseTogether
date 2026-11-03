# Live Voice Interview: demonstration and safety guide

Reviewed against official OpenAI documentation on 2026-11-02. No billable Realtime session was started for this review, and `Server/.env` was not edited. Voice remains disabled. Automated tests use mocked provider/audio transports.

## Current readiness

The dedicated key is present. The developer's model visibility checks returned HTTP 200 for both models; metadata visibility is not evidence of sufficient credits, Realtime write permission or successful audio negotiation.

A read-only MongoDB audit found a $3 cumulative application ceiling, $1.20 already reserved and **$1.80 remaining**. Twelve request slots were reserved and 188 remained globally at that snapshot. Per-user hourly/daily capacity was not inspected because no approved account was supplied. The ceiling does not reset automatically. No records were deleted, reset or refunded.

The local configuration is still disabled, has zero approved accounts, an unconfirmed provider cap, no configured session reservation and a **180-second** duration. Ten-minute capability is implemented, but changing duration to 600 is a manual activation step. The reported approximately $4 of provider credits was not independently verified and is separate from application accounting.

## Prices and ten-minute cost estimate

The implementation retains the supported `gpt-realtime-2.1-mini` model over `/v1/realtime/calls`, with `gpt-transcribe` input captions. Standard USD prices checked in [OpenAI pricing](https://developers.openai.com/api/docs/pricing):

| Charge | Price |
| --- | --- |
| Realtime audio input / cached audio input | $10 / $0.30 per million tokens |
| Realtime audio output | $20 per million tokens |
| Realtime text input / cached text input / output | $0.60 / $0.06 / $2.40 per million tokens |
| `gpt-transcribe` | $0.0045 per input minute |
| Existing `gpt-4.1-mini` feedback | $0.40 input / $1.60 output per million tokens |

The [model catalogue](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini) supports the selected mini model. The larger `gpt-realtime-2.1` is also supported by OpenAI but costs more; it is not substituted here. These calculations do not apply to unreviewed models, premium processing or regional uplifts. Prices and alias behaviour can change: re-review before a later presentation.

The [Realtime cost guide](https://developers.openai.com/api/docs/guides/voice-latency-cost?voice-api=realtime) describes approximately 600 input audio tokens and 1,200 output audio tokens per spoken minute. Six candidate minutes plus three interviewer minutes, with one minute of pauses, produce about $0.036 of fresh input audio, $0.072 of output audio and $0.027 of transcription: **$0.135 before text, replayed context, reasoning and feedback**. This is not the complete session price. Earlier conversation is billed again on later responses, with caching affecting the result.

For a normal interview, **$0.20-$0.80 total is a planning estimate**, assuming brief interviewer turns, ordinary answer lengths, roughly 12-20 responses and some history caching. It is an engineering estimate, not measured usage or a guaranteed range; a cache-poor or unusually long conversation can cost more.

The controlled conservative planning scenario deliberately ignores cache discounts and allows 25 responses: 24 allowed responses plus one beginning while termination propagates. It budgets 8,000 conversation tokens at the expensive audio input rate, another 8,000 instruction/tool text tokens, and 700 output tokens per response at the audio output rate:

- Conversation replay: `25 * 8,000 * $10 / 1,000,000 = $2.00`.
- Instruction/tool text: `25 * 8,000 * $0.60 / 1,000,000 = $0.12`.
- Output: `25 * 700 * $20 / 1,000,000 = $0.35`.
- Ten minutes of transcription: `$0.045`.
- Feedback allowance: `$0.10`.
- Total: **$2.615**, approximately **$2.62**.

This justifies a lower **$2.75 voice reservation plus $0.10 feedback reservation = $2.85** for this restricted, reviewed implementation. The arithmetic is tested in `realtimeCost.test.js` and printed by the diagnostic script. It is a conservative planning scenario, **not a hard maximum invoice**. Tokenization overhead, simultaneous client commands, changes to response configuration, provider/network failure, crashes, delayed usage events and spending-limit enforcement can exceed assumptions. The estimate cannot promise an unconditional ten-minute session within exactly $4.

One controlled demonstration is plausibly affordable with approximately $4 of genuine remaining credits. **Multiple demonstrations are not assumed affordable.** A paid failed start still consumes the local reservation; do not reset accounting to rehearse again. For presentation reliability, prefer a focused 3-5 minute live conversation (End Interview early) with the option to continue up to ten minutes, and keep Text Mode ready. If no enforced provider cap is available, remaining application capacity is insufficient, or strict protection against any overage is required, keep voice disabled and demonstrate Text Mode. A later authorised paid rehearsal is required to establish actual audio quality; none has been performed here.

## Controls supporting the lower reservation

- Explicit enablement, dedicated server-only key, approved-account allowlist and provider hard-cap confirmation remain mandatory. This is a restricted demo, not an unrestricted public rollout.
- Maximum backend duration is **600 seconds**; shorter limits down to 60 are supported. Client End Interview, navigation cleanup and backend expiry stop audio and microphone resources. No automatic replacement paid session is created on failure.
- A visible one-minute warning appears without generating another response or interrupting a spoken answer. The backend and client each maintain warning/deadline timers.
- Semantic VAD remains low-eagerness with interruption support, allowing thinking pauses. Alex greets first, waits for the candidate, asks one main question at a time, follows actual answers, and aims for about five main topics. New instructions encourage concise interviewer turns and avoid unnecessary silence-filling.
- Context is limited to 8,000 post-instruction tokens with 0.8 retention-ratio truncation; output is capped at 700 tokens with low reasoning effort. Oldest context can be dropped, so full-session recall is not guaranteed. The server retains the complete available transcript independently for feedback.
- At most 24 response starts are allowed; the 25th triggers termination. One extra response is included in the planning calculation, but asynchronous control is not an adversarial hard dollar bound.
- Server-side `response.done` usage is accumulated and stops the session at a **$1.75 conservative Realtime usage estimate**. Cached tokens are charged at full price in that estimate; unclassified tokens use the most expensive modality rate. Missing usage consumes a conservative per-response allowance. This may end a session before ten minutes. Transcription/feedback have separate planning allowances. This estimate is not an invoice or credit-balance measurement.
- One persistent MongoDB lease per user prevents concurrent calls across processes and restarts. With a single approved account, that is one active call. Multiple approved accounts do not imply a global concurrency lock; the shared atomic budget is the additional backstop.
- Heartbeat loss ends a session after 30 seconds, checked every five seconds. Provider termination is retried three times. Unconfirmed leases remain closed; a ten-second reaper uses persisted metadata to clean expired/orphaned calls after restart. No lease expires automatically without confirmed cleanup.
- Browser session reconfiguration triggers termination. A 50,000-byte transcript threshold and bounded instruction bytes limit memory and feedback input. Failures are logged with safe status/type/code/request-ID metadata, never audio, SDP, transcripts, keys or raw provider messages.

## Persistent reservation and feedback

Session creation now reserves **two request slots** and the combined dollar amount in the existing shared AI pool before contacting OpenAI. Default minimum: $2.85. The atomic global write checks both the lifetime request ceiling and remaining dollar capacity. Existing user hourly/daily limits are also enforced; at least two slots must be available. Text/Career/CV callers retain the existing single-request reservation behaviour.

The first conversational evaluation uses its prepaid feedback slot without reserving twice. Successful results are cached. A deliberate retry after provider failure consumes another normal request/reservation. Upfront reservation improves feedback availability but cannot guarantee credits, provider uptime, transcript availability or database/process survival. The reviewed voice feedback model is `gpt-4.1-mini`; another configured feedback model requires a new cost review for voice.

Feedback assesses the server-observed candidate transcript, covering clarity, relevance, technical/behavioural competency, strengths, improvement areas and practical recommendations. Very short transcripts are not scored; missing evidence receives null scores. Accents, voice traits and protected characteristics are excluded. User-ended, naturally concluded and safety-limited sessions use the available evidence honestly.

All reservations are conservative accounting, with no refunds on failures, crashes, early endings or missing feedback. They are not actual provider charges. With the audit's $1.20 already reserved, the cumulative application ceiling must be **at least $4.05** to fit one new $2.85 bundle. This is $1.20 historical plus $2.85 prospective reservation, not a claim of $4.05 new provider spending. Re-run the snapshot immediately before deciding; unrelated AI calls can change it. Do not erase records or silently increase ceilings. Any increase must be the developer's explicit spending decision after checking provider funds.

Text Mode also shares this pool. A complete text interview after a voice attempt normally needs **another $0.20 and two request slots** at the default text reservation. At the audited snapshot, budgeting the voice bundle plus that fallback would require a cumulative ceiling of **$4.25**, with four request slots available across hourly/daily/lifetime caps. The default hourly limit is three, so do not promise a complete post-voice text fallback without checking capacity. A developer may explicitly review the configured caps for the presentation; this work does not change them. Demonstrating Text Mode before any paid voice attempt is the least risky fallback with the current $1.80 remaining.

## Exact activation steps

1. Keep `REALTIME_ENABLED=false` while completing setup. In the OpenAI billing console, select the correct organisation and verify the current balance, payment status and any automatic-recharge setting. Stop unrelated paid usage during the demonstration. The script does not read a reliable prepaid balance from ordinary model access; no undocumented billing endpoint is used.
2. Verify the dedicated key belongs to the intended project and permits Realtime calls/control plus the selected models. `npm run realtime:diagnose -- --check-provider` performs only read-only model metadata requests. It cannot validate an actual audio call or prove a spend cap.
3. As a project owner, open **Project settings > Limits > Spend > Edit spend limit**, configure the monthly amount and turn on **Enforce a hard limit**, then save and reopen to confirm it persisted. Check the organisation limit too. Use the same project as the dedicated key. Account for spending already recorded this month when deciding remaining headroom. Alerts alone are insufficient. Only after verifying enforcement should you set `REALTIME_PROJECT_HARD_CAP_CONFIRMED=true`. If this control is absent or unverifiable, leave it false and use Text Mode. Do not deliberately spend credits to test a limit now.
4. Sign into RiseTogether normally. In browser developer tools, inspect the **response** to `GET /api/auth/me` and copy only `user.id`, or run `fetch('/api/auth/me', {credentials:'include'}).then(r=>r.json()).then(x=>console.log(x.user.id))` on localhost:5173. Put that ID in backend `REALTIME_ALLOWED_USER_IDS`. It is an application ID, not an API key or JWT. Do not copy cookies, authorization headers or keys into chat, screenshots or the frontend. Approve just your account for this demo.
5. Set `REALTIME_SESSION_RESERVE_USD=2.75`, `REALTIME_MAX_SECONDS=600`, and retain `OPENAI_INTERVIEW_MODEL=gpt-4.1-mini`. Keep credentials server-side. Decide manually whether to raise the cumulative `AI_BUDGET_USD` ceiling; at the audited snapshot, `4.05` is the minimum to fit one bundle. Leave all existing request caps in place and ensure two user slots remain.
6. Run `npm run realtime:diagnose -- --check-budget` from `Server`. Require `fitsVoiceAndFeedback: true`, and resolve every remaining configuration blocker. This diagnostic mirrors the backend's existing Atlas DNS configuration and only reads accounting. It does not refund or write records. The snapshot excludes user-specific hourly/daily buckets, which session creation still enforces.
7. Only after these checks, **manually** set `REALTIME_ENABLED=true` and restart Express on port 5000. Restarting Vite alone does not reload backend environment variables. Re-run diagnostics; check `/api/health` shows the database connected. Use one Node worker or sticky routing for in-memory transcript ownership.
8. When you choose to begin the paid demonstration, select Voice Mode and Start Interview. That action requests microphone permission and starts the billable session. Use a headset to reduce echo, allow audio playback, speak naturally, and end early if the presentation goal is met. Keep a Text Mode walkthrough ready. Do not use a supposed 'free test call': Realtime testing can be billed.

[Official spending-limit documentation](https://developers.openai.com/api/docs/guides/spend-limits) distinguishes alerts from enforcement and explicitly notes that enforcement is not instantaneous. Provider caps are an additional guard, not a promise of zero overrun. Specific 429 codes distinguish project/organisation spending limits and exhausted credits; the application recognises these without automatically retrying them.

## Architecture, routes and privacy

The React live screen uses WebRTC microphone/speaker media and an event data channel. Express exchanges SDP using the installed OpenAI SDK, captures captions via a server-side sideband, and owns expiry, quota and feedback decisions. Browser speechSynthesis is not used. A `finish_interview` function supports natural completion after the farewell. The existing text five-question flow, authentication and other coaches remain available.

All routes are under `/api/ai/interview-coach/realtime`, use the existing JWT cookie, origin checks and no-store responses:

| Route | Purpose |
| --- | --- |
| POST `/sessions` | Authorise and reserve the timed voice/feedback bundle, create the provider call and return SDP plus deadline. |
| POST `/sessions/:id/heartbeat` | Refresh the lease; report expiry, warning, termination and safe failure state. |
| POST `/sessions/:id/end` | Idempotent provider hangup and confirmed lease cleanup. |
| POST `/sessions/:id/feedback` | Finalise and evaluate the authoritative transcript; never accepts client-fabricated answers. |

RiseTogether stores no raw audio. OpenAI receives live media under its API data policies. Transcript/report content stays in process memory for up to 15 minutes after termination, then is cleared; the page clears on navigation/refresh. MongoDB holds lease metadata and quota counters only. A backend restart loses transcript/feedback evidence, while persistent reservations and cleanup metadata survive. Do not claim provider zero-retention. Captions can be incomplete, delayed or include interrupted interviewer speech.

## Files and validation

Frontend: `InterviewCoach.tsx`, `LiveInterview.tsx`, `LiveInterview.css`, `realtimeInterview.ts`. Backend: `routes/realtimeInterview.js`, `services/realtimeInterview.js`, `realtimeConfig.js`, `realtimeCost.js`, `realtimeDiagnostics.js`, `aiUsage.js`, `models/RealtimeLease.js`, `scripts/diagnoseRealtime.js`, `.env.example`. The shared quota service adds an optional two-slot bundle and read-only snapshot while preserving default callers. 

Validation completed: **95 server tests and 84 client tests passed**; TypeScript/production build passed; lint has existing unrelated warnings. The existing Chromium text/voice interface regression checks passed with mocked API/audio. Tests cover price arithmetic, conservative usage handling, combined atomic reservations, configuration gates, expiry/warning, concurrency/cleanup, safe errors and feedback using actual supplied transcripts. No microphone/provider audio result is claimed verified. Natural greetings, interruptions, actual voices and provider acceptance of session limits need a later authorised real browser rehearsal.
