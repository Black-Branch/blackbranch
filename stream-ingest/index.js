// stream-ingest entry point.
// Loads config, starts session polling, then starts each enabled platform.

import 'dotenv/config';
import { startSessionPolling, stopSessionPolling } from './lib/session.js';
import { startTwitch } from './platforms/twitch.js';
import { startKick } from './platforms/kick.js';
import { startYouTube } from './platforms/youtube.js';
import { startStreamplace } from './platforms/streamplace.js';
import { startPoller } from './lib/poller.js';
import { streamApiBase } from './lib/streamApiUrl.js';
import { instanceConfig } from './lib/instanceConfig.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ai, startAiReporting } from './lib/ai.js';
import { startMemoryFeed } from './lib/embeddings.js';
import { createSupervisor } from './lib/supervisor.js';
import { startHelpdesk, helpdeskWanted } from './lib/helpdesk/index.js';
import { startBotFeed } from './lib/bot/index.js';
import { choosePlatforms } from './lib/platformsEnv.js';
import { createPlatformStarter, startPlatformsWhenLoaded } from './lib/platformStarter.js';
import { registerScorer } from './lib/scoring.js';
import { registerChannelEmotes } from './lib/emotes.js';

const STARTERS = {
  twitch: startTwitch,
  kick: startKick,
  youtube: startYouTube,
  streamplace: startStreamplace,
};

// PLATFORMS, when set, is the list ("none" = no platform); unset or empty = the platforms
// the settings set up (lib/platformsEnv.js) — chosen after the boot load, and again when the
// settings first arrive if that load failed (lib/platformStarter.js).

const running = [];

// This install's own plugin (owner/plugin.js), if the folder exists: its AI slots, its scorer
// (lib/scoring.js), its channel emotes (lib/emotes.js) and its `start` (this install's co-host, started below). A public
// install has no owner/ folder: the product's slots alone, nothing scored, nothing extra started.
// Existence is checked first so a broken plugin file fails LOUDLY instead of reading as "no plugin".
let ownerPlugin = null;
async function loadOwnerPlugin() {
  const url = new URL('./owner/plugin.js', import.meta.url);
  if (!existsSync(fileURLToPath(url))) return false;
  const plugin = await import(url.href);
  ownerPlugin = plugin.register({ ai }) || {};
  if (ownerPlugin.scorer) registerScorer(ownerPlugin.scorer);
  // The channel's own emotes (its sub-emote prefix, the emotes it added): stripped before the clean
  // word count. Without a plugin only global emotes are — nothing here names one channel's.
  if (ownerPlugin.channelEmotes) registerChannelEmotes(ownerPlugin.channelEmotes);
  return true;
}

