// The instance settings schema — ONE declaration for every package.
//
// Every value that is this install's (its name, origins, channels, staff, provider credentials)
// is declared here once: its kind, default, tier, the env names that override it and the
// processes that read it.
//
// Do not import this file from a package. stream-api deploys `*.js` from its own folder and
// stream-ingest is rsynced whole, so a file outside them does not exist in production. Each
// package gets a GENERATED copy instead — `node tools/gen-instance-schema.mjs` writes them and
// `--check` (in every package's check:all) fails when one drifts:
//   stream-api/instanceSchema.generated.js       (CommonJS)
//   stream-ingest/lib/instanceSchema.generated.js (ESM)
//   web/app/lib/instanceSchema.generated.mjs      (ESM)
// The two functions below are emitted as their own source text, so the three copies run the
// SAME resolver rather than three that are supposed to agree.
//
// Rules for an entry:
//   • `kind`, never `type` — web's wsFrameContract.test.ts reads every `type: '<x>'` in a
//     stream-api *.js as a WebSocket frame name, and the stream-api copy is a *.js file.
//   • Defaults are NEUTRAL (null / []). This install's own values live in env or in
//     site.instance_config rows; a default here would be a hardcoded owner value in three
//     generated files, which tools/check-owner-literals.mjs forbids.
//   • `env` lists the canonical name first, then aliases (old names, still read). The first
//     NON-EMPTY one wins.
//   • tier: 'install' = env only, never edited from the dashboard (the site trusts these);
//     'instance' = site.instance_config, env overrides; 'secret' = site.instance_secrets
//     (encrypted by stream-api), env overrides.
//   • packages: the processes that READ the key. Boot checks, the per-package source shown on
//     the Credentials page and the /config/secrets filter all come from this list.
//   • reload: 'live' = read at call time; 'restart' = captured once at boot so an edit applies
//     at the next restart. Every install-tier key is 'restart': web reads its install values from
//     its environment when it starts and hands the browser the public ones in the page
//     (web/app/lib/installValues.ts) — nothing is compiled into the build, so one web image
//     serves every install.
//   • Structured AI keys have no env name: JSON in an env file is not a
//     setting anyone should edit by hand. Their defaults are neutral (null / [] / off).

import { MODULES } from './modules.mjs';

/** @typedef {'string'|'list'|'origin'|'wsOrigin'|'url'|'serverName'|'matrixId'|'localpartTemplate'|'enum'|'secret'|'bool'|'number'|'aiRoute'|'aiTasks'|'aiConnections'|'memoryState'|'setupState'|'backupRepository'} InstanceKind */
/** @typedef {'web'|'stream-api'|'stream-ingest'} InstancePackage */
/**
 * @typedef {object} InstanceEntry
 * @property {string} key
 * @property {InstanceKind} kind
 * @property {null|string|string[]|boolean|number} default
 * @property {'public'|'server'} scope
 * @property {string} module
 * @property {boolean} secret
 * @property {'live'|'restart'} reload
 * @property {'install'|'instance'|'secret'} tier
 * @property {string[]} env
 * @property {InstancePackage[]} packages
 * @property {boolean} [required]
 * @property {string[]} [values]
 * @property {'serverName'} [items] list kind: every item must be one (lower-cased; anything else is refused)
 * @property {string} [test]
 * @property {'ai'|'setup'|'rig'} [surface] edited on the AI page, by the setup pages, or by the OBS page's rig panel — not the Credentials page
 * @property {'stream-api'} [writer] written by that process only, never by a PUT
 * @property {boolean} [nullable]   number kind: null is a value (e.g. "forever")
 * @property {boolean} [integer]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [maxLength]   string kind
 * @property {boolean} [productDefault] a non-empty default that is the PRODUCT's own (never an install's)
 * @property {boolean} [legacyOn]   a module switch whose part was always on before it had one (config/modules.mjs)
 * @property {string} label
 * @property {string} description
 */

