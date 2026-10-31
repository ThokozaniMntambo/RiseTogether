# RiseTogether

A MERN career readiness platform for South African students and unemployed graduates. Includes a responsive landing page, account registration/login, a protected dashboard, and a working AI Career Coach. The other four modules remain labelled Coming soon. No AI responses or career scores are fabricated.

## Requirements

Node.js 22.12+ (or a compatible newer LTS), npm, and a MongoDB Atlas cluster. The client retains the existing React/TypeScript Vite setup; the Express server uses CommonJS.

## Server — terminal 1

```powershell
cd Server
npm install
Copy-Item .env.example .env
```

Edit `Server/.env`: set your Atlas `MONGODB_URI`, a unique random `JWT_SECRET` of at least 32 characters, and `CLIENT_ORIGIN=http://localhost:5173`. Replace the example values. In Atlas create a database user and permit your development IP in Network Access. URL-encode special characters in database passwords. Never commit `.env`.

Generate a secret locally with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` and paste it into `.env`.

```powershell
npm run dev
```

The API listens on port 5000 after MongoDB connects. `npm start` runs without watch mode. Startup fails clearly for missing configuration or a failed database connection.

## Client — terminal 2

```powershell
cd Client
npm install
npm run dev
```

Open http://localhost:5173. Vite proxies `/api` to http://localhost:5000. Keep the browser origin consistent with `CLIENT_ORIGIN` (do not mix localhost and 127.0.0.1). Tailwind CSS v4 uses `@tailwindcss/vite` in `vite.config.js` and `@import "tailwindcss"` in `src/index.css`.

```powershell
npm run build
```

The build is written to `Client/dist`. For production, host the frontend and `/api` on the same HTTPS origin, configure SPA fallback to `index.html`, set `NODE_ENV=production`, and set `CLIENT_ORIGIN` to the frontend origin. The development proxy does not apply to built assets or `vite preview`; configure a production reverse proxy. An optional public `VITE_API_URL` can change the API base path at build time; never put secrets in any `VITE_` variable. Cross-site cookie deployments require a separate cookie/CSRF design; the default supports same-site hosting.

## API

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/health` | Public liveness and database connection status |
| POST | `/api/auth/register` | Public; `{ name, email, password }` |
| POST | `/api/auth/login` | Public; `{ email, password }` |
| GET | `/api/auth/me` | Requires session cookie |
| POST | `/api/auth/logout` | Clears session cookie |
| GET | `/api/career-coach/sessions` | Requires session cookie; latest 10 saved coaching sessions for this user |
| POST | `/api/ai/career-coach` | Requires session cookie; generates and saves personalised AI guidance (original `/api/career-coach/sessions` remains an alias) |

Passwords are hashed with bcrypt (12 rounds); JWTs expire after seven days and use HTTP-only, SameSite=Lax cookies (Secure in production). Axios sends credentials. Validation, duplicate-email handling, auth rate limits, origin checks, request size limits, Helmet, and generic server errors are included. Tokens are not stored in browser localStorage. Logout clears the browser cookie; issued JWTs remain valid until expiry if independently copied. Password reset, email verification, and token revocation are future work.

The health check needs no login. No additional protected health endpoint is necessary; `/api/auth/me` already verifies an authenticated session.

## Verification

Run `npm test` in Server for API contract/security checks. These checks isolate database calls and do not verify a real Atlas connection. With Atlas configured, register a new email, refresh the dashboard, sign out, sign back in, and confirm a signed-out visit to `/dashboard` redirects to login. Duplicate registration, invalid email, short passwords, and incorrect credentials should display errors.

## AI scope

`POST /api/ai/career-coach` also accepts conversational requests:

```json
{
  "message": "How can I start a career in software development?",
  "history": [
    { "role": "user", "content": "I am studying IT." },
    { "role": "assistant", "content": "What interests you most about IT?" }
  ]
}
```

`message` is required for conversational requests (1–2000 characters after rejecting whitespace-only input). `history` is optional and defaults to an empty array: at most 10 recent entries, each with a `user` or `assistant` role and 1–2000 characters of content. The combined message and history limit is 10000 characters; the existing 16kb JSON body limit also applies. Only role/content fields are forwarded; privileged roles are rejected. The server responds with `{ "reply": "..." }`. Conversation context comes from the caller and is not trusted as server instructions. Chat turns are not currently persisted; profile-based guidance and its saved-session history continue to work. Both request modes share authentication, rate limits and the per-account concurrency lock.

AI Career Coach is available at `/dashboard/career-coach`. Set `OPENAI_API_KEY` in `Server/.env` to a server-side OpenAI API key with billing/credits and access to the configured model, then restart the server. `OPENAI_MODEL` defaults to `gpt-5.6-terra`; choose a model that supports Responses API structured outputs. Never put the key in Client or a `VITE_` variable. Without a key, authentication and saved-session retrieval still work; generation returns a clear 503 configuration error.

