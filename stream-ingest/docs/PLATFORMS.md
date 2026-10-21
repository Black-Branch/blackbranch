# Platform Data Reference

Authoritative reference for what each platform connector delivers, the exact
message schemas, identity anchors, reply/emote/role data, send-back mechanisms,
and the gaps to close. This is the foundation for the downstream features:
**reliable reply formatting, data collection, embeddings, bot responses,
connected accounts, and cross-posting.**

Status legend: **yes** verified live · **unwired** available but not yet wired · **no** not available

Keep this in sync when a connector changes.

---

## Capability matrix

| Capability | Twitch | Kick | YouTube | stream.place |
|---|---|---|---|---|
| Transport | tmi.js IRC WS | Kick's Centrifugo WS | Playwright DOM | own chat WS |
| Browser needed | no | no (yes for id lookup) | **yes** | no |
| Stable user ID | `user-id` | `sender.id` | Data-API backfill (channelId) | **DID** |
| Username | display-name | username | author name | handle |
| Emotes (per-msg) | yes | yes | yes | unwired: facets TBD |
| Native replies | tags | unwired: `metadata` | none | ATProto refs |
| Mod/role flags | yes | yes | yes (owner/mod/member) | badges |
| Sub/member tier | yes | unwired: badge only | unwired: member flag only | unwired: badge only |
| Username color | `color` | identity.color | no | chatProfile.color |
| Bot can post (reply) | tmi say | needs Kick bot token | OAuth write scope | needs ATProto write |
| Support events on feed | `lib/alerts.js` normalizer | `lib/alerts.js` (gift subs, kicks) | `lib/alerts.js` (superchat/sticker/membership) | unwired: on same WS, unhandled |

**The identity story:** Twitch / Kick / stream.place give stable platform user IDs
that flow straight into `stream.links (platform, platform_id) → canonical`.
stream.place's ID is an **ATProto DID** — the same identity as Bluesky, the
strongest cross-platform anchor available. **YouTube** exposes no ID in the DOM;
a best-effort Data-API `authorChannelId` backfill supplies one (see its section below).

---

## Twitch — `platforms/twitch.js`

- **Transport:** tmi.js over `wss://irc-ws.chat.twitch.tv` (wraps vendored SSN `chatClient.js`).
- **Auth:** the bot account's OAuth (`chat:read`+`chat:edit`), auto-refreshed (`lib/twitchToken.js`).
- **Channel:** `#<channel>`.

### Per-message data (tmi.js tags — `m.raw.tags`)
| Field | Source | Notes |
|---|---|---|
| userId | `tags['user-id']` | stable |
| username | `tags['display-name']` | |
| login | `tags.username` | lowercase, used for replies |
| message | raw text | we pass `m.rawMessage` (unsanitized) |
| isMod | `tags.mod` / `badges.moderator` | |
| isVip | `tags.vip` / `badges.vip` | |
| isMember | `badges.subscriber` present | |
| tier | `badges.subscriber` value | `'1'`/`'2'`/`'3'` (legacy `'1000'`…) |
| sub months | `badge-info.subscriber` | unwired: not currently stored |
| color | `tags.color` | unwired: not stored |
| msg id | `tags.id` | unwired: needed for mod actions / precise reply targeting |
| first-time | `tags['first-msg']` | unwired: not stored |
| bits | `tags.bits` | cheer amount |
| emotes | `tags.emotes` `{id:[start-end]}` | → `{name: jtvnw cdn url}` (we build) |

### Replies: native
`tags['reply-parent-display-name']`, `['reply-parent-user-login']`,
`['reply-parent-user-id']`, `['reply-parent-msg-id']`, `['reply-parent-msg-body']`.
The connector sends `replyToUsername` + `replyToText` to `/chat`; `reply-parent-user-id`
and `reply-parent-msg-id` are also available for exact targeting.

### Send-back (cross-post / bot / commands)
- As the bot: `client.sendMessage(text)` → `say('#<channel>', …)`.
- As a linked viewer: the site's `platformChat.ts` already posts via Helix
  `/chat/messages` with the user's OAuth token.

---

## Kick — `platforms/kick.js`

- **Transport:** Kick's own realtime, a Centrifugo server (JSON protocol). Per connection:
  `POST web.kick.com/api/v1/realtime/channels/{channelId}/chat/connection` (the descriptor:
  provider + socket URL, region varies) → `POST web.kick.com/api/v1/realtime/auth/connection`
  (guest JWT, ~45 min) → socket: `connect` with the token, subscribe `chatrooms.{chatroomId}.v2`
  (+ `channel.{channelId}` at home, for monetization), answer `{}` pings, `refresh` before the
  ttl. Event `App\Events\ChatMessageEvent` in `push.pub.data`. Kick left Pusher; the old
  app key now refuses new connections with close 4001. The descriptor is where a future change
  of transport shows first.