/** @type {InstanceEntry[]} */
export const INSTANCE_KEYS = [
  // ── Site (install tier) ──────────────────────────────────────────────────────────────────
  { key: 'site.name', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['SITE_NAME', 'NEXT_PUBLIC_SITE_NAME'], packages: ['web', 'stream-ingest'],
    required: true, label: 'Site name',
    description: 'What a viewer reads as the name of this site: page titles, the sign-in page, the install prompt.' },
  { key: 'site.description', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['SITE_DESCRIPTION'], packages: ['web'],
    label: 'Site description',
    description: 'One sentence for search results and link previews (the meta description and share cards). Unset = a neutral line built from the site name.' },
  { key: 'site.homeHeading', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['SITE_HOME_HEADING'], packages: ['web'],
    label: 'Home heading',
    description: 'The heading a signed-out visitor sees at the top of Home. Unset = the site name.' },
  { key: 'site.homeIntro', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['SITE_HOME_INTRO'], packages: ['web'],
    label: 'Home intro',
    description: 'The one line under the Home heading for a signed-out visitor. Unset = a neutral line.' },
  { key: 'site.shortName', kind: 'string', maxLength: 24, default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['SITE_SHORT_NAME'], packages: ['web'],
    label: 'Short name',
    description: 'The name under the app icon when the site is installed on a phone. Unset = the site name.' },
  { key: 'site.tagline', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['SITE_TAGLINE'], packages: ['web'],
    label: 'Share card line',
    description: 'The line under the site name on the picture shown when a link to the site is shared. Unset = a neutral line.' },
  { key: 'site.iconSet', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['SITE_ICON_SET'], packages: ['web'],
    label: 'Icon folder',
    description: 'The folder under the site\'s public files that holds its icons (icon.png, icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png), e.g. "/" or "/brand/mine". Unset = the built-in neutral icons.' },
  // The word this install used for the site's own platform id and browser storage names before
  // the product's. Read by web only, to carry old values forward; a fresh install leaves it unset.
  { key: 'site.legacyId', kind: 'string', maxLength: 32, default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['SITE_LEGACY_ID'], packages: ['web'],
    label: 'Legacy site id',
    description: 'A lower-case word (e.g. oldsite) this site used for its own platform id and its browser storage names before the product names. Old values under it are carried forward: a returning visitor\'s saved settings, and a page opened before the rename. Unset = none (a fresh install).' },
  { key: 'site.origin', kind: 'origin', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['SITE_ORIGIN', 'AUTH_URL'], packages: ['web', 'stream-ingest'],
    required: true, label: 'Site address',
    description: 'The public origin of the website (https://…). Sign-in return URLs, CORS, sitemaps and payment return links are built from it.' },
  { key: 'site.apiOrigin', kind: 'origin', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['SITE_API_ORIGIN'], packages: ['web'],
    required: true, label: 'API address',
    description: 'The public origin of stream-api (https://…): radio audio and art, the content-security policy.' },
  { key: 'site.apiWsOrigin', kind: 'wsOrigin', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['SITE_API_WS_ORIGIN'], packages: ['web'],
    required: true, label: 'Live socket address',
    description: 'The public WebSocket origin of stream-api (wss://…) that browsers open for live chat and overlays.' },

  // ── Legal (install tier) ─────────────────────────────────────────────────────────────────
  // The operator's own details for the Terms / Privacy / Refund page and /about. No defaults on
  // purpose: a page that invents an operator or a law is worse than one that says it has none,
  // so unset shows a "not set" marker and web logs it at boot.
  { key: 'legal.operator', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['LEGAL_OPERATOR'], packages: ['web'],
    label: 'Operator',
    description: 'Who runs the site, as named in the Terms and Privacy Policy (a person\'s trading name or a company).' },
  { key: 'legal.contactEmail', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['LEGAL_CONTACT_EMAIL'], packages: ['web'],
    label: 'Contact e-mail',
    description: 'Where legal, privacy, refund and data-deletion requests go. Shown on the legal and About pages.' },
  { key: 'legal.governingLaw', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['LEGAL_GOVERNING_LAW'], packages: ['web'],
    label: 'Governing law',
    description: 'Whose laws govern the Terms, as it reads after "the laws of", e.g. "the State of X, United States".' },
  { key: 'legal.effectiveDate', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['LEGAL_EFFECTIVE_DATE'], packages: ['web'],
    label: 'Last updated',
    description: 'The date the legal page says it was last updated, as written, e.g. "January 1, 2026".' },

  // ── Running the site (instance tier — written by the setup pages, edited on the Admin Panel) ──
  { key: 'site.timeZone', kind: 'string', maxLength: 64, default: null, scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['SITE_TIME_ZONE'], packages: ['web'],
    label: 'Time zone',
    description: 'The time zone the site runs on, as a name like Europe/Berlin — the quiet hour and daily jobs use it. Unset = UTC.' },
  { key: 'site.dataSince', kind: 'string', maxLength: 10, default: null, scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['SITE_DATA_SINCE'], packages: ['web'],
    label: 'Data since',
    description: 'The first day this site\'s history counts from (YYYY-MM-DD), e.g. the day it opened. Unset = no lower bound.' },
  { key: 'updates.quietHour', kind: 'number', integer: true, min: 0, max: 23, default: null, scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['UPDATES_QUIET_HOUR'], packages: ['web'],
    label: 'Quiet hour',
    description: 'The hour of the day (0–23, in the site\'s time zone) when backups and security updates run, outside streams. Unset = 4.' },
  { key: 'bugReports.enabled', kind: 'bool', default: false, scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['BUG_REPORTS_ENABLED'], packages: ['web'],
    label: 'Send bug reports',
    description: 'Off by default. On = a failing check sends the project a report with every secret, chat text and viewer id removed.' },
  // Backups: read by the HOST at every backup — `blackbranch` resolves them inside the
  // stream-api image with this schema's resolver (install/backup/target.cjs), so a change applies at
  // the next backup. The keys of a bucket are secret tier, below.
  { key: 'backup.target', kind: 'enum', values: ['local', 's3', 'sftp'], default: 'local', scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['BACKUP_TARGET'], packages: ['web'],
    label: 'Backup target',
    description: 'Where the nightly backup goes: local (a folder on this server, /opt/blackbranch/backups), s3 (an S3-compatible bucket: Backblaze B2, Cloudflare R2, …) or sftp (another server over SSH).' },
  { key: 'backup.repository', kind: 'backupRepository', default: null, scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['BACKUP_REPOSITORY'], packages: ['web'],
    label: 'Backup address',
    description: 'For a bucket: s3:https://<endpoint>/<bucket>[/<folder>]. For SFTP: sftp:<user>@<host>:/<folder> (from the server\'s root) or sftp://<user>@<host>:<port>/<folder> (a folder inside that account\'s home). Add the key `blackbranch backup key` prints to that account first. Empty for local. Nothing else is accepted: the server hands this address to its backup tool as root.' },
  { key: 'backup.s3.region', kind: 'string', maxLength: 64, default: null, scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['BACKUP_S3_REGION'], packages: ['web'],
    label: 'Bucket region',
    description: 'The bucket\'s region when the provider asks for one (Cloudflare R2: auto). Unset = the provider\'s default.' },
  { key: 'backup.keepDaily', kind: 'number', integer: true, min: 1, max: 90, default: null, scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['BACKUP_KEEP_DAILY'], packages: ['web'],
    label: 'Daily backups kept',
    description: 'How many days of nightly backups are kept. Unset = 7.' },
  { key: 'backup.keepWeekly', kind: 'number', integer: true, min: 0, max: 104, default: null, scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['BACKUP_KEEP_WEEKLY'], packages: ['web'],
    label: 'Weekly backups kept',
    description: 'How many weeks keep one backup each, beyond the daily ones. Unset = 4.' },

  // ── Matrix homeserver (install tier) ─────────────────────────────────────────────────────
  // ONE source for "which homeserver is ours". The base URL is the origin the site TRUSTS (its
  // server-side fetches skip the SSRF guard), so these are install tier: never dashboard-edited.
  // The MAS_* names are aliases — the contract is the Matrix OAuth 2.0 API, not one program.
  { key: 'matrix.serverName', kind: 'serverName', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['MATRIX_SERVER_NAME'], packages: ['web', 'stream-api'],
    required: true, label: 'Matrix server name',
    description: 'The :server part of every account id (@name:server). Permanent — a homeserver can never be renamed.' },
  { key: 'matrix.baseUrl', kind: 'origin', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['MATRIX_HOMESERVER_URL'], packages: ['web'],
    required: true, label: 'Matrix homeserver address',
    description: 'The homeserver\'s client-server API origin (https://…). The site trusts this origin; the well-known delegates to it.' },
  { key: 'matrix.federationServer', kind: 'serverName', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['MATRIX_FEDERATION_SERVER'], packages: ['web'],
    label: 'Matrix federation address',
    description: 'host:port other servers federate with (.well-known/matrix/server). Unset = the homeserver address\'s host on port 443.' },
  // The site's own Matrix data types carry the product namespace (web/app/lib/matrixNamespace.ts).
  // An install whose homeserver already holds data under an older prefix names it here: readers
  // then accept both, and writers keep writing the old one until the write-new release. A fresh
  // install has none, so readers and writers use only the product namespace.
  { key: 'matrix.legacyNamespace', kind: 'string', maxLength: 64, default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['MATRIX_LEGACY_NAMESPACE'], packages: ['web'],
    label: 'Legacy Matrix data prefix',
    description: 'A reverse-DNS prefix (e.g. org.example) that this homeserver\'s room flags, post fields, profile fields and account data were written under before the product namespace. Unset = none (a fresh install).' },
  // Fresh-install homeserver. The federation switch is read by the
  // HOST: `blackbranch render` turns it into Synapse's listeners and the router, then restarts
  // Synapse — so it applies at that restart, never live. The room ids are what the bootstrap made
  // (`blackbranch matrix bootstrap`), recorded so a later run finds them rather than making more.
  { key: 'matrix.federation', kind: 'bool', default: false, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'instance', env: ['MATRIX_FEDERATION'], packages: ['web'],
    label: 'Federation',
    description: 'Whether other Matrix servers can reach this community (off on a new install). On a bundled install the host applies it by re-rendering the homeserver config and restarting Synapse; the server name never changes.' },
  // Sign-up on the bundled homeserver, read by the HOST like the federation switch (render.sh's
  // mx_registration_state): closed until setup is finished whatever this says, then this; unset =
  // closed (render.sh and the description agree; this comment said "open" until 2026-10-18). An install whose homeserver
  // the bundle does not render (its own MAS elsewhere) shows the switch and it changes nothing.
  { key: 'matrix.registration', kind: 'enum', values: ['open', 'closed'], default: null, scope: 'server', module: 'core', secret: false,
    reload: 'restart', tier: 'instance', env: ['MATRIX_REGISTRATION'], packages: ['web'],
    label: 'Sign-up on the bundled homeserver',
    description: 'Whether anyone may make an account on the bundled homeserver\'s own sign-in pages: open or closed. Unset = closed; always closed while setup runs. Applies only to the homeserver this install\'s bundle runs — the host re-renders its sign-in config and restarts it; a homeserver run elsewhere keeps its own setting.' },
  // Sign-in with an account on ANOTHER Matrix server (federated sign-in), read by web on every
  // request (web/app/lib/federatedSignInSwitch.ts): off on a new install, so only the install's own
  // server's accounts sign in until whoever runs it opens it. Matched on the server name in the
  // account id, exactly (no subdomain matching). The install's own server is never refused; the
  // deny list applies in every mode, and a tightened policy also ends existing sessions from a
  // server it now refuses.
  { key: 'auth.federatedSignin', kind: 'enum', values: ['off', 'on', 'allowlist'], default: 'off', scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['AUTH_FEDERATED_SIGNIN'], packages: ['web'],
    label: 'Sign-in from other Matrix servers',
    description: 'Whether people with an account on another Matrix server may sign in here: off (only this site\'s own server), on (any server not on the deny list), or allowlist (only the servers on the allow list). Off on a new install. Applies at once, to new sign-ins and to people already signed in.' },
  { key: 'auth.federatedAllow', kind: 'list', items: 'serverName', default: [], scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['AUTH_FEDERATED_ALLOW'], packages: ['web'],
    label: 'Servers allowed to sign in',
    description: 'Matrix server names (the part of an account id after the colon, e.g. example.org) that may sign in when the mode is allowlist. Exact names only: example.org does not cover chat.example.org. Comma-separated in env.' },
  { key: 'auth.federatedDeny', kind: 'list', items: 'serverName', default: [], scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['AUTH_FEDERATED_DENY'], packages: ['web'],
    label: 'Servers refused sign-in',
    description: 'Matrix server names that may never sign in here, whatever the mode. Exact names only. People already signed in from one are signed out at their next request. Comma-separated in env.' },
  { key: 'matrix.rooms.hub', kind: 'string', maxLength: 255, default: null, scope: 'public', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['MATRIX_HUB_ROOM_ID'], packages: ['web'],
    label: 'Community space room',
    description: 'The room id (!…) of the community space, written by the homeserver bootstrap. Change it only when the space is replaced.' },
  { key: 'matrix.rooms.general', kind: 'string', maxLength: 255, default: null, scope: 'public', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['MATRIX_GENERAL_ROOM_ID'], packages: ['web'],
    label: '#general room',
    description: 'The room id (!…) of #general, written by the homeserver bootstrap. Change it only when the room is replaced.' },
  { key: 'matrix.oauth.issuer', kind: 'url', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['MATRIX_OAUTH_ISSUER', 'MAS_ISSUER'], packages: ['web'],
    required: true, label: 'Matrix sign-in issuer',
    description: 'The OAuth 2.0 issuer the homeserver delegates sign-in to (its auth_metadata must name exactly this).' },
  { key: 'matrix.oauth.clientId', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['MATRIX_OAUTH_CLIENT_ID', 'MAS_CLIENT_ID'], packages: ['web'],
    required: true, label: 'Matrix sign-in client id',
    description: 'This site\'s registered (confidential) client at the issuer. Public — it appears in every sign-in link.' },

  // ── Discord bridge (module discord-bridge, install tier) ─────────────────────────────────
  // The bridge's OWN two templates, copied from its config. Unset = the module is off: no sender
  // is a bridge ghost and nothing is stripped from a name.
  { key: 'discordBridge.usernameTemplate', kind: 'localpartTemplate', default: null, scope: 'public', module: 'discord-bridge', secret: false,
    reload: 'restart', tier: 'install', env: ['DISCORD_BRIDGE_USERNAME_TEMPLATE'], packages: ['web'],
    label: 'Discord bridge username template',
    description: 'The bridge\'s username_template, e.g. discord_{{.}} — how a Discord user\'s Matrix id is built.' },
  { key: 'discordBridge.displaynameTemplate', kind: 'string', default: null, scope: 'public', module: 'discord-bridge', secret: false,
    reload: 'restart', tier: 'install', env: ['DISCORD_BRIDGE_DISPLAYNAME_TEMPLATE'], packages: ['web'],
    label: 'Discord bridge display-name template',
    description: 'The bridge\'s displayname_template. Its fixed tail (e.g. " (Discord)") is stripped for display; its {{if .Bot}}…{{end}} text marks bot accounts.' },

  // ── Streamer, bot, staff ─────────────────────────────────────────────────────────────────
  { key: 'streamer.displayName', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['STREAMER_DISPLAY_NAME'], packages: ['web'],
    label: 'Streamer display name',
    description: 'The streamer\'s name as shown above the player and in the stream title fallback.' },
  { key: 'streamer.matrixId', kind: 'matrixId', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['STREAMER_MATRIX_ID', 'BROADCASTER_MATRIX_ID'], packages: ['web'],
    label: 'Streamer account',
    description: 'The streamer\'s Matrix id (@name:server). Staff, the public avatar and broadcaster-token moderation use it.' },
  { key: 'bot.matrixId', kind: 'matrixId', default: null, scope: 'public', module: 'bot', secret: false,
    reload: 'live', tier: 'instance', env: ['BOT_MATRIX_ID'], packages: ['web', 'stream-api', 'stream-ingest'],
    label: 'Bot account',
    description: 'The chat bot\'s Matrix id. Its native messages, its avatar and its staff badge are keyed on it.' },
  { key: 'staff.extraMatrixIds', kind: 'list', default: [], scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['STAFF_EXTRA_MATRIX_IDS'], packages: ['web'],
    label: 'Extra staff accounts',
    description: 'Matrix ids treated as staff besides the streamer and the bot (comma-separated in env).' },
  { key: 'chat.botUsernames', kind: 'list', default: [], scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['BOT_USERNAMES'], packages: ['stream-ingest'],
    label: 'Bot usernames',
    description: 'Platform usernames whose chat is logged as a bot and never scored (comma-separated in env, lower-cased).' },

  // ── Channels ─────────────────────────────────────────────────────────────────────────────
  { key: 'platform.twitch.channel', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'instance', env: ['TWITCH_CHANNEL'], packages: ['web', 'stream-ingest'],
    label: 'Twitch channel',
    description: 'The Twitch channel login (lower case) — the embed, emotes and the chat connection.' },
  { key: 'platform.twitch.broadcasterId', kind: 'string', default: null, scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['TWITCH_BROADCASTER_ID', 'TWITCH_USER_ID'], packages: ['web', 'stream-ingest'],
    label: 'Twitch broadcaster id',
    description: 'The channel\'s numeric Twitch id. Moderation refuses to act without it; the viewer poller reads it.' },
  { key: 'platform.youtube.channelId', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'instance', env: ['YOUTUBE_CHANNEL_ID'], packages: ['web', 'stream-ingest'],
    label: 'YouTube channel id',
    description: 'The channel id (UC…) — the embed, live detection, chat and moderation.' },
  { key: 'platform.youtube.vodPlaylist', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'install', env: ['YOUTUBE_VOD_PLAYLIST'], packages: ['web'],
    label: 'VOD playlist',
    description: 'The YouTube playlist (PL…) whose public videos are listed as past broadcasts: Home\'s VODs card and the VODs tabs. Unset or "none" = no VODs anywhere.' },
  { key: 'platform.kick.slug', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'instance', env: ['KICK_CHANNEL_SLUG', 'KICK_CHANNEL'], packages: ['web', 'stream-ingest'],
    label: 'Kick channel',
    description: 'The Kick channel slug — the chat connection and live detection.' },
  { key: 'platform.kick.userId', kind: 'string', default: null, scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['KICK_USER_ID'], packages: ['web'],
    label: 'Kick user id',
    description: 'The channel\'s numeric Kick id. Kick moderation refuses without it.' },
  { key: 'platform.streamplace.did', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'restart', tier: 'instance', env: ['STREAMPLACE_STREAMER_DID'], packages: ['web', 'stream-ingest'], test: 'streamplace',
    label: 'stream.place account',
    description: 'The streamer\'s stream.place DID (did:plc:…) — the player and its chat.' },
  { key: 'platform.streamplace.channel', kind: 'string', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['SP_CHANNEL'], packages: ['web'],
    label: 'stream.place handle',
    description: 'The handle the stream.place player opens.' },
  // The Stream tab's embed switches: which of the player's live
  // sources the watch page offers. The default (none off) is every source, so nothing changes until an
  // admin switches one off; a list that switches every source off is ignored (fail open: a player with
  // no source is a dark site).
  { key: 'player.embedsOff', kind: 'list', values: ['native', 'streamplace', 'youtube', 'twitch'], default: [], scope: 'public', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['PLAYER_EMBEDS_OFF'], packages: ['web'],
    label: 'Player sources switched off',
    description: 'The live sources the watch page does not offer: native (the site\'s own player), streamplace, youtube, twitch. Empty = all of them. Switched in the Stream tab; switching every one off is ignored.' },

  // ── Payments ─────────────────────────────────────────────────────────────────────────────
  // The publishable key is public by design (Stripe.js in the browser needs it), so it is a plain
  // setting the Stripe setup page writes; the browser asks for it at run time.
  // An older build-time NEXT_PUBLIC_ copy is still read as an override.
  { key: 'stripe.publishableKey', kind: 'string', maxLength: 200, default: null, scope: 'public', module: 'stripe', secret: false,
    reload: 'live', tier: 'instance', env: ['STRIPE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY'], packages: ['web'],
    label: 'Stripe publishable key',
    description: 'The pk_… key the card form in the browser uses. Public by design; pairs with the restricted key.' },
  { key: 'paypal.env', kind: 'enum', values: ['live', 'sandbox'], default: null, scope: 'server', module: 'paypal', secret: false,
    reload: 'live', tier: 'instance', env: ['PAYPAL_ENV'], packages: ['web'],
    label: 'PayPal environment',
    description: 'live or sandbox. PayPal stays off until this and both PayPal credentials are set.' },
  { key: 'money.subscribeUrl', kind: 'url', default: null, scope: 'public', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['SUBSCRIBE_URL'], packages: ['web'],
    label: 'Outside subscribe link',
    description: 'Where the Subscribe button goes when Stripe is not set up (e.g. a Patreon page). Unset = no Subscribe button without Stripe.' },
  { key: 'money.supportLine', kind: 'string', maxLength: 400, default: null, scope: 'public', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['DONO_LINKS'], packages: ['stream-ingest'],
    label: '!dono reply',
    description: 'What the bot posts in platform chat when someone types !dono. Unset = a line pointing at this site\'s tip page.' },

  // ── Currency ─────────────────────────────────────────────────────────────────────────────
  // The NAME, symbol and icon are install tier (env, read when web starts), like site.name. Product
  // defaults are neutral words; an install's own is env.
  { key: 'currency.name', kind: 'string', maxLength: 24, default: 'point', productDefault: true, scope: 'public', module: 'currency', secret: false,
    reload: 'restart', tier: 'install', env: ['CURRENCY_NAME'], packages: ['web'],
    label: 'Points name (one)',
    description: 'What one unit of the site currency is called: "1 point". Shown everywhere a balance, a price or an earning is.' },
  { key: 'currency.namePlural', kind: 'string', maxLength: 24, default: 'points', productDefault: true, scope: 'public', module: 'currency', secret: false,
    reload: 'restart', tier: 'install', env: ['CURRENCY_NAME_PLURAL'], packages: ['web'],
    label: 'Points name (many)',
    description: 'The plural: "150 points". Set it to the same word as the name for a word with no plural.' },
  { key: 'currency.symbol', kind: 'string', maxLength: 4, default: 'pts', productDefault: true, scope: 'public', module: 'currency', secret: false,
    reload: 'restart', tier: 'install', env: ['CURRENCY_SYMBOL'], packages: ['web'],
    label: 'Points symbol',
    description: 'The short mark after a number where the name would crowd it: a balance chip, "+2" when you earn. One letter sits right after the number; a longer one gets a space.' },
  { key: 'currency.icon', kind: 'string', default: null, scope: 'public', module: 'currency', secret: false,
    reload: 'restart', tier: 'install', env: ['CURRENCY_ICON'], packages: ['web'],
    label: 'Points icon',
    description: 'The picture shown beside points: a path on this site (/my-icon.webp) or an https address. Unset = the built-in coin.' },
  { key: 'community.scoreName', kind: 'string', maxLength: 32, default: 'Karma', productDefault: true, scope: 'public', module: 'currency', secret: false,
    reload: 'restart', tier: 'install', env: ['COMMUNITY_SCORE_NAME'], packages: ['web'],
    label: 'Vote score name',
    description: 'What a person\'s score from votes on their messages is called (Home\'s boards, the user card). Its last word names the per-100-messages board.' },
  // The economy: instance tier, live. Defaults are the product's own numbers.
  { key: 'currency.purchasable', kind: 'bool', default: false, scope: 'public', module: 'currency', secret: false,
    reload: 'live', tier: 'instance', env: ['CURRENCY_PURCHASABLE'], packages: ['web'],
    label: 'Points can be bought',
    description: 'On = people can buy points with money (the Store\'s top-up, and a tip with Announce off). Needs Stripe or PayPal. Off = points are only earned.' },
  { key: 'currency.earn.firstMessage', kind: 'number', integer: true, min: 0, max: 1000, default: 5, scope: 'server', module: 'currency', secret: false,
    reload: 'live', tier: 'instance', env: ['CURRENCY_EARN_FIRST_MESSAGE'], packages: ['web'],
    label: 'First message of the stream',
    description: 'Points for a person\'s first chat message of each stream (paid on top of the message points).' },
  { key: 'currency.earn.message', kind: 'number', integer: true, min: 0, max: 1000, default: 1, scope: 'server', module: 'currency', secret: false,
    reload: 'live', tier: 'instance', env: ['CURRENCY_EARN_MESSAGE'], packages: ['web'],
    label: 'A chat message',
    description: 'Points for a chat message while live, at most once per cooldown.' },
  { key: 'currency.earn.messageCooldownMinutes', kind: 'number', integer: true, min: 1, max: 1440, default: 10, scope: 'server', module: 'currency', secret: false,
    reload: 'live', tier: 'instance', env: ['CURRENCY_EARN_MESSAGE_COOLDOWN_MINUTES'], packages: ['web'],
    label: 'Message cooldown (minutes)',
    description: 'Minutes between two paid messages from one person.' },
  { key: 'currency.earn.voteCast', kind: 'number', integer: true, min: 0, max: 1000, default: 1, scope: 'server', module: 'currency', secret: false,
    reload: 'live', tier: 'instance', env: ['CURRENCY_EARN_VOTE_CAST'], packages: ['web'],
    label: 'Casting a vote',
    description: 'Points for voting on someone else\'s message, up or down (once per message).' },
  { key: 'currency.earn.votesPerStream', kind: 'number', integer: true, min: 0, max: 10000, default: 25, scope: 'server', module: 'currency', secret: false,
    reload: 'live', tier: 'instance', env: ['CURRENCY_EARN_VOTES_PER_STREAM'], packages: ['web'],
    label: 'Paid votes per stream',
    description: 'How many of a person\'s votes pay, per stream.' },
  { key: 'currency.earn.upvoteReceived', kind: 'number', integer: true, min: 0, max: 1000, default: 2, scope: 'server', module: 'currency', secret: false,
    reload: 'live', tier: 'instance', env: ['CURRENCY_EARN_UPVOTE_RECEIVED'], packages: ['web'],
    label: 'An upvote received',
    description: 'Points for the author when someone upvotes their message.' },
  { key: 'currency.earn.paidUpvotesPerVoter', kind: 'number', integer: true, min: 0, max: 1000, default: 5, scope: 'server', module: 'currency', secret: false,
    reload: 'live', tier: 'instance', env: ['CURRENCY_EARN_PAID_UPVOTES_PER_VOTER'], packages: ['web'],
    label: 'Paid upvotes from one voter',
    description: 'Per stream, how many upvotes from the SAME voter pay the author — stops two accounts paying each other.' },
  { key: 'currency.earn.watchCap', kind: 'number', integer: true, min: 0, max: 10000, default: 30, scope: 'server', module: 'currency', secret: false,
    reload: 'live', tier: 'instance', env: ['CURRENCY_EARN_WATCH_CAP'], packages: ['web'],
    label: 'Watching cap per stream',
    description: 'The most points watching can pay in one stream.' },
  { key: 'currency.earn.watchMinutesPerPoint', kind: 'number', integer: true, min: 1, max: 1440, default: 10, scope: 'server', module: 'currency', secret: false,
    reload: 'live', tier: 'instance', env: ['CURRENCY_EARN_WATCH_MINUTES_PER_POINT'], packages: ['web'],
    label: 'Minutes watched per point',
    description: 'Minutes of watching (signed in, tab visible, stream live) for one point.' },
  { key: 'currency.earn.clockMultiplier', kind: 'number', integer: true, min: 1, max: 10, default: 2, scope: 'public', module: 'currency', secret: false,
    reload: 'live', tier: 'instance', env: ['CURRENCY_EARN_CLOCK_MULTIPLIER'], packages: ['web'],
    label: 'Sponsor clock multiplier',
    description: 'While a supporter\'s sponsor clock is lit, their chat, vote and upvote points are multiplied by this (watching is not). 1 = no bonus.' },

  // ── AI routing, bot, help desk, memory ───────────────────────────────────────────────────
  // `surface: 'ai'` = edited on the AI page, so the Credentials page does not list them.
  { key: 'ai.mode', kind: 'enum', values: ['simple', 'advanced'], default: 'simple', scope: 'server', module: 'ai', secret: false,
    reload: 'live', tier: 'instance', env: ['AI_MODE'], packages: ['stream-api', 'stream-ingest'], surface: 'ai',
    label: 'AI mode', description: 'simple = one model for every chat task (ai.default); advanced = a connection and model per task.' },
  { key: 'ai.default', kind: 'aiRoute', default: null, scope: 'server', module: 'ai', secret: false,
    reload: 'live', tier: 'instance', env: [], packages: ['stream-api', 'stream-ingest'], surface: 'ai',
    label: 'Default model', description: 'The connection and model every chat task uses unless it has its own.' },
  { key: 'ai.connections', kind: 'aiConnections', default: [], scope: 'server', module: 'ai', secret: false,
    reload: 'live', tier: 'instance', env: [], packages: ['stream-api', 'stream-ingest'], surface: 'ai',
    label: 'Custom AI connections', description: 'OpenAI-compatible endpoints (a local server, OpenRouter, …) besides the built-in Anthropic and OpenAI ones.' },
  { key: 'ai.tasks', kind: 'aiTasks', default: null, scope: 'server', module: 'ai', secret: false,
    reload: 'live', tier: 'instance', env: [], packages: ['stream-api', 'stream-ingest'], surface: 'ai',
    label: 'AI tasks', description: 'Per task: switched on or off, and (advanced mode) its own connection, model and token cap.' },
  { key: 'ai.embeddings', kind: 'aiRoute', default: null, scope: 'server', module: 'memory', secret: false,
    reload: 'live', tier: 'instance', env: [], packages: ['stream-api', 'stream-ingest'], surface: 'ai',
    label: 'Memory embedder', description: 'The OpenAI-compatible connection and model that embeds messages for memory. Changed only through the memory panel.' },
  { key: 'bot.name', kind: 'string', maxLength: 32, default: null, scope: 'public', module: 'bot', secret: false,
    reload: 'live', tier: 'instance', env: ['BOT_NAME'], packages: ['web', 'stream-api', 'stream-ingest'], surface: 'ai',
    label: 'Bot name', description: 'The chat bot\'s and the help desk\'s display name. Unset = "Bot" (and "Help" for the help desk).' },
  { key: 'bot.enabled', kind: 'bool', default: false, scope: 'server', module: 'bot', secret: false,
    reload: 'live', tier: 'instance', env: ['BOT_ENABLED'], packages: ['stream-ingest'], surface: 'ai',
    label: 'Chat bot', description: 'Answer chat messages that mention the bot by name (needs the chat bot task configured). Off unless a plugin brings its own bot.' },
  { key: 'helpdesk.enabled', kind: 'bool', default: false, scope: 'server', module: 'helpdesk', secret: false,
    reload: 'live', tier: 'instance', env: ['HELPDESK_ENABLED'], packages: ['stream-ingest'], surface: 'ai',
    label: 'Help desk', description: 'Answer help pop-up questions with the AI (needs the help desk task configured). Off = a person answers.' },
  { key: 'automod.enabled', kind: 'bool', default: false, scope: 'server', module: 'automod', secret: false,
    reload: 'live', tier: 'instance', env: ['AUTOMOD_ENABLED'], packages: ['web', 'stream-api', 'stream-ingest'], surface: 'ai',
    label: 'Automod', description: 'Check chat messages with the AI: risky site messages are held for a moderator, risky platform messages are flagged. Never removes anything by itself.' },
  { key: 'automod.categories', kind: 'list', default: ['harassment', 'hate', 'sexual', 'threat', 'self-harm', 'spam', 'scam'], productDefault: true, scope: 'server', module: 'automod', secret: false,
    reload: 'live', tier: 'instance', env: ['AUTOMOD_CATEGORIES'], packages: ['stream-api', 'stream-ingest'], surface: 'ai',
    label: 'Automod categories', description: 'What the check may call risky (lower-case words, comma-separated in env).' },
  { key: 'automod.minConfidence', kind: 'number', min: 0, max: 1, default: 0.7, scope: 'server', module: 'automod', secret: false,
    reload: 'live', tier: 'instance', env: ['AUTOMOD_MIN_CONFIDENCE'], packages: ['stream-api', 'stream-ingest'], surface: 'ai',
    label: 'Automod confidence floor', description: 'Below this a risky verdict counts as ok.' },
  { key: 'automod.holdBudgetMs', kind: 'number', integer: true, min: 200, max: 5000, default: 1200, scope: 'server', module: 'automod', secret: false,
    reload: 'live', tier: 'instance', env: ['AUTOMOD_HOLD_BUDGET_MS'], packages: ['web', 'stream-api'], surface: 'ai',
    label: 'Automod time budget', description: 'Milliseconds a site message may wait on the check; past it the message is delivered unchecked.' },
  { key: 'automod.markAfterCount', kind: 'number', integer: true, min: 1, max: 50, default: 3, scope: 'server', module: 'automod', secret: false,
    reload: 'live', tier: 'instance', env: ['AUTOMOD_MARK_AFTER_COUNT'], packages: ['stream-api'], surface: 'ai',
    label: 'Suspicious mark after', description: 'Risky messages from one person, within the window below, before mods see a "suspicious" mark.' },
  { key: 'automod.markAfterHours', kind: 'number', integer: true, min: 1, max: 720, default: 24, scope: 'server', module: 'automod', secret: false,
    reload: 'live', tier: 'instance', env: ['AUTOMOD_MARK_AFTER_HOURS'], packages: ['stream-api'], surface: 'ai',
    label: 'Suspicious mark window', description: 'Hours the count above looks back.' },
  { key: 'automod.skipSupporters', kind: 'bool', default: false, scope: 'server', module: 'automod', secret: false,
    reload: 'live', tier: 'instance', env: ['AUTOMOD_SKIP_SUPPORTERS'], packages: ['web'], surface: 'ai',
    label: 'Automod skips supporters', description: 'Paying supporters are not checked (staff, mods and the bot never are).' },
  { key: 'automod.holdExpiry', kind: 'number', integer: true, min: 30, max: 3600, default: 120, scope: 'server', module: 'automod', secret: false,
    reload: 'live', tier: 'instance', env: ['AUTOMOD_HOLD_EXPIRY'], packages: ['stream-api'], surface: 'ai',
    label: 'Unreviewed hold expiry', description: 'Seconds an AI-held message waits for a moderator before it is dropped (word-filter and link holds are not swept).' },
  { key: 'memory.enabled', kind: 'bool', default: false, scope: 'server', module: 'memory', secret: false,
    reload: 'live', tier: 'instance', env: ['MEMORY_ENABLED'], packages: ['stream-api', 'stream-ingest'], surface: 'ai',
    label: 'Memory', description: 'Embed new chat messages so the bot can recall them. Switched on by the memory panel after a successful probe.' },
  { key: 'memory.state', kind: 'memoryState', default: null, scope: 'server', module: 'memory', secret: false,
    reload: 'live', tier: 'instance', env: [], packages: ['stream-api', 'stream-ingest'], surface: 'ai', writer: 'stream-api',
    label: 'Memory state', description: 'The embedder in use, its dimension, since when, and on / paused / switching. Written by stream-api only.' },
  { key: 'memory.retentionDays', kind: 'number', nullable: true, integer: true, min: 1, max: 3650, default: 90, scope: 'server', module: 'memory', secret: false,
    reload: 'live', tier: 'instance', env: ['MEMORY_RETENTION_DAYS'], packages: ['stream-api'], surface: 'ai',
    label: 'Memory retention', description: 'Days a remembered message is kept (null / "forever" = kept until a person is forgotten).' },
  { key: 'memory.minWords', kind: 'number', integer: true, min: 1, max: 50, default: 4, scope: 'server', module: 'memory', secret: false,
    reload: 'live', tier: 'instance', env: ['MEMORY_MIN_WORDS'], packages: ['stream-ingest'], surface: 'ai',
    label: 'Memory word floor', description: 'A message needs at least this many words (emotes removed) to be remembered.' },

  // ── Modules ──────────────────────────────────────────────────────────────────────────────
  // One restart-applied switch per manifest in config/modules.mjs, plus the addresses the OBS and
  // lights modules dial. No address has a default host: unset OBS = OBS's own default on this
  // machine; unset Home Assistant = lights stay off.
  // The two addresses are INSTALL tier (env only): each is where a stored credential is sent
  // (the HA token as a bearer header, the OBS password's handshake). An address editable from the
  // dashboard would let whoever edits it collect the credential at a host of their choosing.
  ...MODULES.map((m) => ({
    key: `modules.${m.id}`, kind: 'bool', default: m.defaultOn, scope: 'server', module: m.id, secret: false,
    // The website reads its switches at call time; a server process captures them at its start.
    reload: m.packages.every((p) => p === 'web') ? 'live' : 'restart', tier: 'instance', env: [`MODULE_${m.id.toUpperCase()}`], packages: [...m.packages],
    ...(m.legacyOn ? { legacyOn: true } : {}),
    label: m.label, description: m.description,
  })),
  { key: 'obs.url', kind: 'wsOrigin', default: null, scope: 'server', module: 'obs', secret: false,
    reload: 'restart', tier: 'install', env: ['OBS_WS_URL'], packages: ['stream-api'],
    label: 'OBS WebSocket address', description: 'Where OBS listens (ws://host:4455), for a server on the same network as OBS. Unset = no OBS WebSocket: the rig page browser source is the only path to OBS.' },
  // OBS finds scenes and sources BY NAME, and the names are the streamer's own. No default names
  // one: each unset name switches off just the part it drives, quietly. Read at use time.
  { key: 'obs.soundSource', kind: 'string', default: null, scope: 'server', module: 'obs', secret: false,
    reload: 'live', tier: 'instance', env: ['OBS_SOUND_SOURCE'], packages: ['stream-api'],
    label: 'Alert sound source', description: 'The media source (in the OBS_AUDIO_SCENE scene, "Audio" unless set) replayed for an alert. Unset = alerts play no OBS sound.' },
  { key: 'obs.botScene', kind: 'string', default: null, scope: 'server', module: 'obs', secret: false,
    reload: 'live', tier: 'instance', env: ['OBS_BOT_SCENE'], packages: ['stream-api'],
    label: 'Bot avatar scene', description: 'The scene that holds the bot\'s avatar source. Unset (or no avatar source) = the avatar is never shown or hidden.' },
  { key: 'obs.botSource', kind: 'string', default: null, scope: 'server', module: 'obs', secret: false,
    reload: 'live', tier: 'instance', env: ['OBS_BOT_SOURCE'], packages: ['stream-api'],
    label: 'Bot avatar source', description: 'The avatar source inside that scene: shown while the bot speaks, hidden otherwise. Unset = no avatar toggling.' },
  { key: 'obs.botShowScene', kind: 'string', default: null, scope: 'server', module: 'obs', secret: false,
    reload: 'live', tier: 'instance', env: ['OBS_BOT_SHOW_SCENE'], packages: ['stream-api'],
    label: 'Avatar always-on scene', description: 'A program scene (a break / be-right-back scene) on which the avatar stays visible even when the bot is quiet. Unset = visible only while speaking.' },
  { key: 'timer.pauseScene', kind: 'string', default: null, scope: 'server', module: 'obs', secret: false,
    reload: 'live', tier: 'instance', env: ['TIMER_PAUSE_SCENE'], packages: ['stream-api'],
    label: 'Timer pause scene', description: 'The stream timer pauses while OBS shows this scene and plays on any other. Unset = scene changes never pause or play the timer.' },
  // The rig page's key is derived from STREAM_API_SECRET and this generation (stream-api/rig.js);
  // "Regenerate" on the OBS page raises it. Never the key itself: nothing stores a usable key.
  // The env name only pins a generation (Regenerate then changes nothing, and says so).
  { key: 'obs.rigKeyVersion', kind: 'number', integer: true, nullable: true, min: 1, max: 1000000000, default: null, scope: 'server', module: 'obs', secret: false,
    reload: 'live', tier: 'instance', env: ['OBS_RIG_KEY_VERSION'], packages: ['stream-api'], surface: 'rig',
    label: 'Rig page key generation', description: 'Raised by "Regenerate" on the OBS page; the rig page key is made from it and the chat service\'s secret.' },
  { key: 'tts.sink', kind: 'string', default: null, scope: 'server', module: 'tts', secret: false,
    reload: 'live', tier: 'instance', env: ['TTS_SINK'], packages: ['stream-api'],
    label: 'Speech output', description: 'The PipeWire sink spoken audio is played into (its monitor can feed OBS and a lip-sync avatar). Unset = the default audio output.' },
  { key: 'tts.dualVoice', kind: 'bool', default: false, scope: 'server', module: 'tts', secret: false,
    reload: 'live', tier: 'instance', env: ['TTS_DUAL_VOICE'], packages: ['stream-api'],
    label: 'Loud voice for shouting', description: 'Speak ALL-CAPS and "!!" sentences with the loud voice (ELEVENLABS_VOICE_LOUD) and the rest with the casual one. Off = one voice for everything.' },
  { key: 'tts.clipsDir', kind: 'string', default: null, scope: 'server', module: 'tts', secret: false,
    reload: 'live', tier: 'instance', env: ['TTS_CLIPS_DIR'], packages: ['stream-api'],
    label: 'Voice clips folder', description: 'The folder of the bot\'s own short sounds (<id>.v0.mp3 …) played on its voice output; a relative path is inside the chat service\'s folder. Unset = no clips.' },
  { key: 'homeassistant.url', kind: 'origin', default: null, scope: 'server', module: 'lights', secret: false,
    reload: 'restart', tier: 'install', env: ['HA_URL'], packages: ['stream-api'],
    label: 'Home Assistant address', description: 'Where Home Assistant answers (http://host:8123). Unset = the lights stay off.' },

  // ── Credentials (secret tier) ────────────────────────────────────────────────────────────
  { key: 'backup.s3.accessKeyId', kind: 'secret', default: null, scope: 'server', module: 'core', secret: true,
    reload: 'live', tier: 'secret', env: ['BACKUP_S3_ACCESS_KEY_ID'], packages: ['stream-api'],
    label: 'Bucket access key id', description: 'The backup bucket\'s access key id (backup target s3). Read by the server\'s backup job, never by the site.' },
  { key: 'backup.s3.secretAccessKey', kind: 'secret', default: null, scope: 'server', module: 'core', secret: true,
    reload: 'live', tier: 'secret', env: ['BACKUP_S3_SECRET_ACCESS_KEY'], packages: ['stream-api'],
    label: 'Bucket secret key', description: 'The backup bucket\'s secret key (backup target s3). Read by the server\'s backup job, never by the site.' },
  { key: 'matrix.oauth.clientSecret', kind: 'secret', default: null, scope: 'server', module: 'core', secret: true,
    reload: 'live', tier: 'secret', env: ['MATRIX_OAUTH_CLIENT_SECRET', 'MAS_CLIENT_SECRET'], packages: ['web'],
    label: 'Matrix sign-in client secret', description: 'Pairs with the sign-in client id: code exchange, token refresh, revocation.' },
  { key: 'anthropic.apiKey', kind: 'secret', default: null, scope: 'server', module: 'ai', secret: true,
    reload: 'live', tier: 'secret', env: ['ANTHROPIC_API_KEY'], packages: ['stream-api', 'stream-ingest'],
    test: 'anthropic', label: 'Anthropic API key', description: 'The built-in Anthropic connection: every AI task routed to it.' },
  { key: 'openai.apiKey', kind: 'secret', default: null, scope: 'server', module: 'ai', secret: true,
    reload: 'live', tier: 'secret', env: ['OPENAI_API_KEY'], packages: ['stream-ingest'],
    test: 'openai', label: 'OpenAI API key', description: 'The built-in OpenAI connection: every AI task routed to it, and memory embeddings.' },
  { key: 'elevenlabs.apiKey', kind: 'secret', default: null, scope: 'server', module: 'tts', secret: true,
    reload: 'live', tier: 'secret', env: ['ELEVENLABS_API_KEY'], packages: ['stream-api'],
    test: 'elevenlabs', label: 'ElevenLabs API key', description: 'Text-to-speech for alerts and the bot.' },
  { key: 'stripe.secretKey', kind: 'secret', default: null, scope: 'server', module: 'stripe', secret: true,
    reload: 'restart', tier: 'secret', env: ['STRIPE_SECRET_KEY'], packages: ['web'],
    test: 'stripe', label: 'Stripe secret key', description: 'Card payments: subscriptions, gifts, tips, coins.' },
  { key: 'stripe.webhookSecret', kind: 'secret', default: null, scope: 'server', module: 'stripe', secret: true,
    reload: 'live', tier: 'secret', env: ['STRIPE_WEBHOOK_SECRET'], packages: ['web'],
    test: 'stripe-webhook', label: 'Stripe webhook signing secret', description: 'Verifies that a payment event really came from Stripe.' },
  { key: 'paypal.clientId', kind: 'secret', default: null, scope: 'public', module: 'paypal', secret: true,
    reload: 'live', tier: 'secret', env: ['PAYPAL_CLIENT_ID'], packages: ['web'],
    test: 'paypal', label: 'PayPal client id', description: 'Public by design (the PayPal button needs it); stored with the secret it pairs with.' },
  { key: 'paypal.clientSecret', kind: 'secret', default: null, scope: 'server', module: 'paypal', secret: true,
    reload: 'live', tier: 'secret', env: ['PAYPAL_CLIENT_SECRET'], packages: ['web'],
    test: 'paypal', label: 'PayPal client secret', description: 'PayPal and Venmo payments.' },
  { key: 'paypal.webhookId', kind: 'secret', default: null, scope: 'server', module: 'paypal', secret: true,
    reload: 'live', tier: 'secret', env: ['PAYPAL_WEBHOOK_ID'], packages: ['web'],
    test: 'paypal-webhook', label: 'PayPal webhook id', description: 'Verifies that a payment event really came from PayPal.' },
  { key: 'twitch.clientId', kind: 'secret', default: null, scope: 'server', module: 'core', secret: true,
    reload: 'live', tier: 'secret', env: ['TWITCH_OAUTH_CLIENT_ID', 'TWITCH_CLIENT_ID'], packages: ['web', 'stream-api', 'stream-ingest'],
    test: 'twitch', label: 'Twitch app client id', description: 'Twitch sign-in, account linking, moderation and stream status.' },
  { key: 'twitch.clientSecret', kind: 'secret', default: null, scope: 'server', module: 'core', secret: true,
    reload: 'live', tier: 'secret', env: ['TWITCH_OAUTH_CLIENT_SECRET', 'TWITCH_CLIENT_SECRET'], packages: ['web', 'stream-api', 'stream-ingest'],
    test: 'twitch', label: 'Twitch app client secret', description: 'Pairs with the Twitch app client id.' },
  { key: 'kick.clientId', kind: 'secret', default: null, scope: 'server', module: 'core', secret: true,
    reload: 'live', tier: 'secret', env: ['KICK_CLIENT_ID'], packages: ['web', 'stream-ingest'],
    test: 'kick', label: 'Kick app client id', description: 'Kick account linking and the chat reader.' },
  { key: 'kick.clientSecret', kind: 'secret', default: null, scope: 'server', module: 'core', secret: true,
    reload: 'live', tier: 'secret', env: ['KICK_CLIENT_SECRET'], packages: ['web', 'stream-ingest'],
    test: 'kick', label: 'Kick app client secret', description: 'Pairs with the Kick app client id.' },
  { key: 'youtube.apiKey', kind: 'secret', default: null, scope: 'server', module: 'core', secret: true,
    reload: 'live', tier: 'secret', env: ['YOUTUBE_API_KEY'], packages: ['web', 'stream-api', 'stream-ingest'],
    test: 'youtube', label: 'YouTube Data API key', description: 'Live detection, VODs, the channel avatar and account-age checks.' },
  { key: 'youtube.oauthClientId', kind: 'secret', default: null, scope: 'server', module: 'core', secret: true,
    reload: 'live', tier: 'secret', env: ['YOUTUBE_OAUTH_CLIENT_ID'], packages: ['web'],
    label: 'YouTube sign-in client id', description: 'Google account linking.' },
  { key: 'youtube.oauthClientSecret', kind: 'secret', default: null, scope: 'server', module: 'core', secret: true,
    reload: 'live', tier: 'secret', env: ['YOUTUBE_OAUTH_CLIENT_SECRET'], packages: ['web'],
    label: 'YouTube sign-in client secret', description: 'Pairs with the YouTube sign-in client id.' },
  { key: 'kofi.verificationToken', kind: 'secret', default: null, scope: 'server', module: 'kofi', secret: true,
    reload: 'live', tier: 'secret', env: ['KOFI_VERIFICATION_TOKEN'], packages: ['stream-api'],
    label: 'Ko-fi verification token', description: 'Verifies that a Ko-fi donation webhook is real.' },
  { key: 'patreon.webhookSecret', kind: 'secret', default: null, scope: 'server', module: 'patreon', secret: true,
    reload: 'live', tier: 'secret', env: ['PATREON_WEBHOOK_SECRET'], packages: ['stream-api'],
    label: 'Patreon webhook secret', description: 'Verifies that a Patreon pledge webhook is real.' },
  { key: 'streamlabs.socketToken', kind: 'secret', default: null, scope: 'server', module: 'streamlabs', secret: true,
    reload: 'restart', tier: 'secret', env: ['STREAMLABS_SOCKET_TOKEN'], packages: ['stream-api'],
    label: 'Streamlabs socket token', description: 'The Streamlabs donation feed.' },
  { key: 'obs.password', kind: 'secret', default: null, scope: 'server', module: 'obs', secret: true,
    reload: 'restart', tier: 'secret', env: ['OBS_WS_PASSWORD'], packages: ['stream-api'],
    test: 'obs', label: 'OBS WebSocket password', description: 'Scenes, sounds and the bot avatar in OBS.' },
  { key: 'homeassistant.token', kind: 'secret', default: null, scope: 'server', module: 'lights', secret: true,
    reload: 'live', tier: 'secret', env: ['HA_TOKEN'], packages: ['stream-api'],
    test: 'homeassistant', label: 'Home Assistant token', description: 'Room lights.' },
  { key: 'ntfy.wakeUrl', kind: 'secret', default: null, scope: 'server', module: 'core', secret: true,
    reload: 'live', tier: 'secret', env: ['NTFY_WAKE_URL'], packages: ['stream-api'],
    label: 'Alert push — urgent topic', description: 'Where critical operator alerts are pushed. The topic URL is the secret.' },
  { key: 'ntfy.quietUrl', kind: 'secret', default: null, scope: 'server', module: 'core', secret: true,
    reload: 'live', tier: 'secret', env: ['NTFY_QUIET_URL'], packages: ['stream-api'],
    label: 'Alert push — quiet topic', description: 'Where non-urgent operator alerts are pushed.' },

  // ── First boot ───────────────────────────────────────────────────────────────────────────
  // `setup.completedAt` unset on an install that has a setup link (SETUP_TOKEN_HASH) = the site
  // shows only its setup pages. A database that predates the setup pages gets the row from a migration.
  { key: 'setup.completedAt', kind: 'string', maxLength: 40, default: null, scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: ['SETUP_COMPLETED_AT'], packages: ['web'], surface: 'setup',
    label: 'Setup finished', description: 'When the setup pages were finished (ISO time). Unset on an install with a setup link = the site shows only its setup pages.' },
  // The setup pages' own progress: the step to come back to, the first admin while it is being
  // made, the steps skipped (they stay on the checklist), when the last test backup was asked for, and the display values (by .env name) waiting to be written into .env at the end. The
  // host's `apply-install` request reads `install` and writes it into .env — so `values` lists the
  // only names it may hold: exactly `blackbranch set`'s (install/bundle.test.mjs checks that).
  { key: 'setup.state', kind: 'setupState', default: null, scope: 'server', module: 'core', secret: false,
    reload: 'live', tier: 'instance', env: [], packages: ['web'], surface: 'setup',
    values: ['SITE_NAME', 'SITE_SHORT_NAME', 'SITE_TAGLINE', 'SITE_DESCRIPTION', 'SITE_HOME_HEADING', 'SITE_HOME_INTRO', 'SITE_ICON_SET',
      'LEGAL_OPERATOR', 'LEGAL_CONTACT_EMAIL', 'LEGAL_GOVERNING_LAW', 'LEGAL_EFFECTIVE_DATE',
      'CURRENCY_NAME', 'CURRENCY_NAME_PLURAL', 'CURRENCY_SYMBOL', 'CURRENCY_ICON', 'COMMUNITY_SCORE_NAME', 'YOUTUBE_VOD_PLAYLIST'],
    label: 'Setup progress', description: 'Where the setup pages are, and the display values they will write into the site\'s settings file when setup finishes.' },
];

