# Black Hull Syndicate Bot Handoff

Last updated: 2026-04-12

## Role of the bot
The bot is the Discord-facing execution layer for:
- AFK radio playback
- slash commands
- ops reminders and reminder cleanup
- RSI-related watchers
- website-backed lookups and admin tools
- Discord media handling through internal media API

The bot is not the canonical authority for ranks, roster, or ops state. It should call the website for canonical decisions and updates.

---

## Core architecture
Main files:
- `index.js`
- `internal-api.js`

### `index.js`
Main runtime responsibilities:
- Discord client startup
- slash command registration / handling
- voice/radio logic
- watcher loops
- ops reminder worker
- bot→website request helpers

### `internal-api.js`
Main responsibilities:
- internal Express API
- receives media sync events from website
- posts / edits / deletes media Discord content

---

## Important operational rule
For bot-related file changes, always provide:
1. replacement file(s)
2. restart command in the same response

Standard restart command:

```bash
pm2 restart black-hull-radio
```

Useful checks:

```bash
pm2 list
pm2 logs black-hull-radio --lines 50
```

If old crashes are cluttering logs:

```bash
pm2 flush
pm2 restart black-hull-radio
pm2 logs black-hull-radio --lines 50
```

---

## Website integration model
The bot should call website internal routes for canonical information and actions such as:
- rank changes
- auth diagnostics
- member lookup
- removed roster lookup
- admin queue
- ops admin actions
- ops reminders feed
- ship / fleet / roster data

The bot should send actor identity for sensitive internal routes so the website can validate the requester.

---

## Bot fixes applied in the latest audit

### 1) Reminder fresh-state seeding fix
`index.js`
- fresh reminder state no longer consumes future reminder windows for existing upcoming ops

### 2) Forced reminder tracking
`index.js`
- forced reminders now enter normal reminder state tracking
- scheduled forced reminders consume their timing window
- `now` forced reminders are tracked for cleanup without consuming later scheduled windows

### 3) Website request timeout / fault handling
`index.js`
- website calls now time out instead of hanging indefinitely
- clearer timeout / transport / bad-status messages
- timeout configurable with `BHS_SITE_TIMEOUT_MS`

### 4) Graceful `memberlookup`
`index.js`
- uses partial-failure behavior instead of all-or-nothing failure

### 5) `media.updated` duplicate prevention
`internal-api.js`
- update events now edit existing Discord content instead of creating duplicates
- safe-fail behavior if original message reference is missing

### 6) Actor identity added to sensitive website reads
`index.js`
- bot now sends `actorDiscordUserId` for:
  - `adminqueue`
  - `memberlookup`
  - `removed`
  - `authcheck`

---

## Runtime expectations

### Healthy startup should show
Examples of expected healthy startup lines:
- internal API listening
- bot logged in
- slash commands registered
- voice connection ready
- watcher ready messages
- ops reminder watcher ready

### Reminder behavior
Expected behavior now:
- future reminder windows should survive fresh state file creation
- timed forced reminders should not duplicate later when automatic watcher hits same window
- tracked reminders should clean up as the next reminder posts or op leaves the feed

### Media updates
Expected behavior now:
- `media.approved` creates post/thread as designed
- `media.updated` edits existing post when message reference exists
- `media.removed` removes tracked Discord content

---

## Deployment / upload notes
Typical server location used historically:
- `/home/ubuntu/discord-afk-bot/`

Typical Windows PowerShell upload pattern:

```powershell
scp -i "C:\path\to\key.pem" "C:\path\to\index.js" "C:\path\to\internal-api.js" ubuntu@SERVER_IP:/home/ubuntu/discord-afk-bot/
```

Typical restart:

```powershell
ssh -i "C:\path\to\key.pem" ubuntu@SERVER_IP "pm2 restart black-hull-radio && pm2 logs black-hull-radio --lines 50"
```

---

## Remaining bot risks / next work
- `index.js` is still large and should eventually be decomposed
- feed watcher parsing can still warn on changing upstream content formats
- future work could further modularize command handlers, reminder state, and website transport helpers

## Important warning for future changes
Do not move rank authority into the bot. Keep the bot as the Discord-facing client of the website authority model.

