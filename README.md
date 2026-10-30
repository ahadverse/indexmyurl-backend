# IndexMeNow — SaaS URL Indexing Service

A production-ready SaaS backend that indexes URLs in Google using the Indexing API with a JobPosting wrapper technique. Each user connects their own Google account — their credentials are used for API calls, so you never worry about quota.

---

## Project Structure

```
backend/
├── src/
│   ├── server.ts          # Entry point: DB, service-account seed, worker, cron, HTTP listen
│   ├── app.ts             # Express app: middleware + route mounting
│   ├── config/            # env, database, queue configuration
│   ├── routes/            # Route definitions (auth, oauth, urls, admin, public)
│   ├── controllers/       # Request handlers
│   ├── services/          # Business logic (orchestrator, credits, Google APIs, ...)
│   ├── jobs/              # Bull worker + cron jobs
│   ├── models/            # Mongoose schemas
│   ├── middlewares/       # Auth, rate limiting, error handling
│   └── utils/             # Helpers, JWT, logger, HTML generator
├── docs/postman/          # Postman collection for the API
├── .env.example           # Environment variable reference
└── package.json
```

---

## Architecture

```
User connects Google Account (OAuth)
         ↓
User submits URL via API
         ↓
Pre-flight scan: 404 / noindex / robots.txt / loop? → refused (no credit, no quota)
         ↓
Pre-check: already indexed? → return INDEXED (no credit charged)
         ↓
Reserve credit → Create job → Queue (1–3 min delay, configurable)
         ↓
Worker: Create JobPosting wrapper → Call Google Indexing API
         ↓
Cron (every 15 min, per-job schedule): GSC check → INDEXED? → Deduct credit ✅
         ↓
Not indexed? → Retry (up to 3x, min 24h wait)
         ↓
7 days / 3 retries exceeded → FAILED → Refund credit
```

---

## Credentials

**Publishing** (Indexing API) follows `PUBLISH_CREDENTIAL_MODE`:

| Mode | Order | Notes |
|------|-------|-------|
| `platform` | Platform service accounts only | Users' tokens never publish; users are not asked for the Indexing scope |
| `platform_first` (default) | Service account → user's token | User's token only when no service account has quota |
| `user_first` | User's token → service account | Previous behaviour |

If a credential is rejected (401/403) or out of quota (429), the next one in the
order is tried. A user's token can publish only if it was granted the Indexing scope.

**Status checks** (URL Inspection) use the user's own token first (only it can see
the user's Search Console property), then a platform service account as a last resort.

> The wrapper pages are served from `BASE_URL`, and Google only accepts a publish
> request from an Owner of the property containing that URL. So the platform service
> account must be an Owner of the Search Console property for `BASE_URL`; a normal
> user's token generally is not, which is why service accounts come first.

---

## Quick Start

### 1. Prerequisites
- Node.js 18+
- MongoDB
- Redis

### 2. Install
```bash
npm install
cp .env.example .env
# Fill in your .env values
```

### 3. Google Cloud Setup

#### OAuth (Required — for user login)
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project → Enable these APIs:
   - **Web Search Indexing API**
   - **Google Search Console API**
3. **OAuth consent screen** → External → Fill app name
4. **Credentials** → Create OAuth 2.0 Client ID
   - Application type: Web application
   - Authorized redirect URIs: `http://localhost:5050/api/oauth/google/callback`
5. Copy `Client ID` and `Client Secret` to `.env`

#### Platform Service Account (Optional — fallback only)
1. **IAM & Admin** → Service Accounts → Create
2. Download JSON key
3. Add email from JSON to `.env` as `PLATFORM_SA_EMAIL`
4. Add private_key as `PLATFORM_SA_PRIVATE_KEY`
5. In Google Search Console → Add this email as **Owner** on your property

### 4. Run
```bash
# Development
npm run dev

# Production
npm run build && npm start
```

To run on a server (Node + Redis + MongoDB Atlas behind an HTTPS reverse proxy), see
[docs/deployment.md](docs/deployment.md).

---

## API Reference

### Auth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | No | Register, get API key + 5 free credits |
| POST | `/api/auth/login` | No | Log in, get JWT |
| GET | `/api/auth/me` | Yes | Get profile & credit balance |
| PUT | `/api/auth/profile` | Yes | Update profile |
| PUT | `/api/auth/change-password` | Yes | Change password |
| POST | `/api/auth/regenerate-key` | Yes | Get new API key |

### Google OAuth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/oauth/google/login-url` | No | Get Google consent URL to sign in |
| GET | `/api/oauth/google/connect-url` | Yes | Get Google consent URL to connect an account |
| GET | `/api/oauth/google/callback` | No | OAuth callback (Google redirects here) |
| GET | `/api/oauth/google/accounts` | Yes | List connected Google accounts |
| POST | `/api/oauth/google/sync` | Yes | Re-sync GSC properties |
| DELETE | `/api/oauth/google/:accountId` | Yes | Disconnect Google account |