/**
 * Keys that exist once per thing an install creates — one key per custom AI connection
 * (`ai.connection.<id>.apiKey`). A pattern has ONE `*`, standing for a slug
 * `[a-z0-9-]{1,24}`. Kept apart from INSTANCE_KEYS on purpose: every loop over the fixed keys
 * (boot checks, status reports, the Credentials page) must not meet a key with a `*` in it.
 * Whether a concrete key may be WRITTEN (does that connection exist?) is the writer's check
 * (stream-api); instanceEntry only says what kind of key it is.
 * @type {InstanceEntry[]}
 */
export const INSTANCE_KEY_PATTERNS = [
  { key: 'ai.connection.*.apiKey', kind: 'secret', default: null, scope: 'server', module: 'ai', secret: true,
    reload: 'live', tier: 'secret', env: [], packages: ['stream-api', 'stream-ingest'], surface: 'ai',
    label: 'Connection key', description: 'The key for one of this install\'s own AI connections. Set on the AI page; bound to that connection\'s address.' },
];

/**
 * The entry for a key: a fixed key's own, or a pattern's with `key` set to the concrete name.
 * null for anything else.
 * Self-contained except for INSTANCE_KEYS and INSTANCE_KEY_PATTERNS, emitted beside it.
 */
export function instanceEntry(key) {
  if (typeof key !== 'string' || key.length > 128) return null;
  const fixed = INSTANCE_KEYS.find((e) => e.key === key);
  if (fixed) return fixed;
  for (const p of INSTANCE_KEY_PATTERNS) {
    const [pre, post] = p.key.split('*');
    if (!key.startsWith(pre) || !key.endsWith(post)) continue;
    const id = key.slice(pre.length, key.length - post.length);
    if (/^[a-z0-9-]{1,24}$/.test(id)) return { ...p, key };
  }
  return null;
}

