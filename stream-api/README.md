# stream-api/ — the live backend

The site's live server: Express on HTTP and a WebSocket on the same port (3001). It takes chat from
the chat service (`../stream-ingest/`) and from the site's own chat, stores it, and broadcasts it to
every open page and overlay; it keeps the support and points ledger, fires alerts, drives OBS and
read-aloud, and serves the overlay pages. The site (`../web/`) and the chat service call it with a
shared secret (`STREAM_API_SECRET`); `.env.example` lists every value it reads.

## Running it

```bash
npm ci
npm start              # node index.js
npm test               # node --test
npm run check:all      # eslint, the dead-export gate, the literal gate, the plugin-seam gate, the generated-schema check
```

In an install it runs as the bundle's `stream-api` service (`../install/compose.yaml`). The database
tests (`*.db.test.js`) skip without a throwaway database; `../tools/public-suites.sh` builds one from
the baseline the way an install does and runs every suite against it.

## Where things are

`index.js` is the composition root: it wires the modules together and holds no route logic of its
own. The routes live in the modules, grouped here by job:

- **Chat and people:** `chat.js` (the chat hub), `chat-mod.js`, `chat-dedup.js`, `chat-screen.js`,
  `identity.js` (one person across platforms), `names.js`, `pronouns.js`, `profiles.js`,
  `account-age.js`, `blacklist.js`, `blocklist-review.js`, `link-gate.js`, `automod.js`,
  `ban-hold.js`, `ingest-pause.js`, `poll.js`, `ws-hub.js` (the WebSocket), `native-platform.js`.
- **Privacy:** `pseudonym.js` (the public id each person shows), `account-erase.js` (the backend
  half of "Delete my account"), `memory.js` (opt-out, forget, retention).
- **Money:** `money.js`, `money-bus.js`, `economics.js` (what a payment is worth after fees),
  `supportbar.js`, `webhooks.js` (Ko-fi, Patreon, Streamlabs), `alert.js`, `sponsors.js`, `timer.js`,
  `night-math.js`, `night-liveness.js`, `lifecycle.js` (stream start and end), `aggregates.js`.
- **Voice, sound and OBS:** `tts.js`, `tts-tiers.js`, `sounds.js`, `obs.js`, `rig.js`, `rig-sink.js`,
  `audio-satellite.js`, `audio-satellite-client.js`, `overlays.js`, `overlay-page.js` and the
  `overlay-*.html` pages.
- **Settings and plumbing:** `instance-config.js` (settings from the Admin Panel), `modules.js`
  (module switches), `content.js`, `ai.js`, `helpdesk-relay.js`, `notify.js`, `episode-log.js`,
  `twitch-app.js`, `auth.js` (the shared-secret check), `db-pool.js`, `listen-address.js`, and
  `plugins.js` — the one place an optional plugin folder is loaded from.

Files named `*.generated.js` are written by `../tools/gen-instance-schema.mjs` from `../config/`;
never edit them by hand. `route-surface.snapshot.json` pins every route and its access rule, and the
suite fails when one appears, disappears or changes who may call it.