### URL Indexing
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/urls/preflight` | Yes | Scan up to 100 URLs for indexing blockers; streams live progress (SSE) |
| POST | `/api/urls/submit` | Yes | Submit one URL for indexing (`422 PREFLIGHT_BLOCKED` if the scan finds it unindexable) |
| POST | `/api/urls/submit/bulk` | Yes | Submit up to 50 URLs; streams per-URL results (SSE) |
| GET | `/api/urls/jobs` | Yes | List jobs (filter by `?status=INDEXED`) |
| GET | `/api/urls/status/:jobId` | Yes | Get job status |
| POST | `/api/urls/status/:jobId/refresh` | Yes | Force live GSC check |

### Admin (X-Admin-Key header)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/service-accounts` | List pool with quota stats |
| POST | `/api/admin/service-accounts` | Add service account to pool |
| PATCH | `/api/admin/service-accounts/:id/toggle` | Enable/disable |
| POST | `/api/admin/service-accounts/:id/reset-quota` | Reset daily quota |
| GET | `/api/admin/users` | List all users |
| POST | `/api/admin/users/:userId/credits` | Add credits to user |

### Public (No Auth)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/job/:wrapperId` | Wrapper page (Googlebot crawls this) |
| GET | `/sitemap.xml` | Active wrapper URLs |
| GET | `/rss.xml` | RSS feed |
| GET | `/robots.txt` | Crawler directives |
| GET | `/health` | Health check |

---

## User Flow (SaaS)

```
1. POST /api/auth/register       → get apiKey
2. GET  /api/oauth/google/connect-url → get authUrl
3. Redirect user to authUrl      → user grants Google permission
4. Google → /api/oauth/google/callback → tokens saved, GSC properties detected
5. POST /api/urls/submit         → indexing starts using user's own Google token
```

---

## Job Status Flow

```
PENDING → QUEUED → WRAPPER_CREATED → WAITING_CRAWL → INDEXED ✅
                                   ↘ CRAWLED_NOT_INDEXED → RETRYING → INDEXED ✅
                                                                     → FAILED ❌ (credit refunded)
```

---

## Pre-flight scan

Most URLs that never get indexed are unindexable for a reason the owner can fix, and pushing them to
Google only wastes a credit and Indexing API quota. So every URL is fetched first, the way a crawler
would, and reported as **ready**, **to check** (warnings) or **blocked**. Submit refuses blocked URLs.

