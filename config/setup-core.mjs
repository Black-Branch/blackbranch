// The setup pages' instructions for the product's parts that are not modules, and the ONE shape check for every setup list — these and each module manifest's `setup` field in
// config/modules.mjs.
//
// Imports nothing, like modules.mjs: tools/gen-instance-schema.mjs copies SETUP_CORE into web's
// generated schema copy and runs setupProblems() in both its write and --check modes, so a setup
// list with a bad shape fails `check:instance-schema` in every package.
//
// A setup STEP is one card on a setup page:
//   id       a-z, 0-9, - (unique in its list)
//   title    one line
//   need     'required' | 'optional' (an optional step can be skipped and stays on the checklist)
//   explain  plain words: what to do and why
//   links    [{ label, url }] deep links to the provider's own page (https only)
//   paste    [{ label, value }] values to copy into the provider's page, computed from this
//            install: {origin} {apiOrigin} {domain} {matrixOrigin} {serverName}
//   fields   instance or secret keys the step fills (never an install-tier key: those are .env's)
//   test     a key whose schema `test` proves the step worked (a credential, or a setting with a
//            check of its own — the Streamplace account), or null
//   ownerOnly  optional, true: shown only on an install with an owner plugin — never on a public
//            install's pages, in its doctor or in the public docs (the OBS WebSocket path)

export const SETUP_PLACEHOLDERS = ['origin', 'apiOrigin', 'domain', 'matrixOrigin', 'serverName'];

