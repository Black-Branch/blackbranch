// Twitch connector — wraps SSN's vendored createTwitchChatClient over npm tmi.js.
// Persistent IRC WebSocket (wss://irc-ws.chat.twitch.tv); no browser.

import {
  createTwitchChatClient,
  createTmiClientFactory,
} from '../vendor/socialstream/providers/twitch/chatClient.js';
import { processMessage } from '../lib/pipeline.js';
import { twitchTokenProvider } from '../lib/twitchToken.js';
import { normalizeTwitchEvent } from '../lib/alerts.js';
import { postAlert, postPlatformDelete } from '../lib/api.js';
import { instanceConfig } from '../lib/instanceConfig.js';

const TWITCH_CDN = (id) =>
  `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/3.0`;

// tmi.js is CommonJS; normalize the default export for the SSN factory.
const loadTmi = async () => {
  const m = await import('tmi.js');
  return m.default || m;
};

// Build {name:url} from tmi.js emote tags + the raw message text.
//
// Twitch's `emotes` tag indexes by CODE POINT; JS string indexing counts
// UTF-16 code units. Every astral character earlier in the message —
// which is all standard emoji — is one code unit wider than it is code points,
// so a plain rawMessage.slice() drifts +1 per emoji and extracts the wrong text.
//
//   "👋 Kappa", Kappa reported at 2-6
//   .slice(2, 7)                      -> " Kapp"   ✗ key never matches
//   Array.from(...).slice(2, 7)       -> "Kappa"   ✓
//
// The emitted key is what the website matches against the tokens in `message`,
// so a skewed key means the emote silently renders as plain text. Splitting to a
// code-point array first makes the indexing match Twitch's. Done once per
// message, not per emote, and only when there are emotes to place.
export function buildEmoteMap(tags, rawMessage) {
  const out = {};
  const emotes = tags?.emotes;
  if (!emotes || !rawMessage) return out;
  const cps = Array.from(rawMessage);
  for (const [id, ranges] of Object.entries(emotes)) {
    const first = Array.isArray(ranges) ? ranges[0] : null;
    if (!first) continue;
    const [start, end] = String(first).split('-').map(Number);
    if (Number.isInteger(start) && Number.isInteger(end)) {
      const name = cps.slice(start, end + 1).join('');
      if (name) out[name] = TWITCH_CDN(id);
    }
  }
  return out;
}

// The user id a message resolves under. tmi's echo of a SELF message (the
// account this process is logged in as) carries no `user-id` tag. Sent as '',
// stream-api — which never adopts identity by name — would mint a NEW person
// for every one of the bot's own lines. tmi learns the account's own id at login
// (GLOBALUSERSTATE), so a self message takes it from there; before that state
// exists the id stays '' rather than guessing.
export function selfAwareUserId(m, tmi) {
  const tagged = m.userId || m.raw?.tags?.['user-id'] || '';
  if (tagged) return String(tagged);
  if (m.isSelf) return String(tmi?.globaluserstate?.['user-id'] || '');
  return '';
}

/**
 * @param {object} [opts]
 * @param {string} [opts.channel] channel to join (default: home channel from env)
 * @param {(msg:object)=>void} [opts.onMessage] relay sink. When set, the
 *   connection is anonymous + read-only (justinfan) and messages go to this
 *   callback instead of the home pipeline; commands are not handled.
 * @param {() => Promise<object>} [opts.loadTmi] where tmi.js comes from (tests hand in a fake).
 */