/**
 * Parse one raw value for an entry. Returns { ok: true, value } or { ok: false, error }.
 * `raw` is a string (from env, comma-separated for a list) or a JSON value (from the DB / an
 * edit). Never falls back to a default: a value that does not parse is an error the caller
 * reports — a typo'd origin silently replaced by a default is how a site points at the wrong
 * place.
 * Self-contained on purpose: the generator emits this function's own source text.
 */
export function parseInstanceValue(entry, raw) {
  const kind = entry.kind;
  if (kind === 'backupRepository') {
    // Where the box's backup tool (restic, run as root) connects: an allowlist of exactly two shapes,
    // because every other restic backend is a way to make the box reach something else — rest:
    // (any URL, e.g. a cloud metadata address), rclone: (runs a program), a plain path (anywhere on
    // disk), file:, b2:, azure:, gs:. The host also resolves the name and refuses loopback,
    // link-local, multicast and the bundle's own network before every run (install/backup/target-check.mjs).
    const v = typeof raw === 'string' ? raw.trim() : '';
    const shapes = 'expected s3:https://<host>[:port]/<bucket>[/<folder>] or sftp:<user>@<host>:/<folder> (sftp://<user>@<host>:<port>/<folder> for another port) — nothing else (no rest:, rclone:, b2:, azure:, gs:, file: or plain folders)';
    if (!v || v.length > 300 || /[\s"'`$\\]/.test(v)) return { ok: false, error: shapes };
    const host = '((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]|\\d{1,3}(?:\\.\\d{1,3}){3})';
    const port = '(?::(\\d{1,5}))?';
    const folder = '((?:/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*)/?';
    const m = new RegExp(`^s3:https://${host}${port}/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])${folder}$`).exec(v.toLowerCase().startsWith('s3:') ? `s3:${v.slice(3).replace(/^https:\/\/[^/]*/i, (h) => h.toLowerCase())}` : '')
      || new RegExp(`^sftp:([a-z_][a-z0-9_.-]{0,31})@${host}:${folder}$`).exec(v)
      || new RegExp(`^sftp://([a-z_][a-z0-9_.-]{0,31})@${host}${port}${folder}$`).exec(v);
    if (!m) return { ok: false, error: shapes };
    if (/(^|\/)\.\.(\/|$)/.test(v)) return { ok: false, error: 'the folder may not contain ..' };
    const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(m[1]) ? m[1].split('.').map(Number) : null;
    if (ip && ip.some((n) => n > 255)) return { ok: false, error: 'not an IP address' };
    const p = v.startsWith('s3:') ? m[2] : v.startsWith('sftp://') ? m[3] : undefined;
    if (p !== undefined && (Number(p) < 1 || Number(p) > 65535)) return { ok: false, error: 'the port must be 1–65535' };
    return { ok: true, value: v };
  }
  if (kind === 'bool') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    if (typeof raw === 'string' && /^(1|true|yes|on)$/i.test(raw.trim())) return { ok: true, value: true };
    if (typeof raw === 'string' && /^(0|false|no|off)$/i.test(raw.trim())) return { ok: true, value: false };
    return { ok: false, error: 'expected true or false' };
  }
  if (kind === 'number') {
    if (raw === null || (typeof raw === 'string' && /^(forever|none|null)$/i.test(raw.trim()))) {
      return entry.nullable ? { ok: true, value: null } : { ok: false, error: 'a number is required' };
    }
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!Number.isFinite(n)) return { ok: false, error: 'expected a number' };
    if (entry.integer && !Number.isInteger(n)) return { ok: false, error: 'expected a whole number' };
    if (typeof entry.min === 'number' && n < entry.min) return { ok: false, error: `at least ${entry.min}` };
    if (typeof entry.max === 'number' && n > entry.max) return { ok: false, error: `at most ${entry.max}` };
    return { ok: true, value: n };
  }
  if (kind === 'setupState') {
    let v = raw;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return { ok: false, error: 'expected JSON' }; } }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'expected {step, adminPending, install}' };
    if (!Object.keys(v).every((k) => ['step', 'adminPending', 'install', 'skipped', 'backupAskedAt', 'core'].includes(k))) return { ok: false, error: 'expected {step, adminPending, install, skipped, backupAskedAt, core}' };
    const out = {};
    if (v.step !== undefined) {
      if (typeof v.step !== 'string' || !/^[a-z][a-z0-9:-]{0,63}$/.test(v.step)) return { ok: false, error: 'step: a step id' };
      out.step = v.step;
    }
    if (v.adminPending !== undefined) {
      const a = v.adminPending;
      if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).length !== 2
        || typeof a.id !== 'string' || !/^[0-9A-Z]{26}$/.test(a.id)
        || typeof a.username !== 'string' || !/^[a-z0-9._=/-]{1,64}$/.test(a.username)) {
        return { ok: false, error: 'adminPending: {id, username}' };
      }
      out.adminPending = { id: a.id, username: a.username };
    }
    if (v.install !== undefined) {
      const inst = v.install;
      if (!inst || typeof inst !== 'object' || Array.isArray(inst)) return { ok: false, error: 'install: an object of .env names' };
      const allowed = entry.values || [];
      const vals = {};
      for (const [name, val] of Object.entries(inst)) {
        if (!allowed.includes(name)) return { ok: false, error: `install: ${name.slice(0, 40)} is not a display value` };
        // .env cannot hold these (Compose's .env has no escape for them) — the host refuses them too.
        if (typeof val !== 'string' || val.length > 300 || /[$"\\]/.test(val) || [...val].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
          return { ok: false, error: `install: ${name} must be one line of at most 300 characters, without $, " or \\` };
        }
        vals[name] = val;
      }
      out.install = vals;
    }
    if (v.skipped !== undefined) {
      // Setup steps the operator chose to skip ("<module>:<step>"): they stay on the checklist.
      if (!Array.isArray(v.skipped) || v.skipped.length > 50 || !v.skipped.every((x) => typeof x === 'string' && /^[a-z0-9:-]{1,64}$/.test(x))) {
        return { ok: false, error: 'skipped: a list of step ids' };
      }
      out.skipped = [...new Set(v.skipped)];
    }
    if (v.core !== undefined) {
      // The product's setup lists chosen on the modules page (twitch, kick…): each gets its page.
      if (!Array.isArray(v.core) || v.core.length > 20 || !v.core.every((x) => typeof x === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(x))) {
        return { ok: false, error: 'core: a list of setup list ids' };
      }
      out.core = [...new Set(v.core)];
    }
    if (v.backupAskedAt !== undefined) {
      // When the finish step last asked the host for a test backup: only an answer from after it counts.
      if (typeof v.backupAskedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v.backupAskedAt)) {
        return { ok: false, error: 'backupAskedAt: a UTC time' };
      }
      out.backupAskedAt = v.backupAskedAt;
    }
    return { ok: true, value: out };
  }
  if (kind === 'aiRoute' || kind === 'aiTasks' || kind === 'aiConnections' || kind === 'memoryState') {
    // Structured values. Bounded at write so a stored row cannot grow without limit.
    let v = raw;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return { ok: false, error: 'expected JSON' }; } }
    let size = 0;
    try { size = JSON.stringify(v).length; } catch { return { ok: false, error: 'not serialisable' }; }
    if (size > 32768) return { ok: false, error: 'too large' };
    const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
    const slug = (x) => typeof x === 'string' && /^[a-z0-9-]{1,24}$/.test(x);
    const model = (x) => typeof x === 'string' && /^[\w.:/@-]{1,128}$/.test(x);
    const iso = (x) => typeof x === 'string' && x.length <= 40 && !Number.isNaN(Date.parse(x));
    const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));
    if (kind === 'aiRoute') {
      if (!isObj(v) || !onlyKeys(v, ['connection', 'model']) || !slug(v.connection) || !model(v.model)) {
        return { ok: false, error: 'expected {connection, model}' };
      }
      return { ok: true, value: { connection: v.connection, model: v.model } };
    }
    if (kind === 'aiTasks') {
      if (!isObj(v)) return { ok: false, error: 'expected an object of tasks' };
      const out = {};
      const ids = Object.keys(v);
      if (ids.length > 100) return { ok: false, error: 'too many tasks' };
      for (const id of ids) {
        const t = v[id];
        if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+){0,3}$/.test(id) || id.length > 64) return { ok: false, error: `bad task id ${id.slice(0, 64)}` };
        if (!isObj(t) || !onlyKeys(t, ['enabled', 'connection', 'model', 'maxTokens'])) return { ok: false, error: `${id}: expected {enabled, connection, model, maxTokens}` };
        if (t.enabled !== undefined && typeof t.enabled !== 'boolean') return { ok: false, error: `${id}: enabled must be true or false` };
        if (t.connection !== undefined && !slug(t.connection)) return { ok: false, error: `${id}: bad connection` };
        if (t.model !== undefined && !model(t.model)) return { ok: false, error: `${id}: bad model` };
        if ((t.connection === undefined) !== (t.model === undefined)) return { ok: false, error: `${id}: connection and model go together` };
        if (t.maxTokens !== undefined && !(Number.isInteger(t.maxTokens) && t.maxTokens >= 1 && t.maxTokens <= 64000)) return { ok: false, error: `${id}: maxTokens 1–64000` };
        out[id] = { ...t };
      }
      return { ok: true, value: out };
    }
    if (kind === 'aiConnections') {
      if (!Array.isArray(v) || v.length > 20) return { ok: false, error: 'expected a list of at most 20 connections' };
      const out = [];
      for (const c of v) {
        if (!isObj(c) || !onlyKeys(c, ['id', 'kind', 'label', 'baseUrl'])) return { ok: false, error: 'expected {id, kind, label, baseUrl}' };
        if (!slug(c.id) || ['anthropic', 'openai'].includes(c.id)) return { ok: false, error: 'id: a-z 0-9 - (1–24), not a built-in name' };
        if (out.some((o) => o.id === c.id)) return { ok: false, error: `duplicate connection ${c.id}` };
        if (c.kind !== 'openai-compatible') return { ok: false, error: `${c.id}: kind must be openai-compatible` };
        if (typeof c.label !== 'string' || !c.label.trim() || c.label.length > 64) return { ok: false, error: `${c.id}: label (1–64 characters)` };
        let u;
        try { u = new URL(String(c.baseUrl)); } catch { return { ok: false, error: `${c.id}: baseUrl is not a URL` }; }
        if (!['http:', 'https:'].includes(u.protocol) || u.search || u.hash || u.username || u.password) {
          return { ok: false, error: `${c.id}: baseUrl must be http(s), no query, fragment or credentials` };
        }
        out.push({ id: c.id, kind: c.kind, label: c.label.trim(), baseUrl: String(c.baseUrl).trim().replace(/\/+$/, '') });
      }
      return { ok: true, value: out };
    }
    // memoryState
    // `reduced`: the model is asked for exactly `dim` dimensions (an OpenAI-v3-style model whose
    // native length is over pgvector's 2,000 HNSW limit).
    if (!isObj(v) || !onlyKeys(v, ['model', 'connection', 'dim', 'since', 'status', 'pausedReason', 'pausedAt', 'reduced'])) {
      return { ok: false, error: 'expected {model, connection, dim, since, status}' };
    }
    if (!model(v.model) || !slug(v.connection)) return { ok: false, error: 'bad model or connection' };
    if (!Number.isInteger(v.dim) || v.dim < 1 || v.dim > 2000) return { ok: false, error: 'dim must be 1–2000' };
    if (!iso(v.since)) return { ok: false, error: 'since must be a date' };
    if (!['on', 'paused', 'switching'].includes(v.status)) return { ok: false, error: 'status: on, paused or switching' };
    if (v.pausedReason !== undefined && !(typeof v.pausedReason === 'string' && /^[a-z_]{1,40}$/.test(v.pausedReason))) return { ok: false, error: 'bad pausedReason' };
    if (v.pausedAt !== undefined && !iso(v.pausedAt)) return { ok: false, error: 'bad pausedAt' };
    if (v.reduced !== undefined && typeof v.reduced !== 'boolean') return { ok: false, error: 'reduced must be true or false' };
    return { ok: true, value: { ...v } };
  }
  if (kind === 'list') {
    let items;
    if (Array.isArray(raw)) items = raw;
    else if (typeof raw === 'string') items = raw.split(',');
    else return { ok: false, error: 'expected a list' };
    // A Matrix server name: a DNS name, an IPv4 address or a bracketed IPv6 literal, optional port.
    // The federated sign-in lists hold these. An entry that is not one (a URL, an account id, a
    // trailing dot) would be stored and then match no account at all, so a deny entry would fail
    // open: it is refused here, and web's check-time normaliser is this same rule.
    const serverName = /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/;
    const out = [];
    for (const it of items) {
      if (typeof it !== 'string') return { ok: false, error: 'list items must be text' };
      let s = it.trim();
      // A list that names its values refuses anything else (player.embedsOff); one without takes any text.
      if (s && entry.values && !entry.values.includes(s)) return { ok: false, error: `not one of ${entry.values.join(', ')}` };
      if (s && entry.items === 'serverName') {
        s = s.toLowerCase();
        if (s.length > 255 || !serverName.test(s)) {
          return { ok: false, error: `${JSON.stringify(s.slice(0, 80))} is not a server name: write example.org (optionally :port), not a URL or an account id` };
        }
      }
      if (s && !out.includes(s)) out.push(s);
    }
    return { ok: true, value: out };
  }
  if (typeof raw !== 'string') return { ok: false, error: 'expected text' };
  const s = raw.trim();
  if (!s) return { ok: false, error: 'empty' };
  if (s.length > 4096) return { ok: false, error: 'too long' };
  if (kind === 'string' || kind === 'secret') {
    if (/[\r\n\0]/.test(s)) return { ok: false, error: 'must be one line' };
    if (typeof entry.maxLength === 'number' && s.length > entry.maxLength) return { ok: false, error: `at most ${entry.maxLength} characters` };
    return { ok: true, value: s };
  }
  if (kind === 'origin' || kind === 'wsOrigin') {
    let u;
    try { u = new URL(s); } catch { return { ok: false, error: 'not a URL' }; }
    const want = kind === 'origin' ? ['http:', 'https:'] : ['ws:', 'wss:'];
    if (!want.includes(u.protocol)) return { ok: false, error: `must start with ${want.map((p) => p + '//').join(' or ')}` };
    if ((u.pathname && u.pathname !== '/') || u.search || u.hash || u.username || u.password) {
      return { ok: false, error: 'an origin only — no path, query or credentials' };
    }
    return { ok: true, value: `${u.protocol}//${u.host}` };
  }
  if (kind === 'url') {
    // Kept AS TYPED (trimmed): an OAuth issuer is compared byte for byte with what the server
    // publishes, so normalising it here would manufacture a mismatch.
    let u;
    try { u = new URL(s); } catch { return { ok: false, error: 'not a URL' }; }
    if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, error: 'must start with http:// or https://' };
    if (u.search || u.hash || u.username || u.password) return { ok: false, error: 'no query, fragment or credentials' };
    return { ok: true, value: s };
  }
  if (kind === 'serverName') {
    const v = s.toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/.test(v)) {
      return { ok: false, error: 'expected a server name like example.org (optionally :port)' };
    }
    return { ok: true, value: v };
  }
  if (kind === 'localpartTemplate') {
    const parts = s.split('{{.}}');
    if (parts.length !== 2 || !(parts[0] + parts[1]) || !parts.every((p) => /^[a-z0-9._=/+-]*$/.test(p))) {
      return { ok: false, error: 'expected a Matrix localpart with exactly one {{.}}, e.g. discord_{{.}}' };
    }
    return { ok: true, value: s };
  }
  if (kind === 'matrixId') {
    if (!/^@[a-z0-9._=/+-]+:[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(s)) {
      return { ok: false, error: 'expected a Matrix id like @name:server' };
    }
    return { ok: true, value: s };
  }
  if (kind === 'enum') {
    if (!(entry.values || []).includes(s)) return { ok: false, error: `one of: ${(entry.values || []).join(', ')}` };
    return { ok: true, value: s };
  }
  return { ok: false, error: `unknown kind ${kind}` };
}