async function main() {
  // Fail at BOOT, not on the first chat line: there is no default host (see
  // lib/streamApiUrl.js), and a process that starts without one delivers nothing
  // while looking healthy.
  try {
    streamApiBase();
  } catch (e) {
    console.error(`[main] FATAL: ${e.message}`);
    process.exit(1);
  }
  if (!process.env.STREAM_API_SECRET) {
    console.warn('[main] STREAM_API_SECRET is empty — stream-api will reject every call that is not from loopback');
  }
  // The instance settings layer. Required install-tier values this
  // process reads (site.origin) fail the BOOT, like STREAM_API_URL above; then the stored
  // layer is read from stream-api BEFORE any platform starts, so nothing reads a value the
  // operator saved before it has arrived. A stream-api that is down costs only the stored
  // values (env + defaults still answer) and the reader retries on every socket reconnect.
  const problems = instanceConfig.bootProblems();
  if (problems.length) {
    for (const p of problems) console.error(`[main] FATAL: ${p}`);
    process.exit(1);
  }
  // The process runs until it is told to stop (shutdown, below) — never until its event loop happens
  // to empty. Every timer here is unref'd, so on an install with no platform set up the internal
  // socket to stream-api was the ONLY live handle: stream-api restarting (an update restarts it
  // twice) closed it, node exited 0 during the 5 s reconnect wait, and Docker restart-looped the
  // service (found by the release-candidate rehearsal; processLifetime.test.js runs it).
  const lifetime = setInterval(() => {}, 60 * 60_000);
  running.push({ stop: () => clearInterval(lifetime) });
  console.log(`[main] owner plugin ${await loadOwnerPlugin() ? 'loaded' : 'not present'}`);
  running.push(startAiReporting());
  // The chat bot hears the feed from the first frame (the history replay seeds its recent chat),
  // so it is listening before the socket opens; whether it ANSWERS is the supervisor's below.
  const platforms = createPlatformStarter({
    starters: STARTERS,
    choose: () => choosePlatforms(process.env.PLATFORMS, Object.keys(STARTERS), (k) => instanceConfig.get(k)),
  });
  const botFeed = startBotFeed({ twitch: () => platforms.handle('twitch') });
  running.push(botFeed);
  ai.setReportPart('bot', () => botFeed.bot.report());
  // false = stream-api did not answer: the process runs on env + defaults until the settings
  // arrive, and the platform readers they name start then (startPlatformsWhenLoaded, below).
  const bootLoaded = await instanceConfig.start();
  running.push({ stop: () => instanceConfig.stop() });
  running.push(startMemoryFeed());
  // Product modules with a loop or a listener, started and stopped from their settings — no
  // restart (lib/supervisor.js).
  running.push(createSupervisor([
    { name: 'helpdesk', wanted: () => helpdeskWanted(), start: () => startHelpdesk() },
    { name: 'bot', wanted: () => botFeed.bot.wanted(), start: () => botFeed.bot.startReplies() },
  ], { onLoad: (fn) => instanceConfig.onLoad(fn) }));
  await startSessionPolling();
  console.log('[main] session polling started');

  running.push(platforms);
  await startPlatformsWhenLoaded({ platforms, config: instanceConfig, bootLoaded });
  console.log(`[main] platforms: ${platforms.names().join(', ') || '(none)'}`);

  // The owner plugin's start (e.g. a chat bot that subscribes to stream-api's WS and replies when
  // mentioned, gated by its own switch; it gets the home Twitch sender to reply on Twitch). No
  // plugin, or one without a start: nothing here. The sender forwards to whichever Twitch reader
  // is running at send time, so a reader started after a late settings load is reached too.
  if (ownerPlugin?.start) {
    const twitchClient = {
      sendMessage: (text) => {
        const h = platforms.handle('twitch');
        if (!h?.sendMessage) return Promise.reject(new Error('no twitch sender'));
        return h.sendMessage(text);
      },
    };
    try {
      running.push(ownerPlugin.start({ twitchClient }));
    } catch (err) {
      console.error('[main] owner plugin failed to start:', err.message);
    }
  }

  // Viewer poller + stream lifecycle (live state is an OR across Twitch,
  // YouTube and Kick — any one of them opens or sustains the session).
  // Gate off with POLLER_ENABLED=0.
  if (process.env.POLLER_ENABLED !== '0') {
    try {
      running.push(startPoller({
        // Closures (not method refs): a handle may be null if the platform is
        // disabled or failed to start — the poller then records NULL / scrapes.
        getStreamplaceViewers: () => platforms.handle('streamplace')?.getViewers?.() ?? null,
        getYtVideoId: () => platforms.handle('youtube')?.getVideoId?.() ?? '',
      }));
    } catch (err) {
      console.error('[main] poller failed to start:', err.message);
    }
  }

}

async function shutdown(signal) {
  console.log(`[main] ${signal} received; shutting down`);
  stopSessionPolling();
  await Promise.allSettled(running.map((h) => h?.stop?.()));
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[main] unhandledRejection:', err));

main().catch((err) => {
  console.error('[main] fatal:', err);
  process.exit(1);
});