The legacy profile request accepts education, interests, skills, experience, goals and optional constraints. Each field accepts up to 1000 characters; required fields need at least two non-whitespace characters. Submit those same field names as a JSON object to the POST endpoint. The server sends only this validated profile to OpenAI, with South African career exploration instructions. A successful response is `{ session: { _id, profile, guidance, model, createdAt } }`. Guidance contains a summary, strengths, three career paths (reason, skills to build, first step), next steps for the next 30 days, and encouragement.

The integration follows the [official OpenAI documentation for structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses). Requests use a strict JSON schema, a 3000-token output cap, a 45-second provider timeout, no automatic retries, and `store: false`. Profile and successful guidance are stored in MongoDB's `careersessions` collection under the authenticated user's ID; they are retained until removed administratively. Only the latest 10 are returned by the history endpoint. Failed or refused generations are never replaced with fabricated responses or saved as successful sessions. Provider error details and submitted profiles are not logged.

Generation makes a paid API request. The chat explains data sharing before submission. Page loads do not call OpenAI. If a request times out in the browser, refresh saved sessions before trying again because a server-side generation may still finish. AI suggestions are exploratory, do not guarantee employment, and need verification against official entry requirements and opportunities.

### AI usage protection

Career Coach failures return safe JSON messages; provider failures also include a stable `code` and `retryable` flag. Invalid JSON returns 400, oversized bodies 413 and invalid message/history fields 422 before any provider request. Provider timeouts return 504 (`AI_TIMEOUT`); exhausted credits return 503 (`AI_CREDITS_EXHAUSTED`) with an administrator action rather than retry advice. Provider throttling returns 503 (`AI_BUSY`) with `Retry-After: 30`. Invalid provider configuration returns 503 (`AI_CONFIGURATION_ERROR`), and connection/server/incomplete-output failures return 503 (`AI_UNAVAILABLE`). Explicit provider refusals return 422 (`AI_REFUSAL`) with guidance to rephrase the career question. These distinctions follow the [official OpenAI error documentation](https://developers.openai.com/api/docs/guides/error-codes). Raw provider errors, request content and credentials are never returned or logged by the provider error handler; only fixed internal error codes are logged. No automatic retry occurs, and budget reservations remain consumed. The frontend preserves entered data and previous results and shows actionable server messages; browser timeouts advise checking saved sessions before retrying.

Before every chat or report request, MongoDB atomically reserves usage in `aiusages`. Defaults protect a small development balance:

| Setting | Default | Scope |
| --- | --- | --- |
| `AI_USER_HOURLY_LIMIT` | `3` | Attempts per authenticated user per fixed UTC hour |
| `AI_USER_DAILY_LIMIT` | `5` | Attempts per authenticated user per UTC day |
| `AI_MAX_REQUESTS` | `20` | Lifetime provider attempts across all users |
| `AI_BUDGET_USD` | `3.00` | Lifetime budget measured by conservative reservations |
| `AI_REQUEST_RESERVE_USD` | `0.10` | Reserved per attempted provider call, including failures |

Both global caps must allow a request. With defaults, 20 requests reserve $2.00 and then generation stops. The $0.10 reservation uses headroom for the default model, bounded input, and maximum report output; it is not actual billing telemetry. Review current pricing and explicitly configure this reservation when changing `OPENAI_MODEL`; a different model without an explicit reservation fails closed. The default model refuses reservations below $0.10. Charges from other apps/keys, account-wide spending, future price changes and an incorrectly configured model reservation cannot be controlled by this application.

Quota exhaustion returns JSON with HTTP 429; per-user limits also set `Retry-After`. Invalid quota configuration or a failed database check blocks generation with HTTP 503. No reservation is refunded after failure, timeout or a process crash, since the provider may still charge. Denied attempts may consume per-user allowance but never start an OpenAI request. Global counters never expire or reset on restart; increasing limits requires an explicit server configuration change. Do not delete the global `career-coach:global-budget:v1` record to clear an error, as that reopens spending.

Persistent limits apply across server instances and route aliases. The existing in-memory 10-attempt/hour limiter remains a secondary guard. One concurrent generation per account is additionally enforced within each process; global reservations protect the shared budget even with multiple processes. Per-user time buckets expire after their enforcement period; the global record has no expiry. Automated tests mock both MongoDB and OpenAI and cover concurrent reservations and fail-closed behavior without external calls.

Verification: sign in, open AI Career Coach, choose a starter prompt or type a question, then send it. Continue with a follow-up to check recent conversation context. The responsive chat uses Enter to send and Shift+Enter for a new line, displays a thinking state, prevents duplicate sends and preserves the draft on failure. New chat clears the local conversation; navigating away or refreshing also clears it. Chat turns are not persisted. The legacy profile/report API and account-scoped saved-report retrieval remain available on the backend. Test without `OPENAI_API_KEY` to see the configuration error. `npm test` in Server mocks database/provider calls and checks auth, validation, ownership, provider request format, failures and limits without paid requests. A live Atlas/OpenAI smoke test requires your configured credentials and incurs API usage.

CV Coach, Interview Coach, Learning Roadmap and Career Analytics remain Coming soon. No voice AI, CV upload, separate Learning Roadmap module or analytics collection is enabled yet.