/**
 * The simple chat bot's behavior file (content key `bot.behavior`, JSON text). `text` null/empty = the shipped neutral default. Returns { ok: true, value } with
 * every part present and bounded, or { ok: false, error }. stream-api refuses a write that does
 * not parse; the bot and the AI page's meter read the same value.
 * Self-contained on purpose: the generator emits this function's own source text.
 */
export function parseBotBehavior(text) {
  const TAGS = ['schedule', 'rules', 'links', 'jokes', 'other'];
  const out = {
    persona: 'A friendly, brief helper in this stream\'s chat. Answers questions, keeps it light, never pretends to be a person.',
    avoid: [], facts: [], settings: { replyLength: 'short', swearing: 'avoid', emoji: 'allow' },
  };
  if (text === null || text === undefined || (typeof text === 'string' && !text.trim())) return { ok: true, value: out };
  if (typeof text !== 'string') return { ok: false, error: 'expected JSON text' };
  if (text.length > 32768) return { ok: false, error: 'at most 32,768 characters' };
  let v;
  try { v = JSON.parse(text); } catch { return { ok: false, error: 'not valid JSON' }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'expected an object' };
  const extra = Object.keys(v).filter((k) => !['persona', 'avoid', 'facts', 'settings'].includes(k));
  if (extra.length) return { ok: false, error: `unknown part: ${extra[0].slice(0, 40)}` };
  const line = (s) => typeof s === 'string' && !/[\0]/.test(s);
  if (v.persona !== undefined) {
    if (!line(v.persona) || v.persona.length > 2000) return { ok: false, error: 'persona: text, at most 2,000 characters' };
    if (v.persona.trim()) out.persona = v.persona.trim();
  }
  if (v.avoid !== undefined) {
    if (!Array.isArray(v.avoid) || v.avoid.length > 30) return { ok: false, error: 'avoid: at most 30 topics' };
    for (const a of v.avoid) {
      if (!line(a) || /[\r\n]/.test(a) || a.trim().length > 100) return { ok: false, error: 'avoid: each topic is one line, at most 100 characters' };
      if (a.trim()) out.avoid.push(a.trim());
    }
  }
  if (v.facts !== undefined) {
    if (!Array.isArray(v.facts) || v.facts.length > 60) return { ok: false, error: 'facts: at most 60' };
    for (const f of v.facts) {
      if (!f || typeof f !== 'object' || !line(f.text) || f.text.trim().length > 300) return { ok: false, error: 'facts: each is {text, tag}, text at most 300 characters' };
      const tag = f.tag === undefined ? 'other' : f.tag;
      if (!TAGS.includes(tag)) return { ok: false, error: `facts: tag must be one of ${TAGS.join(', ')}` };
      if (f.text.trim()) out.facts.push({ text: f.text.trim(), tag });
    }
  }
  if (v.settings !== undefined) {
    const st = v.settings;
    if (!st || typeof st !== 'object' || Array.isArray(st)) return { ok: false, error: 'settings: expected an object' };
    const pick = (k, allowed) => {
      if (st[k] === undefined) return true;
      if (!allowed.includes(st[k])) return false;
      out.settings[k] = st[k];
      return true;
    };
    if (!pick('replyLength', ['short', 'medium'])) return { ok: false, error: 'settings.replyLength: short or medium' };
    if (!pick('swearing', ['allow', 'avoid'])) return { ok: false, error: 'settings.swearing: allow or avoid' };
    if (!pick('emoji', ['allow', 'avoid'])) return { ok: false, error: 'settings.emoji: allow or avoid' };
  }
  return { ok: true, value: out };
}

