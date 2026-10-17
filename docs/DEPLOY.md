# Deploying Memes Arcade

There is no build step and no bundler. The only runtime dependency is
[`pg`](https://www.npmjs.com/package/pg), and only when a `DATABASE_URL` is
set - without one the arcade still runs from a JSON file with nothing to
install. `npm install` fetches `pg` for a hosted deploy.

---

## Render, on the free plan

The whole arcade - API, website and WebSockets - is **one Node web service**,
and one free instance runs it. `render.yaml` in the repo root is a Render
Blueprint: Render reads it and creates the service plus a Free Postgres
database, with the right start command, health check and environment
variables. It asks for nothing paid, but see **the 30-day database** below:
Free Postgres is a trial, not a permanent home.

### 1. Get the project into its own repository

Render reads `render.yaml` from the root of the repo you connect, so the project
has to *be* that repo:

```bash
cd "memes arcade"
git init
git add .
git commit -m "Memes Arcade"
git remote add origin https://github.com/YOUR-NAME/memes-arcade.git
git push -u origin main
```

`data/` (accounts, saves, the signing key) and `.env` are gitignored, so no
passwords go up. Render starts with an empty data directory and seeds your owner
account on first boot.

### 2. New → Blueprint → pick the repo → Apply

Render lists the service from `render.yaml` and prompts for the values marked
`sync: false` - that is `MEMES_ADMIN_PASS`, your owner password
(`MEMES_ADMIN_USER` defaults to `memegodmidas`). **Fill it in:** on a free
service the generated password file does not survive a spin-down, so this is
the only way back into your own account.

### 3. What "free" actually means

| Free, and used here | Paid, and avoided here |
|---|---|
| One Node web service: 0.1 CPU / 512 MB | Persistent disk - so `data/` is ephemeral |
| One Free Postgres: 1 GB, **expires after 30 days** | Keeping that database past 30 days (~$6/mo) |
| Matches over WebSockets, custom domains, TLS | Background worker (the Discord bot) |
| 750 instance hours per workspace per month | A second always-awake service (2 × 730 h) |
| Auto-deploy on every commit | Scaling past one instance, SSH shell |

Three free-tier behaviours decide how the arcade feels:

- **It sleeps.** 15 minutes with no request and the service spins down; the next
  visitor waits about a minute for it to wake. Rooms, parties and matches live
  in the process's memory, so a woken server is a fresh one.
- **Its disk is wiped on every deploy, restart and spin-down.** Logs, saved
  games and `data/ADMIN-CREDENTIALS.txt` reset with it. Accounts, ideas, rooms
  and the bot's server memory live in Postgres instead - keep
  `MEMES_ADMIN_PASS` set, because the credentials file does not survive.
- **The database is a 30-day trial.** Render gives one Free Postgres per
  workspace. It is deleted 14 days after its 30-day expiry unless you upgrade
  it in the dashboard (Instances → the database → change plan, about $6/mo for
  `0.1c-256mb` with a 1 GB disk). If it disappears the arcade still starts: it
  logs that Postgres was unreachable, serves from the ephemeral file, and
  `/api/health` says `"store":"file-fallback"`. Upgrade before the date, not
  after.
- **Some Blueprint fields are refused outright.** `maxShutdownDelaySeconds` is
  rejected with "max shutdown delay is not supported for free tier services",
  and `diskSizeGB` on the database with "plan Free cannot change disk size" -
  even though both are in the published schema, so they only fail at apply time.
  The blueprint leaves them out: SIGTERM still reaches the server (which closes
  and flushes its store within the free tier's own grace window), and a Free
  Postgres comes up at its fixed 1 GB on its own. `tools/blueprint-check.mjs`
  treats both fields as free-tier-rejected, so re-adding one fails the build
  instead of the apply.

Render's own docs say free instances are for hobby projects - which is exactly
what this is.

### Where the data lives

There are no migrations to run: the whole store is one JSONB row in
`memes_arcade_store` (id `db`), created on first boot. That is deliberate - every
store call reads one in-memory tree synchronously, so keeping the document
intact makes accounts, parties, ideas and the bot's server memory durable
without turning every engine's save path into async code.

- **Hosted:** `DATABASE_URL` comes from the Blueprint's database and
  `/api/health` returns `"store":"postgres"`. Writes are debounced and
  serialised: a busy room is one upsert about every 1.2s, never one per action,
  and the last change is flushed on shutdown.
- **Local, no database:** leave `DATABASE_URL` unset and the store is
  `data/db.json` (atomic temp + rename, previous file kept as backup), exactly
  as before - what `npm start`, the desktop launcher and every check suite use.
- **Local, with a database:** `MEMES_DATABASE_URL=postgres://... npm start`. An
  empty database imports the existing `data/db.json` once on first boot.
- **Fallback:** a database that cannot be reached is logged, the server stays up
  on the file and reports `"store":"file-fallback"`; the next boot with a
  working URL reads the database again.

Inspect it in the Render shell or with `psql`:

```sql
SELECT revision, updated_at, pg_size_pretty(pg_total_relation_size('memes_arcade_store'))
FROM memes_arcade_store WHERE id = 'db';
```

`npm run dbcheck` proves both backends without a server: the file seed / write /
reload and backup fallback, the create / select / upsert SQL, serialised writes,
the flush on close, and the unreachable-database fallback.

### 4. Check the blueprint before you push

```bash
npm run blueprintcheck
```

It parses `render.yaml` and proves everything in it is legal on the free plan
(web service with `plan: free`, no disk, no autoscaling, one instance, no field
Render refuses on a free instance, and at most one database, which must be
`plan: free` and carry no field a free database refuses - `diskSizeGB` included),
then checks the build/start commands, the
health path, that the database is actually handed to the service, and every
environment variable against the code. It runs in CI *and* inside the
Blueprint's own build command, so a change that starts asking for paid resources
fails the deploy instead of the billing page.

### 5. Open it

`https://<service-name>.onrender.com`. The first load seeds your owner account.
Sign in, then **Admin → Server settings** to set the MOTD and close
registrations (`MEMES_REGISTRATIONS=closed`) once your friends have joined.

### Deploys reaching the people already there

Nobody has to be told to refresh. The server fingerprints the assets it serves
(`server/lib/build.js`) and every client keeps the stamp it booted on. When a
later one differs the tab moves itself: out of sight if nobody is looking and no
match is running, otherwise with a **Reload** button - never mid-rally.

The socket is the fast path (the stamp rides the welcome and every config push,
so a reconnecting tab learns immediately) and `GET /api/build` is the backstop
for a tab that has been sitting on the same page for a while.

The fingerprint is path + size + mtime. A deploy that rewrites a file without
changing either would be invisible, so set a revision too when you can:

```bash
MEMES_REVISION=$(git rev-parse --short HEAD)
```

Any change to that value moves the stamp on its own. `MEMES_ASSET_DIR` points the
fingerprint at a different tree, for a setup where the server does not serve the
directory it ships.

### 6. The Discord bot

The website starts the bot for you. Put `DISCORD_TOKEN` in the service's
Environment (Render → your service → Environment) and the site launches
`bot/index.js` once it is listening, hands it the port it bound and its own
`MEMES_BOT_SECRET`, and stops it when the site stops. There is no second
command to run and nothing to copy into `bot/.env` on the server.

The bot runs in the site's process tree, so it is online exactly when the site
is. On a free instance the service sleeps after a spell without traffic and the
bot sleeps with it - which suits an arcade used in bursts. A paid always-on
instance keeps both up.

If you would rather keep the bot online from your own PC (free), run it at home
against the deployed site - and switch the built-in copy off first, or two bots
would answer every command:

```bash
# in the service's Environment, so the site does not start a second copy
MEMES_BOT_AUTOSTART=off

# then, on your PC, pointed at the deployed service
ARCADE_URL=https://<service-name>.onrender.com \
ARCADE_BOT_SECRET=<MEMES_BOT_SECRET from the service's Environment tab> \
DISCORD_TOKEN=<your bot token> \
npm run bot
```

`MEMES_BOT_SECRET` is generated by the Blueprint (`generateValue: true`) and
stays stable across redeploys, which is exactly why it is set there: the
`data/bot-secret.txt` fallback is wiped whenever the free service sleeps. A
site-started bot uses that same secret automatically.

The bot also reports the servers it is in (`POST /api/bot/guilds`, same bot
secret), which is what fills **Admin console → 🤖 Discord bot → 🌐 Servers**.
On a free service that sleeps, expect the list to show **stale** until the bot's
next check-in (`BOT_GUILD_REPORT_MS`, five minutes by default) after the service
wakes - a sleeping arcade cannot store anything. Nothing else needs to be opened
up: the token stays in the server process, never in the browser or the database.

### The bot is not online: ask /api/health first

A bot that never comes online is invisible unless you read the host's logs -
so the health endpoint answers the question directly:

```bash
curl https://<service-name>.onrender.com/api/health
# {"ok":true,"store":"postgres","bot":{"running":false,"reason":"exited with code 3 - Discord rejected the token"},...}
```

`bot.reason` is the whole story:

- `no DISCORD_TOKEN in bot/.env or the environment` - the variable is missing on
  *this service*. A `bot/.env` on your PC is not deployed with it.
- `MEMES_BOT_AUTOSTART is off` - the switch that keeps a home-run bot from being
  duplicated here is on.
- `exited with code 3 - Discord rejected the token` - the token is wrong, or it
  belongs to a different application. A token pasted with a trailing newline is
  trimmed (the log says when that happened), but a genuinely wrong token cannot
  be fixed from here: reset it in the Developer Portal and paste the new one.
- `gave up after 5 failed starts (...)` - five quick failures in a row and the
  supervisor stops retrying, so a broken configuration cannot hammer Discord.
  Fix the token and **restart the service**; it does not re-arm itself.
- `started with the site` plus `running: true` - the bot is up. If Discord still
  shows it offline, the service is asleep: send the arcade a request to wake it.

**Admin console → 🤖 Discord bot** shows the same state beside the server list
(`bot running` / `bot off` with the reason), so nobody has to open a terminal.

Players can always type `!memearcade <command>` instead of waiting for the slash
commands to roll out. That fallback reads channel messages, so tick **Message
Content Intent** under the application's *Bot → Privileged Gateway Intents*.
Without it the bot logs the missing switch, reconnects without the intent and
keeps the slash commands (and DMs) working - it never goes offline over it.

### Keep the free arcade awake (so the bot stays online)

A free instance spins down after **15 minutes with no inbound HTTP traffic**, and
the Discord bot lives in that process - so a sleeping arcade is an offline bot.
Render's own health checks and the bot's outbound WebSocket do not count as
activity; an external request is what keeps it up.

**What it costs.** Free web services share **750 instance hours per workspace per
month**, and only running time counts. One always-awake service fits: 720 h in a
30-day month, 744 h in a 31-day month. Anything else free in the same workspace
shares the same 750, and exhausting them **suspends every free web service until
the next month** (the allowance resets; Render does not bill the overage). If
that trade is not worth it, run the bot at home instead with
`MEMES_BOT_AUTOSTART=off` (see "The Discord bot" above).

**The ping.** The server has a route for exactly this - public, reads nothing
from the store and is never cached:

```
https://<service-name>.onrender.com/api/ping     ->  {"ok":true,"pong":true,"at":...}
```

**Setup (Better Stack, free):** create an account, add an **HTTP monitor** with
that URL, method **GET**, interval **3 minutes** (the free cadence), and treat
**2xx as up**. Check the Render logs once to see the requests arriving. Do not
ping `/robots.txt` - Render answers that one itself while a service is asleep,
so it neither wakes it nor counts.

Alternatives, with their catches:

| Pinger | Free cadence | Catch |
|---|---|---|
| **Better Stack** | 3 minutes, 10 monitors | Best margin; no punctuality guarantee |
| **UptimeRobot** | 5 minutes, 50 monitors | No margin against a 15-minute window, and its HTTP monitors default to **HEAD** - choose GET |
| **cron-job.org** | every minute | Its own FAQ disclaims punctuality and mentions deliberate delays |
| **Cloudflare Worker** (cron trigger) | every minute | You own the schedule and the code; needs a Cloudflare account and a tiny deploy |
| **GitHub Actions** (`schedule:`) | 5 minutes | Not dependable: GitHub documents delayed and dropped scheduled runs, and disables schedules after 60 days of repo inactivity |

No free monitor promises punctuality, so treat this as *much less likely to
sleep*, not as a guarantee: a late or dropped check lets the service spin down,
and the next check wakes it about a minute later. When it does sleep, the bot
reconnects on its own and the server list catches up on the next report.

---

## Paid upgrades (optional)

Everything below needs a paid instance type. The guard in
`npm run blueprintcheck` blocks paid resources on purpose, so a deliberate
upgrade means telling it you meant it: set `MEMES_BLUEPRINT_PAID=1` in the
service's environment (and add it to your shell when running the guard locally).

**Keep the data.** Attach a disk and point `MEMES_DATA` at it, then raise the
plan so the disk is allowed:

```yaml
    plan: 0.5c-512mb
    disk:
      name: memes-data
      mountPath: /var/data
    envVars:
      - key: MEMES_DATA
        value: /var/data
```

**Keep the bot online 24/7.** On an always-on instance the site's built-in bot
is already up whenever the site is: set `DISCORD_TOKEN` on the web service and
there is nothing else to run.

If you would rather keep the bot in its own service - to restart it without
touching the site, or because it lives on another machine - add a worker and
switch the built-in copy off on the web service (`MEMES_BOT_AUTOSTART=off`), or
the two would both answer every command:

```yaml
  - type: worker
    name: memes-arcade-bot
    runtime: node
    plan: 0.5c-512mb
    buildCommand: npm run check
    startCommand: npm run bot
    envVars:
      - key: DISCORD_TOKEN
        sync: false
      - key: ARCADE_URL
        sync: false          # https://<service-name>.onrender.com
      - key: ARCADE_BOT_SECRET
        fromService:
          type: web
          name: memes-arcade
          envVarKey: MEMES_BOT_SECRET
```

Free web services cannot *receive* private-network traffic, so a worker on a
paid plan can reach the site privately but a free one only over its public URL -
which is why `ARCADE_URL` above is the public address.

---

## Other hosts

**Railway / Fly / Heroku-style**: set the start command to `npm start` and let
the platform inject `PORT`. The server binds `0.0.0.0` and never falls back to
another port when `PORT` is set by the platform.

**A VPS / your own PC**: `npm start` and open `http://localhost:8787`. Share the
"Same wifi" address the banner prints for LAN play.

**Docker**: any `node:20-alpine` image works -

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
EXPOSE 8787
CMD ["npm", "start"]
```

Mount a volume at `/app/data` to keep accounts across container rebuilds.

---

## Playing over the internet without hosting

Run the arcade locally and put a tunnel in front of it:

```bash
npm start
npx cloudflared tunnel --url http://localhost:8787
```

Then set `MEMES_PUBLIC_URL` to the tunnel URL so invite links point at it.

---

## Verifying a deployment

```bash
curl https://your-arcade.onrender.com/api/health     # {"ok":true,"store":"postgres",...}
curl https://your-arcade.onrender.com/api/meta       # version + catalog
npm run smoke -- https://your-arcade.onrender.com    # full check
```

The smoke test signs in as a guest, lists games, opens a room and plays a move -
if it passes, real players will be fine. On a sleeping free service the first
request wakes it, so give the first call a minute.

---

## Security checklist for a public server

- [ ] `MEMES_ADMIN_PASS` set to something real (never the generated one)
- [ ] `MEMES_REGISTRATIONS=closed` once everyone has an account
- [ ] `MEMES_ADMIN_TOKEN` set if the server is genuinely public
- [ ] `MEMES_CORS_ORIGINS` restricted to your domain
- [ ] `/api/health` reports `"store":"postgres"` (not `file-fallback`)
- [ ] Free Postgres upgraded before its 30-day expiry, or accepted as a trial
- [ ] Change the admin password after first sign-in (Settings → Account)
- [ ] `npm run blueprintcheck` clean, so the deploy stays free