// The product's non-module setup lists. A platform is read whenever
// its channel is set, so it is not a switch: the setup pages offer each list as a choice on the
// modules page ("where you stream"), and the Admin Panel shows each on its own tab. YouTube, Stripe
// and PayPal are module switches with their own `setup` in config/modules.mjs.
// release 'later': the page says the part arrives in a later release.
// turnOn (optional) { short, words }: a list that is neither a setup choice nor a module switch
// (Discord: the bundle's `discord` profile, switched on on the server) says how it is turned on —
// `short` in the public docs' index, `words` on its page. Its steps are then shown on its own
// Admin Panel page only, never on the setup pages.
export const SETUP_CORE = [
  {
    id: 'twitch', label: 'Twitch', release: 'now',
    description: 'Twitch chat in site chat, the Twitch player, and Twitch sign-in for your viewers.',
    steps: [
      {
        id: 'channel', title: 'Your Twitch channel', need: 'required',
        explain: 'The channel name as it appears in your Twitch address (twitch.tv/<name>), in lower case. Chat is read without signing in, so this alone brings Twitch chat into site chat.',
        links: [{ label: 'Twitch', url: 'https://www.twitch.tv/' }],
        paste: [], fields: ['platform.twitch.channel'], test: null,
      },
      {
        id: 'app', title: 'Your Twitch app', need: 'optional',
        explain: 'Needed for viewers to link their Twitch account, for moderation from the site and for live status. Turn on two-factor sign-in on the Twitch account first (Settings → Security). Then Twitch Developers → Your Console → Applications → Register: any unique name, the redirect URL below, category Website Integration. Copy the client id; New Secret gives the secret. Check fetches an app token and finds the channel. The channel\'s numeric id is found and saved for you. Signing the bot account in from this page comes in a later release.',
        links: [{ label: 'Twitch: register an application', url: 'https://dev.twitch.tv/console/apps/create' }],
        paste: [{ label: 'OAuth redirect URL', value: '{origin}/api/auth/link/twitch/callback' }],
        fields: ['twitch.clientId', 'twitch.clientSecret'], test: 'twitch.clientSecret',
      },
    ],
  },
  {
    id: 'kick', label: 'Kick', release: 'now',
    description: 'Kick chat in site chat, live detection, and Kick sign-in for your viewers.',
    steps: [
      {
        id: 'channel', title: 'Your Kick channel', need: 'required',
        explain: 'The channel name as it appears in your Kick address (kick.com/<name>). Without the app below, the site still tries to read Kick chat and your live status, but Kick often blocks a site that has no app, so live status can show as unknown. Viewers cannot link their Kick account and moderators cannot act on Kick from the site until the app is set.',
        links: [{ label: 'Kick', url: 'https://kick.com/' }],
        paste: [], fields: ['platform.kick.slug'], test: null,
      },
      {
        id: 'app', title: 'Your Kick app', need: 'optional',
        explain: 'Makes live status reliable, lets viewers link their Kick account and lets moderators act on Kick from the site. Turn on two-factor sign-in on the Kick account first. Then Kick → Settings → Developer → Create app: any name and the redirect URL below. Paste the client id and secret. Check fetches an app token and finds the channel. The channel\'s numeric id is found and saved for you.',
        links: [{ label: 'Kick: developer settings', url: 'https://kick.com/settings/developer' }],
        paste: [{ label: 'Redirect URL', value: '{origin}/api/auth/link/kick/callback' }],
        fields: ['kick.clientId', 'kick.clientSecret'], test: 'kick.clientSecret',
      },
      {
        id: 'ids', title: 'Kick\'s chatroom and channel ids (only if needed)', need: 'optional',
        explain: 'Leave these empty. Only if the Doctor says the Kick reader cannot find your chatroom (Kick\'s bot protection can block the lookup): open kick.com/api/v2/channels/<your name> in your own browser, and copy the number after "chatroom":{"id": as the chatroom id and the first "id" as the channel id.',
        links: [], paste: [], fields: ['kick.chatroomId', 'kick.channelId'], test: null,
      },
    ],
  },
  {
    id: 'streamplace', label: 'Streamplace', release: 'now',
    description: 'The stream.place player and its chat. Nothing to register: this site is its own app there.',
    steps: [
      {
        id: 'account', title: 'Your stream.place account', need: 'required',
        explain: 'Paste your handle, as in you.bsky.social, without the @. When you save, the site finds your account\'s DID (did:plc:…) from it. There is no app to register: stream.place reads this site\'s own sign-in description at the first address below, and sends people back to the second. Check finds the account and fetches that description.',
        links: [{ label: 'stream.place', url: 'https://stream.place/' }],
        paste: [
          { label: 'Client id (nothing to paste anywhere)', value: '{origin}/oauth/client-metadata.json' },
          { label: 'Redirect URL', value: '{origin}/api/auth/link/streamplace/callback' },
        ],
        fields: ['platform.streamplace.channel'], test: null,
      },
    ],
  },
  {
    id: 'donations', label: 'Ko-fi, Patreon and Streamlabs', release: 'now',
    description: 'Tips and memberships through outside services, shown as alerts and counted on the support bar. They make nobody a supporter here: the site\'s supporter perks come from a Stripe subscription or a gift sub.',
    steps: [
      {
        id: 'kofi', title: 'Ko-fi', need: 'optional',
        explain: 'Ko-fi → Settings → API → Webhook URL: paste the address below, then copy the verification token Ko-fi shows into this page.',
        links: [{ label: 'Ko-fi: webhooks', url: 'https://ko-fi.com/manage/webhooks' }],
        paste: [{ label: 'Webhook URL', value: '{apiOrigin}/webhook/kofi' }],
        fields: ['kofi.verificationToken'], test: null,
      },
      {
        id: 'patreon', title: 'Patreon', need: 'optional',
        explain: 'Patreon → the developer portal → My Webhooks: add the address below for member events, then copy the webhook secret into this page.',
        links: [{ label: 'Patreon: webhooks', url: 'https://www.patreon.com/portal/registration/register-webhooks' }],
        paste: [{ label: 'Webhook URL', value: '{apiOrigin}/webhook/patreon' }],
        fields: ['patreon.webhookSecret'], test: null,
      },
      {
        id: 'streamlabs', title: 'Streamlabs', need: 'optional',
        explain: 'Streamlabs → Settings → API Settings → API Tokens: copy the Socket API token into this page. It applies when the chat service restarts.',
        links: [{ label: 'Streamlabs: API settings', url: 'https://streamlabs.com/dashboard#/settings/api-settings' }],
        paste: [], fields: ['streamlabs.socketToken'], test: null,
      },
    ],
  },
  {
    id: 'voice', label: 'Read-aloud voice (ElevenLabs)', release: 'now',
    description: 'Alerts, paid messages and the bot spoken on stream with an ElevenLabs voice. The sound reaches your stream through the rig page in OBS.',
    steps: [
      {
        id: 'voice', title: 'Your ElevenLabs key and voice', need: 'optional',
        explain: 'ElevenLabs → Developers → API keys → Create key, with access to Text to Speech, Models and Voices. Paste it, then pick a voice in ElevenLabs\' Voices page and copy its voice id. Speaking stays off until you switch it on here.',
        links: [{ label: 'ElevenLabs: API keys', url: 'https://elevenlabs.io/app/settings/api-keys' }, { label: 'ElevenLabs: voices', url: 'https://elevenlabs.io/app/voice-library' }],
        paste: [], fields: ['elevenlabs.apiKey', 'tts.voiceCasual', 'tts.voiceLoud', 'tts.enabled'], test: 'elevenlabs.apiKey',
      },
    ],
  },
  {
    // The Discord side of Admin Panel → Site → Discord, step 1 (web DiscordBotStep shows these
    // steps). The token is pasted into that page and kept by the server, never a settings key, so
    // the steps fill no field. All three privileged intents, as OOYE's own setup asks ("enable all
    // switches", scripts/setup.js at v3.7): the bundle's registration sets receive_presences false,
    // so the gateway asks for Server Members and Message Content only (src/d2m/discord-client.js),
    // and those two are what the panel checks.
    id: 'discord', label: 'Discord', release: 'now',
    description: 'Links your Discord server\'s channels with your community rooms through the Discord bridge (Out Of Your Element), so a message in one shows in the other, and imports the server\'s categories, channels and roles into your community once.',
    turnOn: {
      short: 'on the server: `sudo blackbranch discord on`',
      words: 'The Discord bridge is part of the install and off on a new one. Do the steps below, the first step of Admin Panel → Site → Discord, then switch the bridge on on the server with `sudo blackbranch discord on` (it refuses until the bot token is saved). The same page then adds the bot to your Discord server, imports the server into your community and links its channels with your rooms.',
    },
    steps: [
      {
        id: 'app', title: 'A Discord application for this server only', need: 'required',
        explain: 'In Discord\'s Developer Portal press New Application and make one for this install alone. The bridge takes over the application\'s commands, so it cannot share an application with another bot or another install. Put the words below somewhere in its description: the bridge\'s author asks for it.',
        links: [{ label: 'Discord: Developer Portal', url: 'https://discord.com/developers/applications' }],
        paste: [{ label: 'Description (somewhere in it)', value: 'Powered by OOYE' }],
        fields: [], test: null,
      },
      {
        id: 'token', title: 'Its intents and its bot token', need: 'required',
        explain: 'On the application\'s Bot page, switch on Presence Intent, Server Members Intent and Message Content Intent (under Privileged Gateway Intents) and save, then press Reset Token and paste the token into the bot step\'s token field. The bridge needs Server Members and Message Content to see who is in your server and what they write; the bot step warns while either is off. The server writes the token into the bridge\'s own settings file and restarts the bridge; the site keeps no copy and never shows it again. Above 10,000 people in a server, Discord asks for a yearly review before a bot may keep these intents.',
        links: [{ label: 'Discord: gateway intents', url: 'https://discord.com/developers/docs/events/gateway' }],
        paste: [], fields: [], test: null,
      },
    ],
  },
];