/**
 * The behavior block of the bot's system prompt, capped AT RENDER: persona, then
 * "Do not discuss: …", then the facts as `- [tag] text` in the streamer's order, each added WHOLE
 * while the block stays within `cap` characters. A fact that does not fit is left out entirely —
 * never cut — and its index is returned, so the page can name it. `behavior` is a parsed value.
 * Self-contained on purpose: the generator emits this function's own source text.
 */
export function renderBotBehavior(behavior, cap = 6000) {
  const parts = [String(behavior.persona || '')];
  if (behavior.avoid && behavior.avoid.length) parts.push(`Do not discuss: ${behavior.avoid.join('; ')}.`);
  let block = parts.filter(Boolean).join('\n\n');
  if (block.length > cap) block = block.slice(0, cap);
  const omitted = [];
  let header = false;
  (behavior.facts || []).forEach((f, i) => {
    const add = `${header ? '' : '\n\nFacts:'}\n- [${f.tag}] ${f.text}`;
    if (block.length + add.length > cap) { omitted.push(i); return; }
    block += add;
    header = true;
  });
  return { block, used: block.length, cap, omitted };
}

/**
 * The ONE rule for whether a chat row may be shown to the public: not deleted. A mod-deleted
 * message and an account deletion's kept evidence are both `is_deleted` rows — moderators may
 * read them, nobody else. Every public read of site.chat_messages / stream.chat_log (history,
 * pins, quotes, boards, recall) uses this, so no path decides it on its own. `alias` is the
 * table alias in the caller's SQL (letters, digits, _).
 * Self-contained on purpose: the generator emits this function's own source text.
 */