- **Ids:** `kick.com/api/v2/channels/{slug}` → `chatroom.id` + `id` (the channel id; both are
  needed). Kasada-blocked → headless-Chromium fallback → `KICK_CHATROOM_ID` + `KICK_CHANNEL_ID`
  override.
- **Auth:** none to read.

### Per-message data (`ChatMessageEvent` payload)
| Field | Source | Notes |
|---|---|---|
| userId | `sender.id` | stable |
| username | `sender.username` / `.slug` | |
| message | `content` | contains `[emote:id:name]` markup |
| color | `sender.identity.color` | unwired: not stored |
| badges | `sender.identity.badges[]` (`type`) + `badge_info` | moderator / vip / subscriber / founder / og |
| isMod/isVip/isMember/tier | derived from badges | yes |
| msg id | `payload.id` | unwired: not stored |
| emotes | parse `[emote:id:name]` | → `{name: files.kick.com/emotes/id/fullsize}` |

### Replies: available, not wired
Kick delivers reply context in `payload.metadata` (`original_sender {id, username}`
+ `original_message {id, content}`). **TODO:** parse it into `replyToUsername`/
`replyToText`. *(Verify exact shape from a live reply frame.)*

### Other events on the same socket
`GiftedSubscriptionsEvent` (monetization) and `ChatMessageDeletedEvent` /
`UserBannedEvent` (moderation) are handled in `platforms/kick.js`.
`ChannelSubscriptionEvent` (single non-gift subs) is unhandled.

### Send-back
- As a linked viewer: the site's `platformChat.ts` → `api.kick.com/public/v1/chat`.
- As the bot: needs a **Kick bot OAuth token** (not yet set up).

---

## YouTube — `platforms/youtube.js`

- **Transport:** Playwright headless Chromium on `youtube.com/live_chat?is_popout=1&v={videoId}`.
- **Live detection:** scrape `youtube.com/channel/{id}/live` for `"isLiveNow":true` +
  canonical videoId (zero quota, no API key). Polls 30s.
- **Auth:** none to read.

### Per-message data (DOM, `yt-live-chat-text-message-renderer`)
| Field | Source | Notes |
|---|---|---|
| username | `#author-name` | display name only |
| message | `#message` childNodes | text + `<img>` emotes |
| emotes | `<img>` alt/src | → `{alt: src}` |
| isMod | `author-type` = moderator/owner | |
| isMember | `author-type` = member or badge img | |
| **userId** | Data-API backfill (below) | **resolved** when `YOUTUBE_API_KEY` set; empty for a chatter's first message until the next backfill poll |

### Stable YouTube user ID via Data-API backfill
The pop-out DOM exposes no channel/user ID, so the live feed alone falls back to
username (risk: duplicate canonical IDs on rename; can't link a YouTube account
reliably). The connector keeps the quota-free DOM scrape as the live feed,
and run a parallel **identity backfill** that reads the same chat via the Data
API to map `displayName -> authorChannelId`, attaching that channelId as `userId`.
- **Mechanism (`createIdentityResolver` in `youtube.js`):** once per stream,
  `videos.list?part=liveStreamingDetails` → `activeLiveChatId` (1 quota unit);
  then poll `liveChatMessages.list?part=authorDetails` every `YOUTUBE_ID_BACKFILL_MS`
  (default 120 000 ms, 5 units/poll), using `nextPageToken` for incremental reads.
  `authorDetails` gives `{channelId, displayName}`. API key only — works for
  public broadcasts (no OAuth). ~150 quota units/hour, far under the 10k/day quota.
- **Map:** `displayName -> channelId`, LRU-capped at 5000, cleared per stream.
- **Best-effort by design:** a brand-new chatter's *first* message may post before
  the backfill has seen them (`userId` empty, same as before); recurring chatters
  resolve within a poll or two. Last-writer-wins on duplicate display names.
- **Disable:** unset `YOUTUBE_API_KEY` → resolver is inert, behaviour reverts to
  username-only.
- **Alternative (still valid for high assurance):** resolve identity at OAuth
  link-time (the linked user proves their channelId once) — complementary, not
  superseded.

### Replies: none / Support events: yes
YouTube live chat has no native replies. SuperChat/SuperSticker/membership render
as separate elements (`yt-live-chat-paid-message-renderer`, etc.) — captured by
`platforms/youtube.js` and normalized in `lib/alerts.js`.

### Send-back
- As a linked viewer: the site's `platformChat.ts` → Data API `liveChatMessages.insert`.
- As the bot: needs OAuth write scope (`youtube.force-ssl`); not implemented.

---

## stream.place — `platforms/streamplace.js`