const STEP_PROPS = ['id', 'title', 'need', 'explain', 'links', 'paste', 'fields', 'test', 'ownerOnly'];
const LIST_PROPS = ['id', 'label', 'description', 'release', 'steps', 'turnOn'];

/**
 * Every problem with the setup lists, as readable lines ([] = fine).
 * @param {{ modules: any[], core: any[], keys: any[] }} input  the manifests, SETUP_CORE, INSTANCE_KEYS
 * @returns {string[]}
 */
export function setupProblems({ modules, core, keys }) {
  const out = [];
  const byKey = new Map(keys.map((e) => [e.key, e]));
  const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
  const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\r\n]/.test(v);
  const holes = (v) => [...String(v).matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);

  function steps(where, list) {
    if (!Array.isArray(list)) { out.push(`${where}: setup must be a list of steps`); return; }
    const ids = new Set();
    list.forEach((s, i) => {
      const at = `${where} step ${isObj(s) && typeof s.id === 'string' ? s.id : i}`;
      if (!isObj(s)) { out.push(`${at}: a step is an object`); return; }
      for (const k of Object.keys(s)) if (!STEP_PROPS.includes(k)) out.push(`${at}: unknown field "${k}"`);
      if (typeof s.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(s.id)) out.push(`${at}: id must be a-z 0-9 - (1–32)`);
      else if (ids.has(s.id)) out.push(`${at}: duplicate id`);
      else ids.add(s.id);
      if (!text(s.title, 80)) out.push(`${at}: title (one line, 1–80 characters)`);
      if (s.need !== 'required' && s.need !== 'optional') out.push(`${at}: need must be "required" or "optional"`);
      if (s.ownerOnly !== undefined && s.ownerOnly !== true) out.push(`${at}: ownerOnly is true or left out`);
      if (s.ownerOnly === true && s.need === 'required') out.push(`${at}: an ownerOnly step cannot be required (a public install never sees it)`);
      if (typeof s.explain !== 'string' || !s.explain.trim() || s.explain.length > 800) out.push(`${at}: explain (1–800 characters)`);
      if (!Array.isArray(s.links)) out.push(`${at}: links must be a list`);
      else for (const l of s.links) {
        if (!isObj(l) || !text(l.label, 60) || typeof l.url !== 'string' || !/^https:\/\/[^\s{}]+$/.test(l.url)) {
          out.push(`${at}: a link is { label, url } with an https URL`);
        }
      }
      if (!Array.isArray(s.paste)) out.push(`${at}: paste must be a list`);
      else for (const p of s.paste) {
        if (!isObj(p) || !text(p.label, 60) || !text(p.value, 600)) { out.push(`${at}: a paste value is { label, value }`); continue; }
        for (const h of holes(p.value)) if (!SETUP_PLACEHOLDERS.includes(h)) out.push(`${at}: unknown placeholder {${h}} (known: ${SETUP_PLACEHOLDERS.join(', ')})`);
      }
      if (!Array.isArray(s.fields)) out.push(`${at}: fields must be a list`);
      else for (const f of s.fields) {
        const e = byKey.get(f);
        if (!e) out.push(`${at}: field ${f} is not a settings key`);
        else if (e.tier === 'install') out.push(`${at}: field ${f} is install-tier (set in .env, not on a page)`);
      }
      if (s.test !== null && s.test !== undefined) {
        const e = byKey.get(s.test);
        if (!e || !e.test) out.push(`${at}: test ${s.test} is not a key with a check`);
        else if (Array.isArray(s.fields) && !s.fields.includes(s.test)) out.push(`${at}: test ${s.test} is not one of this step's fields`);
      }
      if (Array.isArray(s.fields) && Array.isArray(s.links) && Array.isArray(s.paste) && !s.fields.length && !s.links.length && !s.paste.length) {
        out.push(`${at}: a step needs something to do — a field, a link or a value to paste`);
      }
    });
  }

  for (const m of modules) {
    if (m.setup === undefined) continue;
    if (m.kind !== 'module') { out.push(`module ${m.id}: only a product module has setup pages (kind "${m.kind}")`); continue; }
    if (Array.isArray(m.setup) && !m.setup.length) out.push(`module ${m.id}: an empty setup list — leave the field out instead`);
    steps(`module ${m.id}`, m.setup);
  }
  if (!Array.isArray(core)) return [...out, 'SETUP_CORE must be a list'];
  const ids = new Set();
  for (const c of core) {
    const at = `core ${isObj(c) ? c.id : '?'}`;
    if (!isObj(c)) { out.push('SETUP_CORE: each entry is an object'); continue; }
    for (const k of Object.keys(c)) if (!LIST_PROPS.includes(k)) out.push(`${at}: unknown field "${k}"`);
    if (typeof c.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(c.id) || ids.has(c.id)) out.push(`${at}: id a-z 0-9 -, unique`);
    ids.add(c.id);
    if (!text(c.label, 60)) out.push(`${at}: label (one line)`);
    if (typeof c.description !== 'string' || !c.description.trim()) out.push(`${at}: description`);
    if (c.release !== 'now' && c.release !== 'later') out.push(`${at}: release must be "now" or "later"`);
    if (c.turnOn !== undefined) {
      const t = c.turnOn;
      if (!isObj(t) || Object.keys(t).some((k) => k !== 'short' && k !== 'words') || !text(t.short, 80) || !text(t.words, 600)) {
        out.push(`${at}: turnOn is { short, words }: one line for the docs' index (1–80 characters) and one for the page (1–600)`);
      }
    }
    steps(at, c.steps);
    if (c.release === 'now' && Array.isArray(c.steps) && !c.steps.length) out.push(`${at}: released now with no steps`);
  }
  return out;
}