export function messageVisibleSql(alias) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(alias))) throw new Error(`bad SQL alias ${alias}`);
  return `NOT ${alias}.is_deleted`;
}

/**
 * The backup target and its address, together: local takes NO address (the box
 * uses its own folder), s3 a bucket address, sftp an SFTP address — each checked by the
 * backupRepository kind above. Returns { ok: true, host } (host = the name or IP the box will
 * connect to; null for local) or { ok: false, error } in plain words. Used by the setup page, the
 * host's target reader and the check the box runs before every backup (one rule, three callers).
 * Self-contained except for parseInstanceValue, which the generator emits beside it.
 */
export function checkBackupTarget(target, repository) {
  const repo = typeof repository === 'string' ? repository.trim() : '';
  if (target === 'local' || target === null || target === undefined || target === '') {
    return repo ? { ok: false, error: 'a backup to this server takes no address (it goes to /opt/blackbranch/backups) — clear the backup address' } : { ok: true, host: null };
  }
  if (target !== 's3' && target !== 'sftp') return { ok: false, error: 'the backup target must be local, s3 or sftp' };
  if (!repo) return { ok: false, error: target === 's3' ? 'a bucket needs its address: s3:https://<host>/<bucket>' : 'an SFTP server needs its address: sftp:<user>@<host>:/<folder>' };
  const r = parseInstanceValue({ kind: 'backupRepository' }, repo);
  if (!r.ok) return { ok: false, error: r.error };
  if (!repo.startsWith(`${target}:`)) return { ok: false, error: `the backup target is ${target}, but the address is not an ${target} address` };
  const h = /^(?:s3:https:\/\/|sftp:(?:\/\/)?[^@]+@)([^/:]+)/i.exec(repo);
  return { ok: true, host: h ? h[1].toLowerCase() : null };
}

/**
 * Resolve one key: env > DB > default. Install-tier keys never read the DB.
 * `env` is a process.env-like object; `db` is { [key]: value } (plain values, or decrypted
 * secrets) or null. Returns { value, source, envName, error } where source is
 * 'env' | 'database' | 'default' | 'unset' and `error` names an env value that did not parse
 * (the caller decides whether that is fatal — at boot it is).
 * Self-contained except for parseInstanceValue, which the generator emits beside it.
 */
export function resolveInstanceValue(entry, env, db) {
  for (const name of entry.env) {
    const raw = env ? env[name] : undefined;
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const parsed = parseInstanceValue(entry, String(raw));
    if (!parsed.ok) return { value: null, source: 'env', envName: name, error: `${name}: ${parsed.error}` };
    return { value: parsed.value, source: 'env', envName: name, error: null };
  }
  if (entry.tier !== 'install' && db && Object.prototype.hasOwnProperty.call(db, entry.key)) {
    const parsed = parseInstanceValue(entry, db[entry.key]);
    if (parsed.ok) return { value: parsed.value, source: 'database', envName: null, error: null };
    return { value: null, source: 'database', envName: null, error: `stored value: ${parsed.error}` };
  }
  const d = entry.default;
  if (d !== null && d !== undefined) return { value: Array.isArray(d) ? [...d] : d, source: 'default', envName: null, error: null };
  return { value: null, source: 'unset', envName: null, error: null };
}

/**
 * One harmless, read-only provider call for a credential — the Credentials page's Test button.
 * `test` is an entry's `test` name; `get(key)` returns the CALLING process's resolved value for
 * a key; `fetchImpl` is fetch (injected so tests never touch the network).
 *
 * Returns a CHECK RESULT — `{ ok, code, status?, count?, mode?, missing? }` — or null for a test
 * this shared function does not run ('obs' and 'homeassistant' read state only stream-api has).
 * A result is a code from a FIXED set plus numbers and schema key names, never text from the
 * provider: an error body can echo what it was sent, so nothing a provider returns is ever
 * carried. `describeCheck` turns a result into the words the page shows, and
 * `normalizeCheckResult` is how a RECEIVER (stream-api, from another process's report) refuses
 * anything outside that shape.
 * Self-contained on purpose: the generator emits this function's own source text.
 */