| Severity | Issue (`code`) |
|----------|----------------|
| blocker | `HTTP_NOT_FOUND` (404/410), `HTTP_UNAUTHORIZED` (401), `NOINDEX_HEADER`, `NOINDEX_META`, `ROBOTS_BLOCKED` (Googlebot disallowed), `TOO_MANY_REDIRECTS`, `DNS_NOT_FOUND`, `INVALID_URL`, `UNSAFE_TARGET` |
| warning | `REDIRECTED` (submit the destination), `CANONICAL_OTHER`, `THIN_CONTENT`, `SERVER_ERROR` (5xx), `SCANNER_REFUSED` (403/429/…: bot protection, can't verify), `UNREACHABLE`, `TLS_ERROR` |
| info | `INDEXING_API_ELIGIBLE` (page has genuine JobPosting / BroadcastEvent markup), `NON_HTML`, `NO_TITLE`, `SLOW_RESPONSE`, `ROBOTS_UNREACHABLE` |

- **Speed:** one GET per URL that stops after the first 256 KB, keep-alive connections, cached DNS and
  robots.txt per host, and parallel workers (`PREFLIGHT_CONCURRENCY` per request,
  `PREFLIGHT_GLOBAL_CONCURRENCY` overall, `PREFLIGHT_PER_HOST_CONCURRENCY` per website). Twenty mixed
  real-world URLs scan in about two seconds. The scan result is reused by submit for 10 minutes, so
  the page is not fetched twice.
- **Progress:** `/preflight` and `/submit/bulk` answer with Server-Sent Events (`data: {json}` frames):
  `start` (total, URL list) → one `result` per URL as soon as it finishes (`done`/`total` counters) →
  `done` (totals, elapsed). Closing the connection cancels the remaining work.
- **Safety:** the scanner fetches user-supplied URLs, so it only connects to public addresses on ports
  80/443. DNS results are validated at connect time (no DNS rebinding), redirects are re-checked on every
  hop, and size and time are capped. Private, loopback and link-local (cloud metadata) addresses are
  refused. 403/429 only warn, because many sites turn scanners away while serving Googlebot normally.
- Set `PREFLIGHT_ON_SUBMIT=false` to turn the submit gate off (the scan endpoint stays available).
- A site that serves a different `robots.txt` depending on the visitor can produce a wrong
  `ROBOTS_BLOCKED`; the scanner reads what it is served.

---

## Deferred and failed publishes

| Situation | What happens |
|-----------|--------------|
| Quota spent (429) | Job waits (`nextPublishAt`) until the next midnight Pacific, plus up to 30 min of jitter. Doesn't count as an attempt. |
| Transient/auth error | Retried after 5, 10, 20, 40, 60 min. After `MAX_PUBLISH_ATTEMPTS` the job fails and the credit is refunded. |
| Google rejects the request (other 4xx) | Job fails immediately, credit refunded. |
| Worker crash / Redis flush | A recovery cron (every 10 min) re-queues jobs with no live queue entry. |

The error that caused each failure is stored on the job (`errorLog`).

---

## Quota

Google's Indexing API quota is counted **per Google Cloud project**, not per Google account:

- Publishes made with **service accounts** are tracked per service account (`dailyQuotaLimit`, default 180).
  Service accounts in the *same* Cloud project share one quota, so adding more of them only adds capacity
  if they belong to different projects.
- Publishes made with **users' OAuth tokens** all count against your OAuth client's project. They share one
  daily budget, `OAUTH_DAILY_PUBLISH_LIMIT`.
- Quotas reset at **midnight Pacific Time** (DST-aware), not UTC.

Check the real numbers in Cloud Console → APIs & Services → Web Search Indexing API → Quotas.
If the default 200/day isn't enough, request an increase there.

---

## Index status checks

A cron (`INDEX_CHECK_CRON`, default every 15 min) checks only jobs that are due:
first check `INDEX_CHECK_FIRST_AFTER_MINUTES` (20) after the API call, then every 30 min for the
first 6 hours, every 2 hours up to 24 hours, then every 6 hours. This keeps early confirmation fast
while staying well inside the Search Console URL Inspection quota.

---

## Secondary crawl signals

After a successful publish the wrapper sitemap/RSS are refreshed and submitted through the Search
Console API (max once per 5 min; needs the platform service account to be an Owner of the `BASE_URL`
property — set `PLATFORM_GSC_SITE_URL` if you verified a Domain property). Google's old `/ping`
endpoint was retired in 2023 and is no longer used.

Optionally set `INDEXNOW_KEY` to also submit wrapper URLs to IndexNow (Bing, Yandex, …). IndexNow
only accepts URLs on the host that serves the key file, so this covers wrapper URLs, not customers' own.

---

## Environment Variables

See `.env.example` for the full reference with descriptions.

Key variables:
```
GOOGLE_OAUTH_CLIENT_ID      — from Google Cloud Console
GOOGLE_OAUTH_CLIENT_SECRET  — from Google Cloud Console
GOOGLE_OAUTH_REDIRECT_URI   — must match what's in Google Console

PLATFORM_SA_EMAIL           — platform service account (publishes to the Indexing API)
PLATFORM_SA_PRIVATE_KEY     — its private key
PUBLISH_CREDENTIAL_MODE     — platform | platform_first | user_first
```

---

## Tests

### Unit tests — `npm test`

Pacific-time quota reset (including DST), the status-check schedule, and the publish flow
(outcome classification, credential fallback order). Mocks only — no MongoDB, Redis or Google needed.

### Integration tests — `npm run test:integration`

Run the real app (Express, Bull worker, cron, Mongoose models) against a **real MongoDB and Redis**.
Only Google's network edge is faked, and any request to anything else is blocked, so a run can never
reach the internet. They cover the whole product flow (submit → queue → wrapper → publish → confirm →
charge), quota deferral and recovery, credential fallback, retries, the cron, the HTTP API, auth,
rate limiting behind a proxy, and database constraints.

They **delete data**, so they are guarded:

- By default they create a random `indexmenow_it_<id>` database and drop it afterwards. The database name in
  `TEST_MONGODB_URI` is ignored, so your real database is never touched.
- To use an existing dev database, name it and confirm: `TEST_DB_NAME=mydb CONFIRM_WIPE_DB=mydb`.
  Its collections are emptied before and after.
- A non-local MongoDB/Redis needs `ALLOW_REMOTE_TEST_DB=1`.
- The Bull queue uses its own random key prefix, so a shared Redis is safe.

```bash
export TEST_MONGODB_URI=mongodb://127.0.0.1:27017   # or an Atlas URI (then also ALLOW_REMOTE_TEST_DB=1)
export TEST_REDIS_HOST=127.0.0.1 TEST_REDIS_PORT=6379
npm run test:integration
```

Needs Node 20+. Against Atlas the suite takes several minutes (network round trips).

These tests found a real bug: the duplicate-submission unique index on `UrlJob` used `$nin` in its
partial filter, which MongoDB rejects (`CannotCreateIndex`), so the index was never built. It now uses
`$in` over the active statuses (MongoDB 6.0+). When you first start the fixed backend against a database
that already contains two active jobs for the same user and URL, that index build will fail until one of
them is removed.
