# stream-ingest

Server-side, always-on chat ingestion and normalization for every platform the streamer uses, and
the host process for the site's chat bot and help desk. It owns the platform tokens, the viewer poll
and stream lifecycle detection. OBS, alerts, TTS and support events are `stream-api`'s (`obs.js`,
`alert.js`, `tts.js`). An install runs it as the bundle's `stream-ingest` service (`../install/`).

## What it does

```
Twitch (tmi.js IRC)     ─┐
Kick   (Centrifugo WS)  ─┼─► lib/pipeline.js
YouTube (web chat)      ─┤     strip emotes + word count
stream.place            ─┘     POST /chat  (stream-api, emotes + reply inline)
                               → the bot and the help desk (through the AI adapter's slots)
```

`stream-api` stays the sole Postgres owner. Ingestion, normalization and the bot live here.

## Layout

| Path | Purpose |
|------|---------|
| `index.js` | entry: start enabled platforms, the poller, the bot; the one seam to an install's owner plugin (`owner/`) |
| `lib/pipeline.js` | per-message orchestration |
| `lib/emotes.js` | `stripEmotes` / `cleanWordCount` |
| `lib/embeddings.js` | memory: embeds new messages through the `embeddings` AI slot, gated on `memory.state` being on. A wrong-length vector or a refused key PAUSES memory with one alarm (stream-api writes the state) |
| `lib/api.js` | stream-api client (Bearer auth) |
| `lib/session.js` | resolves the active `streamId` |
| `lib/poller.js` | live-state + viewer poll; posts `/stream/start` and `/stream/end`. See *Stream lifecycle* below |
| `lib/twitchToken.js` | app-token refresh (rotations persisted under `config/`, written at run time) |
| `lib/workQueue.js` | bounded background work |
| `lib/ytWatchdog.js` | YouTube poll health |
| `lib/alerts.js` | platform monetization → `stream-api` `/alert` |
| `lib/bot/`, `lib/helpdesk/` | the product's chat bot and help desk |
| `platforms/{twitch,kick,youtube,streamplace}.js` | connectors |
| `vendor/socialstream/` | a pinned upstream module with marked local extensions (see `VENDOR.md`); `platforms/twitch.js` uses its `chatClient.js` |

## Setup

In an install everything is set by the bundle and the setup pages. For development:

```sh
cp .env.example .env
npm install
npx playwright install chromium   # YouTube + Kick viewer reads
npm start
```

`STREAM_API_SECRET` must match stream-api's: with it missing the service still starts and every
POST is refused, so ingest runs dark. Platforms come from the settings the setup pages write (a
platform is read whenever its channel is set); `PLATFORMS=` in `.env` overrides that. An
unrecognized name there is ignored and reported on the boot line (`lib/platformsEnv.js`).

## Platforms

[`docs/PLATFORMS.md`](docs/PLATFORMS.md) has per-platform message schemas, identity anchors and
send-back mechanisms. Trust the connectors over its capability matrix where they disagree.

## Stream lifecycle

`lib/poller.js` opens and closes the `stream.sessions` row as an **OR across Twitch, YouTube and
Kick**: any one of them going live opens or sustains the session, and it closes only once **every
configured platform has independently confirmed offline**. (Gated on one platform alone, a streamer
who ends that feed and keeps streaming elsewhere would watch the site drop every viewer to the
offline fallback.)

Each platform reports one of three states, and the distinction is the whole point:

| state | means | vote |
|---|---|---|
| `live` | confirmed streaming | opens/sustains the session immediately — never debounced |
| `offline` | the platform's API **answered**, and said not streaming | counts toward closing, after `2` consecutive readings |
| `unknown` | the poller could not ask, or could not read the answer | votes **neither way** and never advances the offline count |

A platform with no credentials is excluded from the vote entirely — that is *not* the same as a
permanent `unknown`, which would make "every platform confirmed offline" unreachable and leave the
session open forever. The corollary: while a platform's API is **erroring**, the session will not
close. That is deliberate (it fails toward keeping viewers watching), and it is safe because
`stream-api`'s `liveState()` independently requires a `viewer_snapshots` row newer than 10 minutes —
so the *site* still reads offline even if the session row lingers.

stream.place has **no liveness vote** — viewer count only.

### Poll cadence

| var | default | |
|---|---|---|
| `VIEWER_POLL_MS` | `60000` | while a session is open |
| `VIEWER_IDLE_POLL_MS` | `180000` | while nothing is live — the always-on Kick/Twitch checks are cheap at this rate |
