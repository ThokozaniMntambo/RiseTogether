# RiseTogether

A MERN career readiness foundation for South African students and unemployed graduates. Includes a responsive landing page, account registration/login, a protected dashboard, and five explicitly labelled Coming soon modules. No AI responses or career scores are fabricated.

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

Passwords are hashed with bcrypt (12 rounds); JWTs expire after seven days and use HTTP-only, SameSite=Lax cookies (Secure in production). Axios sends credentials. Validation, duplicate-email handling, auth rate limits, origin checks, request size limits, Helmet, and generic server errors are included. Tokens are not stored in browser localStorage. Logout clears the browser cookie; issued JWTs remain valid until expiry if independently copied. Password reset, email verification, and token revocation are future work.

The health check needs no login. No additional protected health endpoint is necessary; `/api/auth/me` already verifies an authenticated session.

## Verification

Run `npm test` in Server for API contract/security checks. These checks isolate database calls and do not verify a real Atlas connection. With Atlas configured, register a new email, refresh the dashboard, sign out, sign back in, and confirm a signed-out visit to `/dashboard` redirects to login. Duplicate registration, invalid email, short passwords, and incorrect credentials should display errors.

## AI scope

The OpenAI Node SDK is installed only in Server. `OPENAI_API_KEY` is optional and unused. No OpenAI client is instantiated and no paid requests are made. Career Coach, CV Coach, Interview Coach, Learning Roadmap, and Career Analytics each have protected Coming soon pages. Future AI endpoints must run on Express and enforce authentication. No voice AI, CV upload, generated roadmap, or analytics collection is enabled yet.