export async function runProviderCheck(test, get, fetchImpl) {
  const timeout = () => AbortSignal.timeout(8000);
  const need = (...keys) => {
    const missing = keys.filter((k) => !get(k));
    return missing.length ? { ok: false, code: 'not_set', missing } : null;
  };
  // A refusal's BODY is read only to pick a fixed code, and nothing of it is kept. Two traps it
  // exists for: a SCOPED key that authenticates but lacks the one
  // permission an endpoint needs answers 401/403 like a bad key (ElevenLabs `missing_permissions`,
  // OpenAI restricted keys' "insufficient permissions", Stripe `rk_` keys' "required permissions")
  // — that is 'limited', not 'rejected'; and ElevenLabs answers a bad key with HTTP 400.
  const refusal = async (res) => {
    if (![400, 401, 403].includes(res.status)) return null;
    let j; try { j = await res.json(); } catch { return null; }
    const d = j && typeof j === 'object' && j.detail && typeof j.detail === 'object' ? j.detail : {};
    const msg = j && j.error && typeof j.error === 'object' && typeof j.error.message === 'string' ? j.error.message : '';
    if (d.status === 'missing_permissions' || /insufficient permissions|missing scopes|does not have the required permissions/i.test(msg)) return 'limited';
    if (typeof d.status === 'string' && d.status.startsWith('invalid_api_key')) return 'rejected';
    // Twitch answers an unknown client id with HTTP 400 {"message":"invalid client"}: a refused
    // credential, not a provider error.
    if (j && typeof j.message === 'string' && /^invalid client( secret)?$/i.test(j.message)) return 'rejected';
    return null;
  };
  const verdict = async (res, extra = {}) => {
    if (res.ok) return { ok: true, code: 'accepted', ...extra };
    const why = await refusal(res);
    if (why === 'limited') return { ok: true, code: 'limited', status: res.status };
    return { ok: false, code: why === 'rejected' || res.status === 401 || res.status === 403 ? 'rejected' : 'http_error', status: res.status };
  };
  const count = async (res, pick) => {
    try { const n = pick(await res.json()); return Number.isInteger(n) ? n : undefined; } catch { return undefined; }
  };
  const tokenFrom = async (res) => {
    try { const t = (await res.json()).access_token; return typeof t === 'string' && t ? t : null; } catch { return null; }
  };
  try {
    if (test === 'anthropic') {
      const miss = need('anthropic.apiKey'); if (miss) return miss;
      const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=20', {
        headers: { 'x-api-key': get('anthropic.apiKey'), 'anthropic-version': '2023-06-01' }, signal: timeout() });
      return verdict(res, res.ok ? { count: await count(res, (j) => j.data.length) } : {});
    }
    if (test === 'openai') {
      const miss = need('openai.apiKey'); if (miss) return miss;
      const res = await fetchImpl('https://api.openai.com/v1/models', {
        headers: { authorization: `Bearer ${get('openai.apiKey')}` }, signal: timeout() });
      return verdict(res, res.ok ? { count: await count(res, (j) => j.data.length) } : {});
    }
    if (test === 'elevenlabs') {
      const miss = need('elevenlabs.apiKey'); if (miss) return miss;
      // /v1/models, not /v1/user: a TTS-only scoped key reads models and voices but gets
      // 401 missing_permissions on /v1/user, which would call a working key rejected.
      const res = await fetchImpl('https://api.elevenlabs.io/v1/models', {
        headers: { 'xi-api-key': get('elevenlabs.apiKey') }, signal: timeout() });
      return verdict(res, res.ok ? { count: await count(res, (j) => j.length) } : {});
    }
    // The events the site's webhook routes handle. Stripe's list is web/app/lib/stripeWebhookEvents.ts
    // HANDLED_EVENTS and the Stripe setup page's paste line; PayPal's is its webhook route's switch.
    // web/app/lib/setup/providerChecks.test.ts holds the three Stripe copies and the two PayPal ones
    // equal (this function must stay self-contained, so it cannot import them).
    const STRIPE_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
      'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed',
      'payment_intent.payment_failed', 'refund.created', 'refund.updated', 'charge.dispute.created', 'charge.dispute.closed'];
    const PAYPAL_EVENTS = ['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED', 'CUSTOMER.DISPUTE.RESOLVED'];
    const json = async (res) => { try { return await res.json(); } catch { return null; } };
    // A provider's numeric id for a channel: digits only, or nothing (never text).
    const digits = (v) => (typeof v === 'number' || typeof v === 'string') && /^\d{1,20}$/.test(String(v)) ? String(v) : null;
    const origin = () => String(get('site.origin') || '').replace(/\/+$/, '');
    // The channel found under an app token; `want` = the id saved on this install (may be unset).
    const found = (id, want) => {
      if (!id) return { ok: false, code: 'not_found' };
      if (want && String(want) !== id) return { ok: false, code: 'mismatch', id };
      return { ok: true, code: 'accepted', id };
    };
    if (test === 'stripe') {
      // Read-only: the account, then one page of each object type the site reads. A restricted key
      // without one of those Read permissions answers 403 for that type alone — listed, never text.
      const miss = need('stripe.secretKey'); if (miss) return miss;
      const key = String(get('stripe.secretKey'));
      const mode = /^(sk|rk)_live_/.test(key) ? 'live' : 'test';
      const reads = [['account', '/v1/account'], ['customers', '/v1/customers?limit=1'], ['subscriptions', '/v1/subscriptions?limit=1'],
        ['invoices', '/v1/invoices?limit=1'], ['payment_intents', '/v1/payment_intents?limit=1'], ['checkout_sessions', '/v1/checkout/sessions?limit=1']];
      const denied = [];
      for (const [name, path] of reads) {
        const res = await fetchImpl(`https://api.stripe.com${path}`, { headers: { authorization: `Bearer ${key}` }, signal: timeout() });
        if (res.ok) continue;
        const why = await refusal(res);
        if (why === 'limited' || res.status === 403) { denied.push(name); continue; }
        return { ok: false, code: res.status === 401 || why === 'rejected' ? 'rejected' : 'http_error', status: res.status };
      }
      return denied.length ? { ok: false, code: 'denied', denied, mode } : { ok: true, code: 'accepted', mode };
    }
    if (test === 'stripe-webhook') {
      // The destination for THIS site's address exists, is enabled and sends every handled event.
      // The signing secret itself cannot be read back from Stripe: only its shape is checked here;
      // the first real delivery proves it (a bad one answers 400 and Stripe retries).
      const miss = need('stripe.secretKey', 'stripe.webhookSecret', 'site.origin'); if (miss) return miss;
      if (!/^whsec_[A-Za-z0-9]+$/.test(String(get('stripe.webhookSecret')))) return { ok: false, code: 'bad_format' };
      const res = await fetchImpl('https://api.stripe.com/v1/webhook_endpoints?limit=100', {
        headers: { authorization: `Bearer ${get('stripe.secretKey')}` }, signal: timeout() });
      if (!res.ok) return verdict(res);
      const want = `${origin()}/api/billing/webhook`;
      const list = (await json(res))?.data;
      const ep = Array.isArray(list) ? list.find((e) => e && typeof e.url === 'string' && e.url.replace(/\/+$/, '') === want) : null;
      if (!ep) return { ok: false, code: 'not_found' };
      if (ep.status !== 'enabled') return { ok: false, code: 'disabled' };
      const has = Array.isArray(ep.enabled_events) ? ep.enabled_events : [];
      const missing = has.includes('*') ? 0 : STRIPE_EVENTS.filter((x) => !has.includes(x)).length;
      return missing ? { ok: false, code: 'missing_events', count: missing } : { ok: true, code: 'accepted' };
    }
    if (test === 'paypal' || test === 'paypal-webhook') {
      const miss = need('paypal.clientId', 'paypal.clientSecret', 'paypal.env', ...(test === 'paypal-webhook' ? ['paypal.webhookId'] : []));
      if (miss) return miss;
      const mode = get('paypal.env') === 'live' ? 'live' : 'sandbox';
      const base = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
      const basic = btoa(`${get('paypal.clientId')}:${get('paypal.clientSecret')}`);
      const tok = await fetchImpl(`${base}/v1/oauth2/token`, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials', signal: timeout() });
      if (!tok.ok) return verdict(tok);
      if (test === 'paypal') return { ok: true, code: 'accepted', mode };
      const access = await tokenFrom(tok);
      if (!access) return { ok: false, code: 'no_token' };
      const res = await fetchImpl(`${base}/v1/notifications/webhooks/${encodeURIComponent(get('paypal.webhookId'))}`, {
        headers: { authorization: `Bearer ${access}` }, signal: timeout() });
      if (res.status === 404) return { ok: false, code: 'not_found', mode };
      if (!res.ok) return verdict(res, { mode });
      const hook = await json(res);
      if (get('site.origin')) {
        const url = hook && typeof hook.url === 'string' ? hook.url.replace(/\/+$/, '') : '';
        if (url !== `${origin()}/api/billing/paypal/webhook`) return { ok: false, code: 'wrong_target', mode };
      }
      const names = Array.isArray(hook?.event_types) ? hook.event_types.map((e) => e && e.name) : [];
      const missing = names.includes('*') ? 0 : PAYPAL_EVENTS.filter((x) => !names.includes(x)).length;
      return missing ? { ok: false, code: 'missing_events', count: missing, mode } : { ok: true, code: 'accepted', mode };
    }
    if (test === 'twitch') {
      const miss = need('twitch.clientId', 'twitch.clientSecret'); if (miss) return miss;
      const tok = await fetchImpl('https://id.twitch.tv/oauth2/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: get('twitch.clientId'), client_secret: get('twitch.clientSecret'), grant_type: 'client_credentials' }),
        signal: timeout() });
      if (!tok.ok) return verdict(tok);
      const access = await tokenFrom(tok);
      if (!access) return { ok: false, code: 'no_token' };
      const valid = await fetchImpl('https://id.twitch.tv/oauth2/validate', {
        headers: { authorization: `OAuth ${access}` }, signal: timeout() });
      // The channel is checked where this process knows it (the website does; stream-api does not).
      const channel = get('platform.twitch.channel');
      if (!valid.ok || !channel) return verdict(valid);
      const u = await fetchImpl(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(String(channel).toLowerCase())}`, {
        headers: { 'client-id': get('twitch.clientId'), authorization: `Bearer ${access}` }, signal: timeout() });
      if (!u.ok) return verdict(u);
      const d = (await json(u))?.data;
      return found(Array.isArray(d) && d[0] ? digits(d[0].id) : null, get('platform.twitch.broadcasterId'));
    }
    if (test === 'kick') {
      const miss = need('kick.clientId', 'kick.clientSecret'); if (miss) return miss;
      const tok = await fetchImpl('https://id.kick.com/oauth/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: get('kick.clientId'), client_secret: get('kick.clientSecret') }),
        signal: timeout() });
      const slug = get('platform.kick.slug');
      if (!tok.ok || !slug) return verdict(tok);
      const access = await tokenFrom(tok);
      if (!access) return { ok: false, code: 'no_token' };
      const c = await fetchImpl(`https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(String(slug).toLowerCase())}`, {
        headers: { authorization: `Bearer ${access}` }, signal: timeout() });
      if (!c.ok) return verdict(c);
      const d = (await json(c))?.data;
      return found(Array.isArray(d) && d[0] ? digits(d[0].broadcaster_user_id) : null, get('platform.kick.userId'));
    }
    if (test === 'youtube') {
      const miss = need('youtube.apiKey'); if (miss) return miss;
      const key = encodeURIComponent(get('youtube.apiKey'));
      const channel = get('platform.youtube.channelId');
      // channels.list with the saved id (1 quota unit) proves the key AND the channel; without an
      // id, i18nLanguages.list (1 unit) needs nothing but the key. Google answers a bad key with
      // HTTP 400 "API key not valid" — rejected, not a provider error.
      const badKey = async (res) => res.status === 400 && /api key not valid/i.test(String((await json(res))?.error?.message || ''));
      const res = await fetchImpl(channel
        ? `https://www.googleapis.com/youtube/v3/channels?part=id&id=${encodeURIComponent(String(channel))}&key=${key}`
        : `https://www.googleapis.com/youtube/v3/i18nLanguages?part=id&key=${key}`, { signal: timeout() });
      if (res.status === 400) return (await badKey(res)) ? { ok: false, code: 'rejected', status: 400 } : { ok: false, code: 'http_error', status: 400 };
      if (!channel || !res.ok) return verdict(res);
      const items = (await json(res))?.items;
      return Array.isArray(items) && items.length ? { ok: true, code: 'accepted' } : { ok: false, code: 'not_found' };
    }
    if (test === 'streamplace') {
      // The account resolves (did:plc at the PLC directory, did:web at its own host), and this site's
      // OAuth client description answers at its own address with its own address as the client id.
      const miss = need('platform.streamplace.did'); if (miss) return miss;
      const did = String(get('platform.streamplace.did'));
      let docUrl = null;
      if (/^did:plc:[a-z2-7]{24}$/.test(did)) docUrl = `https://plc.directory/${did}`;
      else if (/^did:web:[a-z0-9.-]{1,253}$/.test(did)) docUrl = `https://${did.slice('did:web:'.length)}/.well-known/did.json`;
      if (!docUrl) return { ok: false, code: 'bad_format' };
      const doc = await fetchImpl(docUrl, { signal: timeout() });
      if (doc.status === 404 || doc.status === 410) return { ok: false, code: 'not_found' };
      if (!doc.ok) return verdict(doc);
      if (!get('site.origin')) return { ok: true, code: 'accepted' };
      const meta = `${origin()}/oauth/client-metadata.json`;
      const m = await fetchImpl(meta, { signal: timeout() }).catch(() => null);
      const body = m && m.ok ? await json(m) : null;
      return body && body.client_id === meta ? { ok: true, code: 'accepted' } : { ok: false, code: 'metadata_bad' };
    }
  } catch (e) {
    return { ok: false, code: e && e.name === 'TimeoutError' ? 'timeout' : 'request_failed' };
  }
  return null;
}

/**
 * Validate a check result that arrived from ANOTHER process (or a local check) and keep only
 * the fixed shape: a known code, `ok` consistent with it, integer status/count, a known mode,
 * and missing names that are real schema keys. Anything else becomes `{ ok:false,
 * code:'unreadable' }` — so a buggy or forged report can never store text of its own.
 * Self-contained except for INSTANCE_KEYS, which the generator emits beside it.
 */
export function normalizeCheckResult(r) {
  const OK = ['accepted', 'connected', 'limited'];
  const BAD = ['rejected', 'http_error', 'not_set', 'timeout', 'request_failed', 'no_token', 'not_connected', 'unreachable', 'no_check', 'unanswered', 'unreadable',
    'not_found', 'mismatch', 'denied', 'disabled', 'missing_events', 'wrong_target', 'bad_format', 'metadata_bad'];
  const READS = ['account', 'customers', 'subscriptions', 'invoices', 'payment_intents', 'checkout_sessions'];
  if (!r || typeof r !== 'object' || ![...OK, ...BAD].includes(r.code)) return { ok: false, code: 'unreadable' };
  const out = { ok: OK.includes(r.code), code: r.code };
  if (Number.isInteger(r.status) && r.status >= 100 && r.status <= 599) out.status = r.status;
  if (Number.isInteger(r.count) && r.count >= 0 && r.count < 1e6) out.count = r.count;
  if (['live', 'test', 'sandbox'].includes(r.mode)) out.mode = r.mode;
  if (typeof r.id === 'string' && /^\d{1,20}$/.test(r.id)) out.id = r.id;
  if (Array.isArray(r.denied)) {
    const d = r.denied.filter((x) => READS.includes(x));
    if (d.length) out.denied = [...new Set(d)];
  }
  if (Array.isArray(r.missing)) {
    const known = new Set(INSTANCE_KEYS.map((e) => e.key));
    const m = r.missing.filter((k) => typeof k === 'string' && known.has(k)).slice(0, 8);
    if (m.length) out.missing = m;
  }
  return out;
}

/** The words the page shows for a normalized check result. Fixed templates only. */
export function describeCheck(r) {
  switch (r && r.code) {
    case 'accepted': return `accepted${r.mode ? ` (${r.mode})` : ''}${Number.isInteger(r.count) ? ` — ${r.count} listed` : ''}${r.id ? ` — channel found, id ${r.id}` : ''}`;
    case 'connected': return 'connected';
    case 'limited': return 'key works, but lacks a permission this check needs';
    case 'rejected': return `rejected (HTTP ${r.status ?? '?'})`;
    case 'http_error': return `provider answered HTTP ${r.status ?? '?'}`;
    case 'not_set': return `not set${r.missing ? `: ${r.missing.join(', ')}` : ''}`;
    case 'timeout': return 'timed out after 8 s';
    case 'request_failed': return 'request failed (network)';
    case 'no_token': return 'token response had no access token';
    case 'not_connected': return 'not connected (closed, unreachable, or the password was refused)';
    case 'unreachable': return 'unreachable';
    case 'no_check': return 'no check runs in this process for this credential';
    case 'unanswered': return 'the process did not answer in time';
    case 'not_found': return 'not found at the provider — check the name, id or address';
    case 'mismatch': return `found, but its id is ${r.id ?? '?'} — not the id saved here`;
    case 'denied': return `the key cannot read ${(r.denied || []).join(', ').replace(/_/g, ' ')} — give it those Read permissions`;
    case 'disabled': return 'the webhook exists but is disabled';
    case 'missing_events': return `the webhook does not send ${r.count ?? 'some'} of the events this site handles`;
    case 'wrong_target': return 'the webhook points at another address, not this site';
    case 'bad_format': return 'not in the provider\'s format';
    case 'metadata_bad': return 'the account was found, but this site\'s sign-in description did not answer as expected';
    default: return 'unreadable result';
  }
}
