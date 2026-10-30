# Deploying the backend on a server

One server (or a platform such as Render) runs the Node backend. The database is MongoDB Atlas
(whatever `MONGODB_URI` in `.env` points to), the queue is Redis, and a reverse proxy in front
of the app terminates HTTPS:

```
Internet ─▶ reverse proxy (Caddy/Nginx, HTTPS) ─▶ node dist/server.js (Express + queue worker + cron)
                                                    ├─▶ Redis (queue)
                                                    └─▶ MongoDB Atlas (MONGODB_URI)
```

Only the reverse proxy is exposed. Redis must never be reachable from the internet.

The frontend is separate: keep it on Vercel, or host it anywhere. It only needs
`NEXT_PUBLIC_API_URL=https://<your domain>`.

## What you need

- A Linux server (Ubuntu 22.04+ is fine), **2 GB RAM or more**, with **Node 20** and a Redis server
- A **domain** with an A record pointing at the server's IP. Googlebot must reach
  `https://<domain>/job/...`, so a real domain with HTTPS is required (not a bare IP)
- A reverse proxy that serves `https://<domain>` and forwards to the app's `PORT`
  (Caddy gets and renews the certificate automatically)
- Ports **80 and 443** open

## 1. Get the code and configure

```bash
git clone https://github.com/ahadverse/indexmyurl-backend.git indexmenow && cd indexmenow
cp .env.example .env            # app settings and secrets — edit it (below)
npm ci
npm run build
```

`prod.env` (next to `.env.example`, not in git) is a ready-made production template. Fill in every
`CHANGE_ME` and the service-account key, then put it on the server as `.env` instead of editing the
copy of `.env.example` (`scp prod.env user@server:indexmenow/.env`). Whichever you use, `.env` must set at least:

| Variable | Value |
|----------|-------|
| `NODE_ENV` | `production` |
| `PORT` | the port your reverse proxy forwards to |
| `BASE_URL` | `https://<domain>` |
| `GOOGLE_OAUTH_REDIRECT_URI` | `https://<domain>/api/oauth/google/callback` |
| `TRUST_PROXY` | `1` when one reverse proxy is in front (needed for per-user rate limiting) |
| `MONGODB_URI` | your Atlas connection string, used as-is |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | your Redis |
| `JWT_SECRET`, `ADMIN_SECRET_KEY` | long random strings (`openssl rand -hex 32`) |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | from Google Cloud Console |
| `FRONTEND_URL` | exact URL of your frontend, e.g. `https://indexmyurl.vercel.app` (used for CORS) |
| `PLATFORM_SA_EMAIL`, `PLATFORM_SA_PRIVATE_KEY`, `PLATFORM_SA_PROJECT_ID` | the publishing service account. Put the key on one line with literal `\n` between lines |

**Redis settings.** Run Redis with `--appendonly yes --maxmemory-policy noeviction`. Bull requires
`noeviction`, and the append-only file keeps queued/delayed jobs across a restart.

**Atlas must allow the server.** In Atlas → *Network Access*, add the server's public IP.
Without it the API can't reach the database and exits at startup with a connection timeout.

## 2. Google setup (once)

1. **Cloud Console → Credentials → your OAuth client:** add
   `https://<domain>/api/oauth/google/callback` as an authorized redirect URI.
2. **Cloud Console → APIs:** make sure *Web Search Indexing API* and *Google Search Console API*
   are enabled in the service account's project.
3. **Search Console:** add `https://<domain>/` as a property and verify it, then
   *Settings → Users and permissions → Add user* → the service account's email → **Owner**.
   Google only accepts a publish request from an Owner of the property containing the URL,
   and the wrapper pages live on this domain. Without this, every publish is rejected with 403.

## 3. Start

Run the compiled app under a process manager that restarts it and stops it with SIGTERM
(systemd, pm2, or your platform's own):

```bash
NODE_ENV=production node dist/server.js
```

Start `node` directly rather than through `npm start`, so SIGTERM reaches the app and its
graceful shutdown runs. Logs are written to `logs/`, which the app's user must be able to write to.

Then check:

```bash
curl -s https://<domain>/health        # {"status":"ok",...}
curl -s https://<domain>/robots.txt
```

In the API log you should see `MongoDB connected`, `Platform service account seeded` and
the cron schedules. If you see `fallback pool empty`, the service-account variables are empty.

## Operating it

| Task | How |
|------|-----|
| Logs | `logs/` in the app folder, or your process manager's log command |
| Update | `git pull && npm ci && npm run build`, then restart the process |
| Restart | restart through your process manager |

**Keep one app instance.** The cron jobs and queue worker run inside it, so scaling to
two instances would run every cron twice.

### Backups

The data lives in Atlas, so use Atlas backups (Cloud Backup on a paid tier, or scheduled
`mongodump --uri "<atlas uri>"`). Redis holds only queue state, and the recovery cron
re-queues jobs if it is ever lost, so it doesn't need separate backups.

### Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

Don't open Redis (6379) or the app's own `PORT`; keep Redis bound to `127.0.0.1` and let only
the reverse proxy reach the app.
