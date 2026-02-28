# IndexMeNow — SaaS URL Indexing Service

A production-ready SaaS backend that indexes URLs in Google using the Indexing API with a JobPosting wrapper technique. Each user connects their own Google account — their credentials are used for API calls, so you never worry about quota.

---

## Architecture

```
User connects Google Account (OAuth)
         ↓
User submits URL via API
         ↓
Pre-check: already indexed? → return INDEXED (no credit charged)
         ↓
Reserve credit → Create job → Queue (5–15 min smart delay)
         ↓
Worker: Create JobPosting wrapper → Call Google Indexing API
         ↓
Cron (every 4h): GSC check → INDEXED? → Deduct credit ✅
         ↓
Not indexed? → Retry (up to 3x, min 24h wait)
         ↓
7 days / 3 retries exceeded → FAILED → Refund credit
```

---

## Credential Priority (per API call)

```
1. User's OAuth token (domain-specific match)
2. User's OAuth token (any active token)
3. Platform service account pool (fallback)
```

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
   - Authorized redirect URIs: `http://localhost:3000/api/oauth/google/callback`
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

---

## API Reference

### Auth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | No | Register, get API key + 5 free credits |
| GET | `/api/auth/me` | Yes | Get profile & credit balance |
| POST | `/api/auth/regenerate-key` | Yes | Get new API key |

### Google OAuth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/oauth/google` | Yes | Get Google consent URL |
| GET | `/api/oauth/google/callback` | No | OAuth callback (Google redirects here) |
| GET | `/api/oauth/google/accounts` | Yes | List connected Google accounts |
| POST | `/api/oauth/google/sync` | Yes | Re-sync GSC properties |
| DELETE | `/api/oauth/google/:accountId` | Yes | Disconnect Google account |

### URL Indexing
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/urls/submit` | Yes | Submit URL for indexing |
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
2. GET  /api/oauth/google        → get authUrl
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

## Quota Math

Each Google account gets ~200 Indexing API calls/day. With user OAuth:
- 1000 users × 10 URLs/day = 10,000 calls — all spread across users' own quotas
- Your platform service accounts = only fallback for users without OAuth

---

## Environment Variables

See `.env.example` for full reference with descriptions.

Key variables:
```
GOOGLE_OAUTH_CLIENT_ID      — from Google Cloud Console
GOOGLE_OAUTH_CLIENT_SECRET  — from Google Cloud Console
GOOGLE_OAUTH_REDIRECT_URI   — must match what's in Google Console

PLATFORM_SA_EMAIL           — optional: fallback service account
PLATFORM_SA_PRIVATE_KEY     — optional: fallback service account key
```