export async function startTwitch(opts = {}) {
  const channel = opts.channel || instanceConfig.get('platform.twitch.channel');
  if (!channel) throw new Error('platform.twitch.channel is not set (TWITCH_CHANNEL)');
  const onMessage = opts.onMessage || null;
  const tag = onMessage ? 'twitch:relay' : 'twitch';

  if (!onMessage && !process.env.TWITCH_OAUTH_TOKEN) {
    console.warn('[twitch] no TWITCH_OAUTH_TOKEN set — connecting anonymously (cannot reply to commands)');
  }

  const client = createTwitchChatClient({
    // Replace the vendored default, which points every Twitch chat avatar at
    // api.socialstream.ninja — a third-party host on the hot path, for EVERY
    // message. Overridden rather than edited in place because VENDOR.md
    // requires the vendored files stay a clean upstream mirror; `formatters` is
    // spread over the defaults, so this replaces just the one function.
    // stream-api fills the avatar from Helix by user id (twitch-app.js).
    formatters: { avatarUrl: () => '' },
    channel,
    // Relay connections are anonymous + read-only — never post as the bot into
    // another streamer's channel. Home ingest uses the auto-refreshing token.
    tokenProvider: onMessage ? async () => null : twitchTokenProvider,
    clientFactory: createTmiClientFactory(opts.loadTmi || loadTmi),
    logger: { debug: () => {} }, // quiet; pipeline logs what matters
  });

  const reply = (text) => client.sendMessage(text).catch((e) => console.warn('[twitch] reply failed:', e.message));
  // No `timeout` capability here, deliberately. Moderation timeouts belong on the
  // site's platformMod path, which resolves a canonical identity first. A raw
  // timeout escape hatch on the connector would let a chat command that
  // authorizes on a display name issue real Twitch timeouts.

  client.on(client.EVENTS.MESSAGE, (m) => {
    // Keep "self" (the bot's) messages — stream-ingest is logged in AS the bot, so
    // tmi marks the bot's own chat as self. We want it in the feed; the bot is in
    // BOT_USERNAMES so it's logged (is_bot) but never scored.
    const tags = m.raw?.tags || {};
    const normalized = {
      platform: 'twitch',
      userId: selfAwareUserId(m, client.getClient?.()),
      username: m.chatname,
      // The login (lowercase account name), not the display name: alejo.io's
      // pronoun lookup keys on it (stream-api pronouns.js).
      login: tags.username || tags.login || undefined,
      message: m.rawMessage || '',
      isMod: m.isModerator,
      isBroadcaster: Boolean(tags.badges?.broadcaster),
      isVip: tags.vip === true || tags.vip === '1' || Boolean(tags.badges?.vip),
      isMember: m.isSubscriber,
      tier: tags.badges?.subscriber || '',
      emotes: buildEmoteMap(tags, m.rawMessage || ''),
      replyToUsername: tags['reply-parent-display-name'] || tags['reply-parent-user-login'] || null,
      replyToText: tags['reply-parent-msg-body'] || null,
      platformMsgId: tags.id || undefined,
      usernameColor: tags.color || undefined,
      // chatClient derives this from the login via the SSN avatar proxy.
      avatarUrl: m.chatimg || undefined,
    };
    if (onMessage) onMessage(normalized);
    else processMessage(normalized, { reply });
  });

  // Monetization → alerts (home connection only; relays are read-only and must
  // never fire the streamer's alerts). normalizeTwitchEvent returns null for
  // events we skip (e.g. individual gifts inside a mystery-gift bomb).
  if (!onMessage) {
    client.on(client.EVENTS.MONETIZATION, (evt) => {
      console.log(`[twitch] MONETIZATION received: ${evt?.kind}`);
      try {
        const alert = normalizeTwitchEvent(evt);
        if (alert) {
          console.log(`[twitch] alert ${alert.eventType} event=${alert.eventId ?? '?'}`);
          postAlert(alert).catch((e) => console.warn('[twitch] postAlert failed:', e.message));
        }
      } catch (e) { console.warn('[twitch] monetization handler:', e.message); }
    });
  }

  // Twitch-side moderation → site mirror (home connection only; relays must
  // never act on another streamer's mod events). A mod deleting a message or
  // banning/timing-out a user IN TWITCH CHAT also removes it from the site.
  // Fire-and-forget: a mirror failure never disturbs ingestion.
  if (!onMessage) {
    client.on(client.EVENTS.MODERATION, (evt) => {
      const fwd = (payload) => postPlatformDelete(payload)
        .catch((e) => console.warn(`[twitch] moderation mirror (${evt.kind}) failed:`, e.message));
      if (evt.kind === 'delete' && evt.targetMsgId) {
        fwd({ platform: 'twitch', platformMsgId: evt.targetMsgId });
      } else if ((evt.kind === 'timeout' || evt.kind === 'ban') && (evt.targetUserId || evt.username)) {
        fwd({ platform: 'twitch', platformUserId: evt.targetUserId || undefined, username: evt.username || undefined });
      }
    });
  }

  client.on(client.EVENTS.STATUS, ({ status }) => console.log(`[${tag}] ${status} (${channel})`));
  client.on(client.EVENTS.ERROR, (e) => console.warn(`[${tag}] error:`, e?.message || e));

  // The home connection with a token: a refused FIRST login does not fail the start. The first
  // connect is seeded with the .env token, which may have expired; the chat client has already
  // scheduled its reconnect, which asks the token provider again — and that refreshes. Rejecting
  // here would leave that reconnecting client running with no handle, so the bot's Twitch sender
  // would be gone until a restart (which hits the same stale seed). The anonymous connection
  // (no token, or a relay) is unchanged: its failure has no refresh to wait for.
  const tokenUsed = !onMessage && Boolean(process.env.TWITCH_OAUTH_TOKEN);
  try {
    await client.connect();
  } catch (err) {
    if (!tokenUsed) throw err;
    const why = err?.message || String(err);
    console.warn(`[twitch] first login failed (${why}) — the .env access token is probably stale; reconnecting with a refreshed token`);
  }
  // Expose the sender for the home (non-relay) connection so the site plugin's bot
  // can reply on Twitch. Relay connections are anonymous/read-only — never expose a sender.
  return { stop: () => client.destroy(), sendMessage: onMessage ? null : reply, channel };
}