- **Transport:** stream.place's **own per-channel chat WebSocket**
  `wss://stream.place/api/websocket/{streamerDid}` (the streamer's DID,
  handle `example.com`). Found by inspecting the chat-popout's network.
- **Auth:** none to read. AT Protocol throughout.
- **Rejected alternative:** the public ATProto Jetstream — stream.place chat
  federates to the main relay too unreliably for live use.

### Frame types on the socket (`$type`)
`place.stream.livestream#viewerCount` · `app.bsky.actor.defs#profileViewBasic` ·
`place.stream.segment` · `place.stream.defs#renditions` ·
`place.stream.livestream#livestreamView` (stream metadata: title/post, activity
label, tags, start/end times — an unused **stream-status + viewer-count source**
that could replace polling) · **`place.stream.chat.defs#messageView`** (chat).

### Chat message data (`place.stream.chat.defs#messageView`) — verified sample
```jsonc
{
  "$type": "place.stream.chat.defs#messageView",
  "author": { "did": "did:plc:…", "handle": "example.com" },   // stable id + username
  "badges": [{ "badgeType": "place.stream.badge.defs#streamer",
               "issuer": "did:web:stream.place", "recipient": "did:plc:…" }],
  "chatProfile": { "color": { "red": 226, "green": 178, "blue": 213 } },
  "record": { "$type": "place.stream.chat.message",
              "text": "test", "streamer": "did:plc:…",
              "createdAt": "2026-06-16T01:16:45.178Z",
              "reply": { "root": {"uri","cid"}, "parent": {"uri","cid"} },  // unwired: when present
              "facets": [ … ] },                                            // unwired: mentions/links
  "uri": "at://did:plc:…/place.stream.chat.message/3moemt6hfes2m",          // msg id / rkey
  "cid": "bafyrei…"
}
```
| Field | Use |
|---|---|
| `author.did` | **best stable user id** (= Bluesky identity) |
| `author.handle` | username (e.g. `example.com`) |
| `record.text` | message |
| `badges[].badgeType` | streamer/moderator/… → role flags |
| `chatProfile.color` | username color (rgb) |
| `uri` | message id (dedup, reply targeting) |
| `record.reply` | unwired: native threading — resolve `parent.uri` → author+text via `getRecord` |
| `record.facets` | unwired: rich text (mentions/links); custom emotes TBD |

### Send-back
Create a `place.stream.chat.message` record in the **bot's** ATProto repo with
`streamer = channel DID` (+ optional `reply` refs). Needs an ATProto account for
the bot account + write auth (app password / OAuth). This is the bot's stream.place voice.

---

## How this feeds each downstream feature

**1. Reliable reply formatting.** Native reply data exists on Twitch (tags),
stream.place (ATProto refs) and Kick (`metadata`, not yet wired). YouTube has none —
fall back to `@mention` heuristic only. stream-api already accepts inline
`replyToUsername`/`replyToText`; next step is Kick `metadata` + stream.place
`record.reply` resolution.

**2. Data collection.** Each connector already normalizes into the `/chat` body
(`platform, userId, username, message, isMod, isVip, isMember, tier, emotes,
replyTo*`). Unused-but-available fields worth capturing: msg ids (all), color
(all but YouTube), Twitch sub-months/first-msg, Kick/SP badge detail.

**3. Embeddings.** Per-message text + stable user id per platform. stream.place's
DID makes per-user profile vectors robust; YouTube now resolves a channelId via
the Data-API backfill (best-effort — a chatter's first message before the next
poll still rolls up under username).

**4. Bot responses.** Reads everything above; posts back per platform via
the send-back rows. stream.place + Twitch are clean; Kick needs a bot
token; YouTube needs write scope.

**5. Connected accounts.** `site.accounts` links a Matrix
user to Twitch/YouTube/Kick OAuth identities; those map to the same platform IDs
this doc lists, joining to `stream.links → canonical`. Add stream.place: an
ATProto DID is the cleanest link of all (no OAuth dance — verify handle/DID).

**6. Cross-posting (`platformChat.ts`).** Already routes a reply to the
target platform using the user's linked token (Twitch/Kick/YouTube). stream.place
cross-post = write a `place.stream.chat.message` record.

---

## Known limits

- **Kick replies** are read from `metadata.original_sender` / `original_message`; that shape has
  not yet been confirmed against a live reply frame.
- **stream.place emotes and facets** are not read: whether custom emotes exist there, and how
  they would be encoded, is not confirmed.
- **stream.place support events** are not read. Twitch, Kick and YouTube support events are
  (`lib/alerts.js` → stream-api `/alert`, deduplicated by event id).
- **The bot posts into Twitch chat only.** A mention on Kick, YouTube or stream.place is answered
  in the site's chat (`lib/bot/index.js`), where it is addressed to the person by name.
