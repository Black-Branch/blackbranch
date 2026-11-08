// The doctor: ONE list of checks, each read-only, each with a plain fix line. The Admin Panel's
// /admin/doctor page and `blackbranch doctor` both run evaluate() on the same two sets of facts,
// so they show the same list with the same verdicts and fix lines.
//
// Facts come from two places, because each side knows what the other cannot:
//   host  `blackbranch` on the box (memory, disk, clock, DNS, the tunnel or certificates, the
//         rendered config files, .env) — written to results/doctor-host.json, which the site reads.
//   site  the web app (the database, Matrix through its public names, the secrets it holds, the
//         module Tests run without recording a result).
// A fact set that is missing turns its checks grey with the reason, never red.
//
// Imports nothing and exports one name: tools/gen-instance-schema.mjs copies this file's TEXT
// into web (web/app/lib/doctor.generated.mjs), and the box runs the release's own copy with node
// inside the stream-api image (install/doctor.mjs). Facts hold no secret, no chat text and no
// viewer id; the report built from them is checked for every .env value before it is written.

/** @typedef {'ok'|'warn'|'fail'|'grey'} DoctorStatus */
/**
 * @typedef {object} DoctorRow
 * @property {string} id
 * @property {string} area
 * @property {string} title
 * @property {DoctorStatus} status
 * @property {string} detail
 * @property {string} fix
 */
/**
 * @typedef {object} DoctorInput
 * @property {any} host       host facts, or null
 * @property {'ok'|'none'|'missing'} hostState  none = not a bundle install; missing = a bundle not checked yet
 * @property {any} site       site facts, or null
 * @property {string|null} siteError  why the site's facts are missing (null when present)
 * @property {boolean} [setupRunning]  the update's run: setup has not finished (the doctor reads host.setup)
 */

export const DOCTOR = (() => {
  /** The release's database version: the newest migration it ships (install/doctor.test.mjs). */
  const SCHEMA_VERSION = 176;
  // Where a stuck operator gets help: the project's ONE copy of these addresses. install.sh's summary
  // reads the three lines below by their text (help_line), so each stays one quoted literal.
  const HELP_DOCS = 'https://blackbranch.app/docs/';
  const HELP_DISCORD = 'https://discord.gg/uFJbHMbaE';
  const HELP_REPORT = 'sudo blackbranch doctor --report';
  const HELP = Object.freeze({ docs: HELP_DOCS, discord: HELP_DISCORD, report: HELP_REPORT });
  /** The one help line: the install summary, the doctor's printout and the Admin Panel's Doctor. */
  const helpLine = () => `Need help? Guides: ${HELP_DOCS} · Ask: ${HELP_DISCORD} · Attach the report from ${HELP_REPORT}`;
  const MIN_MEMORY_MIB = 3600; // a "4 GB" server reports a little less than 4096 MiB
  const MIN_DISK_FREE_PCT = 15;
  const MIN_CERT_DAYS = 14;
  const MAX_BACKUP_AGE_H = 36;
  const MAX_VERIFY_AGE_D = 8; // weekly, with a day's slack
  const FEED_QUIET_H = 72; // a feed not read for 3 days is said out loud
  const INGEST_QUIET_MIN = 15; // stream-ingest reports to stream-api at least every 5 minutes
  const RUN_QUIET_MIN = 30; // the community reconciler's timer runs every 10 minutes
  const RUN_LIMIT_MIN = 20; // a run longer than its unit's limit crashed (web community/runLimit.ts RUN_LIMIT_MS)
  /** The checks an update can affect: the update's health check needs each of them not to fail
   *  (and the site's own facts to be there). Evaluated by the release being checked. */
  const UPDATE_CHECKS = ['door.answers', 'db.reachable', 'db.schema', 'db.vector', 'matrix.synapse', 'matrix.mas', 'matrix.issuer',
    'matrix.wellknown', 'matrix.rendered', 'matrix.federation', 'secrets.bootstrap', 'secrets.site', 'secrets.token', 'secrets.stored'];
  const TARGET_LABEL = { local: 'this server\'s backup folder', s3: 'the bucket', sftp: 'the SFTP server' };
  const AREAS = ['Box', 'Front door', 'Services', 'Database', 'Matrix', 'Secrets', 'Modules', 'Media', 'Payments', 'Platforms', 'Alerts', 'Backups', 'Updates'];
  const NAME_LABEL = { site: 'the site', api: 'api.', matrix: 'matrix.' };
  const PLATFORM_LABEL = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', streamplace: 'Streamplace' };
  /** The sign-in provider slots: [slot, its row's name, who answers its discovery]. */
  const SIGNIN_SLOTS = [['google', 'Google', 'Google'], ['discord', 'Discord', 'Discord'], ['twitch', 'Twitch', 'Twitch'], ['oidc', 'your OpenID server', 'your OpenID server']];
  const SETUP_WAITING = 'waiting for setup to finish';

  const ok = (detail = '') => ({ status: 'ok', detail });
  const fail = (detail, fix) => ({ status: 'fail', detail, ...(fix ? { fix } : {}) });
  const warn = (detail, fix) => ({ status: 'warn', detail, ...(fix ? { fix } : {}) });
  const grey = (detail) => ({ status: 'grey', detail });
  const list = (xs) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  const names = (xs) => list(xs.map((n) => NAME_LABEL[n] || n));
  const isBool = (v) => v === true || v === false;
  const hoursSince = (h, at) => { const n = Date.parse(h.at), t = Date.parse(at); return Number.isNaN(n) || Number.isNaN(t) ? null : Math.floor((n - t) / 3_600_000); };
  const minutesWords = (m) => m < 1 ? 'just now' : m < 120 ? `${m} min ago` : agoWords(Math.floor(m / 60));
  const agoWords = (hours) => hours < 1 ? 'less than an hour ago' : hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
  /** Whole minutes from `at` to the site's own time; null when either is unreadable. */
  const minutesSince = (s, at) => { const n = Date.parse(s.at), t = Date.parse(at); return Number.isNaN(n) || Number.isNaN(t) ? null : Math.max(0, Math.floor((n - t) / 60_000)); };
  const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);
  const things = (n) => `${n} ${n === 1 ? 'thing' : 'things'}`;
  /** A clock time the site formatted in its own time zone ("14:02", "14:02 UTC"), or '' when it is not one. */
  const clockWords = (c) => (typeof c === 'string' && /^\d{2}:\d{2}( UTC)?$/.test(c) ? c : '');
  // A payment provider's row: off = ok; on = its webhook Test. A key that lacks the permission to
  // read webhooks ('limited') is grey "check by hand", never red: the site cannot know.
  const providerRow = (p, name) => {
    if (!p) return grey('the site did not report');
    if (!p.on) return ok(`${name} is switched off`);
    if (!p.test) return grey('not checked');
    if (p.test.code === 'limited') return grey('the key may not read webhooks — check the webhook by hand in the provider\'s dashboard');
    if (p.test.ok === true) return ok(p.test.detail || 'passed');
    if (p.test.ok === false) return fail(p.test.detail || 'failed');
    return grey(p.test.detail || 'not checked');
  };

  // side: which facts a check needs. 'later' = an area this release does not check yet.
  // fixOutside: the fix line on an install that is not a bundle — its homeserver and services run
  // elsewhere, so a `blackbranch` command would not reach them.
  /** @type {{ id: string, area: string, title: string, side: 'host'|'site'|'both'|'later', fix: string, fixOutside?: string, judge?: (h: any, s: any, input: DoctorInput) => any }[]} */
  const CHECKS = [
    { id: 'box.memory', area: 'Box', side: 'host', title: 'Memory: at least 4 GB',
      fix: 'Move the install to a server with at least 4 GB of memory: the whole bundle runs in about half of that, and an update runs beside it.',
      judge: (h) => typeof h.memTotalMiB !== 'number' ? grey('could not read the memory size')
        : h.memTotalMiB >= MIN_MEMORY_MIB ? ok(`${h.memTotalMiB} MiB`) : fail(`${h.memTotalMiB} MiB`) },
    { id: 'box.disk', area: 'Box', side: 'host', title: `Disk: at least ${MIN_DISK_FREE_PCT} % free`,
      fix: 'Free some space: delete files you added, remove unused Docker images (sudo docker image prune), or grow the disk.',
      judge: (h) => {
        const d = Array.isArray(h.disk) ? h.disk.filter((x) => x && typeof x.freePct === 'number') : [];
        if (!d.length) return grey('could not read the disk');
        const worst = d.reduce((a, b) => (b.freePct < a.freePct ? b : a));
        const where = worst.what === 'docker' ? 'where Docker keeps its data' : 'where the install lives';
        return worst.freePct >= MIN_DISK_FREE_PCT ? ok(`${worst.freePct} % free ${where}`) : fail(`${worst.freePct} % free ${where}`);
      } },
    { id: 'box.clock', area: 'Box', side: 'host', title: 'Clock: in sync',
      fix: 'Turn on time sync: sudo timedatectl set-ntp true. Sign-in tokens depend on the clock.',
      judge: (h) => h.clockSynced === true ? ok('synchronised') : h.clockSynced === false ? fail('not synchronised') : grey('could not read the clock state') },
    { id: 'box.upgrades', area: 'Box', side: 'host', title: 'Security updates install themselves',
      fix: 'Turn unattended upgrades back on: sudo apt install unattended-upgrades, then sudo dpkg-reconfigure -plow unattended-upgrades.',
      judge: (h) => h.upgrades === true ? ok('unattended upgrades on') : h.upgrades === false ? fail('unattended upgrades off') : grey('could not read the setting') },

    { id: 'door.names', area: 'Front door', side: 'host', title: 'The three names resolve',
      fix: 'Point the domain, api. and matrix. at this install: in tunnel mode check the records on Cloudflare\'s DNS page; in direct mode add an A (or AAAA) record for each to this server.',
      judge: (h) => {
        if (h.mode === 'internal') return grey('lab mode: the names are not public');
        const n = Array.isArray(h.names) ? h.names : [];
        if (!n.length) return grey('not checked');
        const bad = n.filter((x) => !x.resolves).map((x) => x.name);
        return bad.length ? fail(`${names(bad)} ${bad.length === 1 ? 'does' : 'do'} not resolve`) : ok('all three resolve');
      } },
    { id: 'door.tls', area: 'Front door', side: 'host', title: 'Tunnel connected, or certificates valid',
      fix: 'Tunnel mode: sudo blackbranch logs cloudflared (a revoked or deleted tunnel needs the installer\'s tunnel step again). Direct mode: ports 80 and 443 must reach this server so certificates can renew; sudo blackbranch logs caddy shows why they did not.',
      judge: (h) => {
        if (h.mode === 'internal') return grey('lab mode: certificates come from the box\'s own authority');
        if (h.mode === 'tunnel') return h.tunnel === true ? ok('the tunnel is connected') : h.tunnel === false ? fail('the tunnel is not connected') : grey('could not read the tunnel');
        if (h.mode === 'direct') {
          const c = Array.isArray(h.certs) ? h.certs : [];
          if (!c.length) return grey('not checked');
          const bad = c.filter((x) => typeof x.daysLeft !== 'number' || x.daysLeft <= MIN_CERT_DAYS);
          const least = Math.min(...c.map((x) => (typeof x.daysLeft === 'number' ? x.daysLeft : -1)));
          return bad.length ? fail(`${names(bad.map((x) => x.name))}: ${bad.some((x) => typeof x.daysLeft !== 'number') ? 'no certificate read' : `${least} days left`}`)
            : ok(`${least} days left at the least`);
        }
        return grey('unknown front door mode');
      } },
    // Direct and lab mode ask the router at this box's own port 443, by each name (answersVia 'box'):
    // an update must not depend on the home router sending the box's own public address back in.
    // Tunnel mode asks by the public names, out to Cloudflare and back through the tunnel.
    { id: 'door.answers', area: 'Front door', side: 'host', title: 'The site, api. and matrix. answer by name',
      fix: 'sudo blackbranch status shows which service is down; sudo blackbranch logs caddy shows the router\'s errors.',
      judge: (h) => {
        const a = Array.isArray(h.answers) ? h.answers : [];
        if (!a.length) return grey('not checked');
        const how = h.answersVia === 'box' ? ' (asked at this box\'s own router)' : h.answersVia === 'public' ? ' (asked by the public names, through the tunnel)' : '';
        const bad = a.filter((x) => !(x.status >= 200 && x.status < 300));
        return bad.length ? fail(`${bad.map((x) => `${NAME_LABEL[x.name] || x.name} ${x.status ? `answered ${x.status}` : 'did not answer'}`).join('; ')}${how}`) : ok(`all three answer${how}`);
      } },
    // From outside: a warning at worst and never part of an update's verdict. A box behind a home
    // router often cannot reach its own public address from inside ("NAT loopback" / hairpin), so a
    // miss here is not proof the site is down — only a reason to look from outside.
    { id: 'door.outside', area: 'Front door', side: 'host', title: 'Reachable from outside by the public names',
      fix: 'Open the site on a phone with Wi-Fi off. If it opens, nothing is wrong: many home routers cannot reach their own public address from inside (no "NAT loopback"). If it does not: the A (or AAAA) records must point at this network\'s public address, and the router must forward ports 80 and 443 to this server.',
      judge: (h) => {
        if (h.mode === 'internal') return grey('lab mode: the names are not public');
        if (h.mode === 'tunnel') {
          const a = Array.isArray(h.answers) ? h.answers : [];
          if (!a.length) return grey('not checked');
          return a.every((x) => x.status >= 200 && x.status < 300) ? ok('the row above asked through the tunnel, from outside') : warn('the row above, asked through the tunnel, did not get every answer');
        }
        const o = Array.isArray(h.outside) ? h.outside : [];
        if (!o.length) return grey('not checked');
        const bad = o.filter((x) => !(x.status >= 200 && x.status < 300));
        if (!bad.length) return ok('all three answer by their public names');
        return warn(`${names(bad.map((x) => x.name))} did not answer this box by their public names — normal behind a home router without NAT loopback; check from outside`);
      } },

    // Services: whether the two background services run, and whether chat comes in. No message is
    // NOT a failure — a platform is quiet while nobody streams or chats there. Only a service that
    // does not run, or a connection a reader reports broken, is a problem.
    { id: 'services.api', area: 'Services', side: 'site', title: 'The chat service (stream-api) answers',
      fix: 'sudo blackbranch status; sudo blackbranch logs stream-api.',
      fixOutside: 'Restart the chat service (stream-api) where it runs and read its log.',
      judge: (h, s) => {
        const a = s.services && s.services.api;
        if (!a) return grey('the site did not report');
        if (!a.reachable) return fail('it does not answer the site');
        return a.loaded ? ok('answers, saved settings loaded') : warn('answers, but has not loaded the saved settings — it runs on its server settings and defaults');
      } },
    { id: 'services.ingest', area: 'Services', side: 'site', title: 'The ingest service (stream-ingest) runs',
      fix: 'sudo blackbranch status; sudo blackbranch logs stream-ingest.',
      fixOutside: 'Restart the ingest service (stream-ingest) where it runs and read its log.',
      judge: (h, s) => {
        const sv = s.services;
        if (!sv || !sv.api) return grey('the site did not report');
        if (!sv.api.reachable) return grey('could not be asked: the chat service does not answer');
        const m = sv.ingest ? sv.ingest.reportedMinutesAgo : null;
        if (typeof m !== 'number') return fail('it has not reported to the chat service since that one started');
        if (m > INGEST_QUIET_MIN) return fail(`it last reported ${minutesWords(m)}`);
        return sv.ingest.loaded === false ? warn(`reported ${minutesWords(m)}, but has not loaded the saved settings`) : ok(`reported ${minutesWords(m)}`);
      } },
    { id: 'services.platforms', area: 'Services', side: 'site', title: 'Platform chat: reader and last message',
      fix: 'Start the ingest service (the row above). A connection it reports broken: Admin Panel → Platforms → the platform\'s tab, check the channel, then read the ingest service\'s log.',
      judge: (h, s) => {
        const sv = s.services;
        if (!sv || !Array.isArray(sv.platforms)) return grey('the site did not report');
        const set = sv.platforms.filter((p) => p && p.set);
        if (!set.length) return ok('no platform is set up');
        const last = (p) => typeof p.lastMessageMinutes === 'number' ? `last message ${minutesWords(p.lastMessageMinutes)}` : 'no message in 30 days';
        if (!sv.api || !sv.api.reachable) return grey(`the readers could not be asked: the chat service does not answer — ${set.map((p) => `${p.label}: ${last(p)}`).join(' · ')}`);
        const ingestUp = !!(sv.ingest && typeof sv.ingest.reportedMinutesAgo === 'number' && sv.ingest.reportedMinutesAgo <= INGEST_QUIET_MIN);
        if (!ingestUp) return fail(`nothing reads ${list(set.map((p) => p.label))} chat while the ingest service is not running`);
        const broken = set.filter((p) => p.connected === false);
        if (broken.length) return fail(broken.map((p) => `${p.label}: connection broken; ${last(p)}`).join('; '));
        // connected: true/false when the ingest service reports its readers; null = not reported, and
        // then the reader is only known to belong to a running service.
        const conn = (p) => p.connected === true ? 'connected' : 'read by the running ingest service';
        return ok(`${set.map((p) => `${p.label}: ${conn(p)}; ${last(p)}`).join(' · ')} — no messages is normal while offline or quiet`);
      } },
    // stream-ingest's own report (GET :3010/health, asked by the host inside its container): a reader
    // that failed to start — YouTube's browser, Kick's lookup — is named with its one-line reason.
    // Not an update check: the readers depend on platforms outside the box.
    { id: 'ingest.readers', area: 'Services', side: 'host', title: 'Chat readers started',
      fix: 'The site\'s Stream tab (admins only) shows the reason; sudo blackbranch logs stream-ingest.',
      judge: (h) => {
        const g = h.ingest;
        if (!g || typeof g !== 'object') return grey('not checked');
        if (g.answered !== true) return grey('stream-ingest did not answer on its health port (not running, or older than this check)');
        const r = Object.entries(g.readers && typeof g.readers === 'object' ? g.readers : {}).filter(([, v]) => v && v.state !== 'off');
        if (!r.length) return ok('no platform is switched on');
        const label = (id) => PLATFORM_LABEL[id] || id;
        const failed = r.filter(([, v]) => v.state === 'failed' || v.state === 'unknown');
        if (failed.length) return fail(failed.map(([id, v]) => `${label(id)}: ${v.error || 'failed to start'}`).join('; '));
        const starting = r.filter(([, v]) => v.state === 'starting');
        if (starting.length && g.ok !== true) return warn(`${list(starting.map(([id]) => label(id)))} still starting after two minutes`);
        return ok(r.map(([id, v]) => `${label(id)}: ${v.state}`).join(' · '));
      } },
    // stream-ingest's per-platform live detection (its /health `liveness`, cut to fixed shapes by the
    // host): each configured platform's state, its evidence code (printed as-is: this file imports no
    // vocabulary) and `stale`, the vocabulary's ONE stale rule computed by stream-ingest. This row reads
    // the boolean and never repeats the window. A platform that can't tell holds an open stream open
    // (ADR 0134 E10), so a long silence is said here; amber at worst, never an update check.
    { id: 'ingest.liveness', area: 'Services', side: 'host', title: 'Live detection answers for every configured platform',
      fix: 'The site\'s Stream tab (admins only) shows each platform\'s live state and why it can\'t tell; sudo blackbranch logs stream-ingest.',
      judge: (h) => {
        const g = h.ingest;
        if (!g || typeof g !== 'object') return grey('not checked');
        if (g.answered !== true) return grey('stream-ingest did not answer on its health port (not running, or older than this check)');
        if (!g.liveness || typeof g.liveness !== 'object') return grey('stream-ingest did not report live detection (older than this check)');
        const set = Object.entries(g.liveness).filter(([, v]) => v && typeof v === 'object');
        if (!set.length) return ok('no platform is set up for live detection');
        const label = (id) => PLATFORM_LABEL[id] || id;
        const code = (v) => (typeof v.evidence === 'string' && v.evidence ? v.evidence : 'no code');
        const stale = set.filter(([, v]) => v.stale === true);
        if (stale.length) {
          const quiet = (v) => { const m = minutesSince(h, v.lastAnswerAt || v.since); return m === null ? '' : ` for ${m} min`; };
          const words = stale.map(([id, v]) => `${label(id)}: no answer${quiet(v)} (${code(v)})`).join('; ');
          // YouTube showing this server a consent or bot-check page: the Data API key lets the
          // check ask YouTube's API instead of reading the page.
          const page = stale.some(([id, v]) => id === 'youtube' && v.evidence === 'unrecognized-page');
          return warn(`${words}; an open stream stays open while it can't tell`, page
            ? 'YouTube shows this server a consent or bot-check page: set youtube.apiKey (Admin Panel → Platforms → YouTube, the YouTube Data API key) so live detection asks YouTube\'s API; sudo blackbranch logs stream-ingest.'
            : undefined);
        }
        const word = (v) => (v.state === 'live' ? 'live' : v.state === 'offline' ? 'offline' : v.state === 'upcoming' ? 'scheduled' : `can't tell (${code(v)})`);
        return ok(set.map(([id, v]) => `${label(id)}: ${word(v)}`).join(' · '));
      } },

    // The Discord bridge (Out Of Your Element, compose profile `discord`): off until a bot token is
    // set. Switched on: its settings file as rendered, then the bridge's own word for what it does
    // (install/ooye/entrypoint.js), then its container's health. OOYE answers only once Discord and
    // the homeserver let it in, and it keeps trying by itself, so this is never an update check.
    { id: 'discord.bridge', area: 'Services', side: 'host', title: 'Discord bridge',
      fix: 'Run sudo blackbranch logs ooye: it says what Discord or the homeserver answered. A refused token: set the bot token of this install\'s own Discord application again.',
      judge: (h) => {
        const d = h.discord;
        if (!d || typeof d !== 'object' || !isBool(d.profile) || !isBool(d.token)) return grey('not checked');
        if (!d.profile && !d.token) return grey('off: no Discord bot token is set');
        if (!d.profile) return warn('off: a Discord bot token is set, but the bridge is not switched on',
          'Add discord to COMPOSE_PROFILES in the install\'s .env (for example COMPOSE_PROFILES=tunnel,discord), then run sudo blackbranch up.');
        if (!d.token) return fail('switched on, but no Discord bot token is set',
          'Set DISCORD_BOT_TOKEN in the install\'s .env to the bot token of this install\'s own Discord application, then run sudo blackbranch up.');
        const up = 'Run sudo blackbranch up: it writes the bridge\'s settings file, and the bridge reads it by itself.';
        if (d.registration === 'missing' || d.answer === 'waiting-settings') return fail('switched on, but waiting for its settings file', up);
        if (d.registration === 'differs') return fail('switched on, but its settings file differs from a fresh render', up);
        if (d.answer === 'waiting-storage') return fail('switched on, but it cannot keep its database: its storage belongs to another user',
          'Run sudo blackbranch logs ooye: it names the owner of its storage (the bridge-data volume must belong to uid 1000).');
        if (d.state === 'healthy') return ok('on and running: Discord and the homeserver let it in');
        if (d.state === 'starting') return grey('on: starting');
        if (d.state === 'unhealthy') return fail('on, but it does not answer: Discord or the homeserver has not let it in yet (it keeps trying)');
        const st = typeof d.state === 'string' && /^[a-z]{1,20}$/.test(d.state) ? d.state : 'not running';
        return fail(`switched on, but its container is ${st === 'missing' ? 'not there' : st}`, 'Run sudo blackbranch up; if it stays red, sudo blackbranch logs ooye says why.');
      } },
    // The Discord bot (the bridge's own Discord application): whether Discord lets it in, its two
    // privileged switches the bridge needs, and whether it is in the Discord server the community was
    // imported from (Admin Panel → Site → Discord). Asked by the host through the bridge (the token
    // stays there); the facts carry no name or id.
    { id: 'discord.bot', area: 'Services', side: 'host', title: 'Discord bot sees the server',
      fix: 'Admin Panel → Site → Discord, Bot: paste the bot token again, or add the bot to the Discord server with the link there.',
      judge: (h) => {
        const d = h.discord, b = h.discordBot;
        if (d && typeof d === 'object' && (d.profile === false || d.token === false)) return grey('off: the Discord bridge is off');
        if (!b || typeof b !== 'object') return grey('not checked');
        if (b.checked !== true) return grey('not checked: the bridge is not running');
        if (b.ok !== true) {
          if (b.status === 401) return fail('Discord refused the bot token', 'Admin Panel → Site → Discord, Bot: reset the token in Discord\'s Developer Portal (your application, Bot) and paste the new one.');
          if (b.status === null) return warn('Discord did not answer the bot (it is asked again at the next check)');
          return fail(`Discord answered ${Number.isInteger(b.status) ? b.status : 'with an error'} for the bot`);
        }
        const off = [b.members === false ? 'Server Members' : '', b.content === false ? 'Message Content' : ''].filter(Boolean);
        if (off.length) return warn(`the bot's ${list(off)} switch is off on Discord: the bridge cannot see ${b.content === false ? 'what people write' : 'who is in the server'}`,
          'Discord\'s Developer Portal → your application → Bot: switch on Server Members Intent and Message Content Intent, then save.');
        if (b.guild === 'present') return ok('the bot sees the Discord server the community was imported from');
        if (b.guild === 'absent') return fail('the bot is not in the Discord server the community was imported from',
          'Add it again with the link on Admin Panel → Site → Discord (Bot), then press Check again there.');
        return grey('on: no Discord server imported yet (Admin Panel → Site → Discord, Import)');
      } },
    { id: 'db.reachable', area: 'Database', side: 'site', title: 'Postgres answers',
      fix: 'sudo blackbranch status; if postgres is not healthy, sudo blackbranch logs postgres.',
      judge: (h, s) => s.db && s.db.reachable ? ok() : fail('the site cannot reach its database') },
    { id: 'db.schema', area: 'Database', side: 'site', title: 'The database is at this release\'s version',
      fix: 'Apply the migrations: sudo blackbranch migrate (it also runs on every start).',
      judge: (h, s) => {
        if (!s.db || !s.db.reachable) return grey('database unreachable');
        const v = s.db.version;
        if (typeof v !== 'number') return fail('no schema_migrations version');
        if (v === SCHEMA_VERSION) return ok(`v${v}`);
        return v < SCHEMA_VERSION ? fail(`v${v}; this release expects v${SCHEMA_VERSION}`)
          : fail(`v${v} is newer than this release (v${SCHEMA_VERSION})`, 'The database was migrated by a newer release: run that release (sudo blackbranch update when it exists), never an older one against it.');
      } },
    { id: 'db.vector', area: 'Database', side: 'site', title: 'The vector extension is present',
      fix: 'sudo blackbranch migrate (a fresh database gets it from the baseline); if it is still missing, sudo blackbranch logs migrate.',
      judge: (h, s) => !s.db || !s.db.reachable ? grey('database unreachable') : s.db.vector ? ok(`vector ${s.db.vector}`) : fail('not installed') },

    // site.legacyId (SITE_LEGACY_ID, an install value read when the site starts): the site's own
    // platform id before the platform-key rename. Pages opened before it and returning visitors'
    // saved settings still carry that id; the install value is what translates them (nativePlatform.ts, legacyStorage.ts).
    // Needed only where the site had visitors before the rename: a database built by the migration
    // chain with accounts older than the rename's migration (v145).
    { id: 'site.legacyId', area: 'Database', side: 'site', title: 'An install from before the platform-key rename keeps its old id',
      fix: 'Set SITE_LEGACY_ID in the site\'s environment to its platform id from before the rename (one lower-case word), then restart the site: it is read when the site starts.',
      judge: (h, s) => {
        const p = s.platform;
        if (!p || !['unset', 'set', 'ignored'].includes(p.legacyId)) return grey('the site did not report');
        if (p.legacyId === 'ignored') return fail('set, but it is not one lower-case word other than "native", so the site ignores it');
        const baseline = s.db && isBool(s.db.baseline) ? s.db.baseline : null;
        if (p.legacyId === 'set') {
          if (baseline === true) return { ...warn('set on an install that started from the baseline: nothing was ever stored under an older id'),
            fix: 'Remove SITE_LEGACY_ID from the site\'s environment and restart the site: a fresh install has no older id to translate.' };
          return ok(baseline === false ? 'set, on a database built by the migration chain' : 'set');
        }
        if (baseline === true) return grey('not needed: a fresh install has no older platform id');
        if (p.olderAccounts === true) return warn('unset, but this database has accounts from before the platform-key rename: pages opened before it and saved browser settings no longer translate');
        if (p.olderAccounts === false) return grey('not needed: no account here is older than the platform-key rename');
        return grey('unset; could not read whether this database is older than the platform-key rename');
      } },

    { id: 'matrix.synapse', area: 'Matrix', side: 'site', title: 'Synapse answers (/versions)',
      fix: 'sudo blackbranch status; sudo blackbranch restart synapse; if it stays down, sudo blackbranch logs synapse.',
      fixOutside: 'The homeserver is managed outside Black Branch: restart it where it runs and read its log.',
      judge: (h, s) => s.matrix && s.matrix.versions === 200 ? ok() : fail(s.matrix && s.matrix.versions ? `answered ${s.matrix.versions}` : 'did not answer') },
    { id: 'matrix.mas', area: 'Matrix', side: 'site', title: 'MAS, the sign-in service, answers (/health)',
      fix: 'sudo blackbranch restart mas; if it stays down, sudo blackbranch logs mas.',
      fixOutside: 'The sign-in service is managed outside Black Branch: restart it where it runs and read its log.',
      judge: (h, s) => s.matrix && s.matrix.mas === 200 ? ok() : fail(s.matrix && s.matrix.mas ? `answered ${s.matrix.mas}` : 'did not answer') },
    { id: 'matrix.issuer', area: 'Matrix', side: 'site', title: 'The homeserver names this site\'s sign-in service',
      fix: 'sudo blackbranch render (Synapse\'s config is made from .env), then check again.',
      fixOutside: 'The homeserver is managed outside Black Branch: in its own config, name the sign-in service this site uses (the site\'s MATRIX_OAUTH_ISSUER), restart it, then check again.',
      judge: (h, s) => s.matrix && s.matrix.issuer === true ? ok('auth_metadata names the configured issuer')
        : s.matrix && s.matrix.issuer === false ? fail('auth_metadata names a different issuer') : grey('the homeserver did not answer') },
    { id: 'matrix.wellknown', area: 'Matrix', side: 'site', title: 'Both well-known files match the config',
      fix: 'sudo blackbranch up (the site makes the files from .env when it starts; up restarts it with the current .env).',
      fixOutside: 'The site makes the files from its environment when it starts: correct MATRIX_HOMESERVER_URL, MATRIX_OAUTH_ISSUER or MATRIX_FEDERATION_SERVER there and restart the site.',
      judge: (h, s) => {
        const m = s.matrix || {};
        const bad = [m.wellKnownClient === true ? null : 'client', m.wellKnownServer === true ? null : 'server'].filter(Boolean);
        return bad.length ? fail(`/.well-known/matrix/${bad.join(' and ')} ${bad.length > 1 ? 'differ' : 'differs'} or did not answer`) : ok();
      } },
    { id: 'matrix.rendered', area: 'Matrix', side: 'host', title: 'The rendered config files match a fresh render',
      fix: 'Run sudo blackbranch render. A hand edit is overwritten, so put lasting changes in .env.',
      judge: (h) => {
        const r = Array.isArray(h.rendered) ? h.rendered : [];
        if (h.renderError) return fail('the config does not render from .env', 'sudo blackbranch render prints what is wrong in .env.');
        if (!r.length) return grey('not checked');
        const bad = r.filter((x) => !x.match).map((x) => x.file);
        return bad.length ? fail(`${list(bad)} ${bad.length > 1 ? 'differ' : 'differs'} from the render`) : ok(`${r.length} files match`);
      } },
    { id: 'matrix.federation', area: 'Matrix', side: 'site', title: 'Federation matches its switch',
      fix: 'sudo blackbranch render applies the switch (sudo blackbranch federation shows it; the Admin Panel sets it).',
      fixOutside: 'The homeserver is managed outside Black Branch: federation is set in its own config, not by the switch here.',
      judge: (h, s, input) => {
        const f = (s.matrix && s.matrix.federation) || {};
        if (!isBool(f.reachable)) return grey('could not ask the federation address');
        // Not a bundle: the host never renders the switch, so there is nothing for it to match.
        if (input.hostState === 'none') return grey(`managed outside Black Branch — other servers ${f.reachable ? 'can' : 'cannot'} reach it`);
        const want = f.switch === true;
        return f.reachable === want ? ok(want ? 'on, and reachable' : 'off, and closed')
          : fail(want ? 'switched on, but other servers cannot reach it' : 'switched off, but other servers can reach it');
      } },
    // The Lockdown screen's "Not applied to the homeserver yet — retrying", here: the lockdown's last
    // write of matrix.registration is applied once the host answers a render ok at or after it
    // (web lockdownRegistration.ts renderApplied — the same reading).
    { id: 'matrix.lockdown', area: 'Matrix', side: 'site', title: 'Homeserver sign-up has the lockdown\'s last change',
      fix: 'sudo blackbranch render applies it now, and says what stops it (sudo blackbranch logs mas). Until then the homeserver\'s sign-up is not what the Lockdown screen chose; the site keeps asking for the render.',
      judge: (h, s, input) => {
        const l = s.matrix && s.matrix.lockdown;
        if (input.hostState === 'none' || (l && l.managed === 'outside')) return grey('managed outside Black Branch — the lockdown cannot reach that homeserver\'s sign-up');
        if (!l || typeof l !== 'object') return grey('not checked');
        const state = `sign-up ${l.registration === 'open' ? 'open' : 'closed'}${l.closedByLockdown ? ' by the lockdown' : ''}`;
        if (!l.lastWrite) return ok(`the lockdown has not changed it (${state})`);
        const r = l.render;
        if (r && r.ok && Date.parse(r.at) >= Date.parse(l.lastWrite)) return ok(`applied — ${state}`);
        const min = Math.floor((Date.parse(s.at) - Date.parse(l.lastWrite)) / 60_000);
        if (Number.isNaN(min)) return grey('not checked');
        if (min < 5) return grey(`changed ${min} min ago — the server is applying it`);
        const failed = r && !r.ok && Date.parse(r.at) >= Date.parse(l.lastWrite) ? ' (its last render failed)' : '';
        return fail(`the lockdown ${l.closedByLockdown ? 'closed' : 'changed'} homeserver sign-up ${min} min ago, but the server has not applied it${failed} — the site keeps retrying`);
      } },
    { id: 'matrix.namespace', area: 'Matrix', side: 'site', title: 'No legacy Matrix prefix on a fresh install',
      fix: 'Remove MATRIX_LEGACY_NAMESPACE from the site\'s environment and restart the site: a fresh install has no data under an older prefix.',
      judge: (h, s) => {
        const m = s.matrix || {};
        if (!m.legacyNamespace) return ok('unset');
        if (!s.db || !isBool(s.db.baseline)) return grey('set; could not read how the database started');
        return s.db.baseline ? fail('set on an install that started from the baseline') : ok('set, on a database built by the migration chain');
      } },
    // The install's own account that runs the community's rooms (an application service: its
    // registration file beside homeserver.yaml, and a token that must answer as that account).
    // "Delete my account" erases the Matrix account last; when the account server refused or was down
    // then, the site retries every hour (web matrixEraseRetry.ts). Counts and fixed codes only.
    { id: 'accounts.matrixErase', area: 'Matrix', side: 'site', title: 'Deleted accounts: their Matrix accounts are removed',
      fix: 'The site retries every hour. If it keeps failing, the site\'s sign-in client cannot deactivate accounts: give it the account server\'s admin grant (the bundle renders it; on another homeserver, list the client in MAS policy.data.admin_clients), or deactivate each account by hand at the account server; the site marks it done on its next retry.',
      judge: (h, s) => {
        const d = s.deletions;
        if (!d || !Number.isInteger(d.matrixPending)) return grey('the site could not count them');
        const n = d.matrixPending;
        if (n <= 0) return ok('no deleted account is waiting on its Matrix account');
        const codes = Array.isArray(d.codes) ? d.codes.filter((c) => typeof c === 'string' && /^[a-z0-9_]{1,40}$/.test(c)) : [];
        const why = codes.length ? ` (last answer${codes.length > 1 ? 's' : ''}: ${codes.join(', ')})` : '';
        return fail(`${n} deleted account${n === 1 ? ' still has' : 's still have'} an active Matrix account${why}; the site retries every hour`);
      } },
    // Optional mail (A2-05): with a mail server set, the sign-in service sends password recovery and
    // address checks through it. Judged by the last `blackbranch mail test` the host recorded.
    { id: 'mail.sends', area: 'Matrix', side: 'host', title: 'Mail: the sign-in service can send (password recovery, address checks)',
      fix: 'Check the mail server, port, connection, user name and password (Admin Panel → Site → Site, card Mail, or MAIL_SMTP_* in .env) with your mail provider, then run sudo blackbranch mail test <your address> again.',
      judge: (h) => {
        const m = h.mail;
        if (!m || (m.set !== true && m.set !== false)) return grey('not checked');
        if (!m.set) return grey('no mail server is set: no password recovery, and sign-up asks for no address');
        const t = m.test;
        if (!t || (t.ok !== true && t.ok !== false)) return grey('set, not tested yet: run sudo blackbranch mail test <your address>');
        const hrs = hoursSince(h, t.at);
        const when = hrs === null ? '' : ` (${agoWords(hrs)})`;
        const code = typeof t.code === 'string' && /^[a-z_]{1,40}$/.test(t.code) ? t.code : 'failed';
        return t.ok ? ok(`a test message was sent ${hrs === null ? 'earlier' : agoWords(hrs)}`) : fail(`the last test message was not sent: ${code}${when}`);
      } },
    // Sign-in providers (ADR 0154): one row per slot. On = the render offers it (complete), the sign-in
    // service's own table has it enabled (listed), and the provider's discovery document answers this
    // server, naming the address the sign-in service is given (MAS refuses one that does not).
    ...SIGNIN_SLOTS.map(([slot, name, who]) => (
      { id: `signin.${slot}`, area: 'Matrix', side: 'host', title: `Sign in with ${name}`,
        fix: `Check the ${name} settings (Admin Panel → Site → Site, card Sign-in providers), then run sudo blackbranch render.`,
        judge: (h) => {
          const s = h.signin;
          if (!s || s.read !== true) return grey(s && s.read === false ? 'the sign-in settings could not be read' : 'not checked');
          const p = s.slots && s.slots[slot];
          if (!p || p.on !== true) return grey('off');
          if (p.complete !== true) return fail('on, but its client id or secret is not set or not usable: nobody sees the button',
            `Fill in every ${name} field (Admin Panel → Site → Site, card Sign-in providers); sudo blackbranch render says which one it left out and why.`);
          if (p.listed === null || p.listed === undefined) return grey('on; whether the sign-in service offers it could not be checked (its database did not answer)');
          if (p.listed !== true) return fail('on, but the sign-in service does not offer it yet', 'Run sudo blackbranch render (it restarts the sign-in service); if it stays red, sudo blackbranch logs mas.');
          const d = p.discovery;
          if (!d || !Number.isInteger(d.status)) return grey(`on the sign-in page; whether ${who} answers could not be checked`);
          if (d.status === 0) return fail(`on the sign-in page, but ${who} does not answer this server`, `Check that this server can reach ${who} (its address, and this server's outgoing network).`);
          if (d.status !== 200) return fail(`on the sign-in page, but ${who} answered ${d.status}`, `Check the address of ${who}; it must serve /.well-known/openid-configuration.`);
          if (d.issuer !== true) return fail(`on the sign-in page, but ${who} names a different address for itself: sign-in through it fails`,
            'Copy the issuer address exactly as your OpenID server names it (its /.well-known/openid-configuration "issuer"), with or without the trailing /.');
          return ok(`on the sign-in page, and ${who} answers`);
        } })),
    { id: 'community.service', area: 'Matrix', side: 'host', title: 'The community service account answers',
      fix: 'Run sudo blackbranch up; if it stays red, sudo blackbranch community token-check',
      judge: (h) => {
        const c = h.community;
        if (!c || typeof c !== 'object') return grey('not checked');
        // A person already has the name (an upgraded install): nothing is registered over their id.
        if (c.nameTaken === true) {
          const name = typeof c.localpart === 'string' && /^[a-z0-9._=-]{1,64}$/.test(c.localpart) ? `@${c.localpart}` : 'it was given';
          return fail(`Someone already uses the name ${name} on this server, so the community has no account of its own`,
            'Set COMMUNITY_LOCALPART in the install\'s .env to a name nobody uses on this server, then run sudo blackbranch up.');
        }
        // Never checked (the database did not answer): nothing is registered until it does.
        if (c.nameChecked === false) {
          const name = typeof c.localpart === 'string' && /^[a-z0-9._=-]{1,64}$/.test(c.localpart) ? `@${c.localpart}` : 'it was given';
          return fail(`Could not check whether the name ${name} is free, so nothing is registered for it`,
            'Run sudo blackbranch up again once the database answers.');
        }
        if (c.registration === 'missing') return fail('the registration file is missing');
        if (c.registration === 'differs') return fail('the registration file differs from a fresh render');
        if (c.whoami === 'wrong') return fail('its token answers as another account');
        if (c.whoami === 'refused') return fail('the homeserver refused its token');
        if (c.registration !== 'match') return grey('the config does not render, so the registration was not compared');
        if (c.whoami === 'ok') return ok('registered, and its token answers as the account');
        if (c.whoami === 'unreachable') return grey('Synapse did not answer, so the account was not asked');
        return grey('Synapse is not running, so the account was not asked');
      } },
    // The rooms kept as the Community page sets them (spec 2026-10-23 §4.1): what the last finished
    // run found changed outside the page, and whether runs still happen. The site reads its run log
    // (site.community_runs) into fixed facts — counts and times, never a run's own error text.
    { id: 'community.drift', area: 'Matrix', side: 'site', title: 'The community\'s rooms are as the Community page sets them',
      fix: 'Run sudo blackbranch community reconcile --mode report and read its output',
      fixOutside: 'Run the community reconciler in report mode where it runs and read its output.',
      judge: (h, s) => {
        const c = s.community;
        if (!c || typeof c !== 'object') return grey('the site did not report');
        const r = c.lastFinished;
        if (!r || typeof r !== 'object') return grey(c.reconciler === true ? 'no run has finished yet' : 'switched off, and no run yet');
        const at = clockWords(r.clock);
        if (r.ok === false) return fail(`the last run${at ? `, at ${at},` : ''} failed`);
        // Notes that mean rooms were not looked after at all: amber, never a quiet green.
        const w = r.warns && typeof r.warns === 'object' ? r.warns : {};
        const last = at ? ` (last run at ${at})` : '';
        if (count(w.no_hub_access) > 0) return { ...warn(`the community's own account is not in the community's main space, so nothing is kept${last}`),
          fix: 'Invite the community account to the main space and give it full power there; the next run joins it.' };
        if (count(w.cannot_read) > 0) return { ...warn(`the community's own account cannot read ${count(w.cannot_read)} ${count(w.cannot_read) === 1 ? 'room' : 'rooms'}, so ${count(w.cannot_read) === 1 ? 'it is' : 'they are'} not kept${last}`),
          fix: 'Invite the community account to each room the Community page lists as unreadable and give it full power there.' };
        if (count(w.bridge_account_unlisted) > 0) return { ...warn(`${count(w.bridge_account_unlisted)} ${count(w.bridge_account_unlisted) === 1 ? 'room looks' : 'rooms look'} bridged by an account not listed as a bridge account${last}`),
          fix: 'Admin Panel → Site → Community lists them: add the account under Bridge accounts if that is right.' };
        if (count(w.bridge_accounts_unknown) > 0) return { ...warn(`in ${count(w.bridge_accounts_unknown)} bridged ${count(w.bridge_accounts_unknown) === 1 ? 'room' : 'rooms'} nobody is removed, because the bridge's own accounts are not known${last}`),
          fix: 'Admin Panel → Site → Community lists them.' };
        if (count(r.left) > 0) return { ...warn(`${things(r.left)} ${r.left === 1 ? 'differs' : 'differ'} from the Community page and ${r.left === 1 ? 'was' : 'were'} left as ${r.left === 1 ? 'it is' : 'they are'}${at ? ` (last run at ${at})` : ''}`),
          fix: 'Admin Panel → Site → Community lists them.' };
        if (count(r.putBack) > 0) return { ...warn(`${things(r.putBack)} ${r.putBack === 1 ? 'was' : 'were'} put back${at ? ` at ${at}` : ''}`),
          fix: 'Nothing to do: the Community page\'s settings were put back. Admin Panel → Site → Community shows what changed.' };
        return ok(`nothing to put back${at ? ` (last run at ${at})` : ''}`);
      } },
    { id: 'community.lastRun', area: 'Matrix', side: 'site', title: `The community's rooms were checked in the last ${RUN_QUIET_MIN} minutes`,
      fix: 'Run sudo blackbranch community on: it starts the 10-minute timer again and a run right away.',
      fixOutside: 'Start the community reconciler\'s timer where it runs.',
      judge: (h, s) => {
        const c = s.community;
        if (!c || typeof c !== 'object') return grey('the site did not report');
        const on = c.reconciler === true;
        const l = c.latest;
        if (!l || typeof l !== 'object') return on ? warn('no run yet') : grey('switched off, and no run yet');
        const at = clockWords(l.clock);
        if (!l.finishedAt) {
          // A run writes its row when it starts: one younger than the run limit is going, not stale.
          const m = minutesSince(s, l.startedAt);
          if (m !== null && m < RUN_LIMIT_MIN) return ok(`running${at ? ` since ${at}` : ''}`);
          return warn(`a run started${at ? ` at ${at}` : ''} and never finished`);
        }
        const m = minutesSince(s, l.finishedAt);
        if (m === null) return grey('the last run\'s time is not readable');
        if (!on) return grey(`switched off — the last run was ${minutesWords(m)}`);
        return m > RUN_QUIET_MIN ? warn(`the last run was ${minutesWords(m)}`) : ok(`the last run was ${minutesWords(m)}`);
      } },
    // The homeserver's retention block is rendered from the install's cap (render.sh, ADR 0139): the
    // Community page's "Forever" and its days are true only while the two agree. A homeserver the
    // bundle does not render keeps its own settings, which nothing here can change.
    { id: 'community.retention', area: 'Matrix', side: 'both', title: 'The server keeps messages as long as the cap says',
      fix: 'Run sudo blackbranch up',
      fixOutside: 'The homeserver is managed outside Black Branch: its own retention settings apply.',
      judge: (h, s, input) => {
        if (input.hostState === 'none') return grey('managed outside Black Branch — the server\'s own retention settings apply');
        if (input.hostState !== 'ok') return grey('not checked yet: run sudo blackbranch doctor');
        const r = h.retention;
        if (!r || typeof r !== 'object') return grey('not checked');
        if (r.rendered === false) return grey('this box does not render the server\'s config — the server\'s own retention settings apply');
        const cap = s.community && s.community.retentionCapDays;
        if (!Number.isInteger(cap) || cap < 0) return grey('the site did not report the cap');
        const want = cap > 0 ? cap : null;
        if (r.defaultDays === want && r.maxDays === want) return ok(cap > 0 ? `at most ${cap} days` : 'no limit: a channel keeps messages as long as it says, forever when it says nothing');
        // A block some cap renders (both N days, or neither): a cap edited since the last start.
        const capShape = r.defaultDays === r.maxDays && (r.defaultDays === null || (Number.isInteger(r.defaultDays) && r.defaultDays > 0));
        return fail(capShape ? 'the cap was changed; the server applies it at its next start' : 'the server\'s retention settings do not match the cap');
      } },

    { id: 'secrets.bootstrap', area: 'Secrets', side: 'host', title: 'Every bootstrap secret is present',
      fix: 'Restore .env (and matrix/mas-keys.yaml) from the backup: a lost secret cannot be made again without losing what it protects.',
      judge: (h) => {
        const sct = h.secrets || {};
        if (!Array.isArray(sct.missing)) return grey('not checked');
        const bad = [...sct.missing, ...(sct.masKeys === false ? ['MAS signing keys'] : []), ...(sct.signingKey === false ? ['the homeserver signing key'] : [])];
        return bad.length ? fail(`missing: ${list(bad)}`) : ok(`${sct.count} present`);
      } },
    { id: 'secrets.site', area: 'Secrets', side: 'site', title: 'The site holds its secrets',
      fix: 'The site was started without some of its secrets: compare .env with the backup, then sudo blackbranch up.',
      judge: (h, s) => {
        const m = s.secrets && Array.isArray(s.secrets.missing) ? s.secrets.missing : null;
        return !m ? grey('not checked') : m.length ? fail(`missing: ${list(m)}`) : ok();
      } },
    { id: 'secrets.token', area: 'Secrets', side: 'site', title: 'A stored token decrypts with TOKEN_ENC_KEY',
      fix: 'TOKEN_ENC_KEY is not the key the tokens were stored with: restore .env from a backup made with it.',
      judge: (h, s) => {
        const t = s.secrets && s.secrets.token;
        return t === 'ok' ? ok('one stored token decrypts') : t === 'none' ? grey('none stored yet') : t === 'fail' ? fail('a stored token does not decrypt') : grey('not checked');
      } },
    { id: 'secrets.stored', area: 'Secrets', side: 'site', title: 'Saved credentials decrypt',
      fix: 'INSTANCE_MASTER_KEY is not the key the saved credentials were written with: restore .env from a backup made with it, or save them again in the Admin Panel.',
      judge: (h, s) => {
        const st = s.secrets && s.secrets.stored;
        if (!st || typeof st.total !== 'number') return grey('the chat service did not report');
        if (!st.total) return grey('none saved yet');
        return st.unreadable ? fail(`${st.unreadable} of ${st.total} cannot be read`) : ok(`${st.total} readable`);
      } },

    { id: 'modules.tests', area: 'Modules', side: 'site', title: 'Each switched-on module\'s Test passes',
      fix: 'Admin Panel → the module\'s own page: correct the value and press Check.',
      judge: (h, s) => {
        // The module's own switch says whether it is set up: off = "not set up yet" (grey, never
        // red); on = its Test counts, so a module switched on without its keys fails.
        const all = Array.isArray(s.modules) ? s.modules : [];
        const mods = all.filter((m) => m.on);
        const off = all.filter((m) => m.on === false).map((m) => m.id);
        const notYet = off.length ? `not set up yet: ${list(off)} ${off.length > 1 ? 'are' : 'is'} switched off` : '';
        const tests = mods.flatMap((m) => (Array.isArray(m.tests) ? m.tests.map((t) => ({ ...t, module: m.id })) : []));
        if (!mods.length) return off.length ? grey(notYet) : ok('no module is switched on');
        const also = notYet ? `; ${notYet}` : '';
        if (!tests.length) return ok(`${list(mods.map((m) => m.id))} on; none has a Test${also}`);
        const bad = tests.filter((t) => t.ok === false);
        const unrun = tests.filter((t) => t.ok !== true && t.ok !== false);
        if (bad.length) return fail(bad.map((t) => `${t.module}: ${t.detail || 'failed'}`).join('; '));
        if (unrun.length) return grey(unrun.map((t) => `${t.module}: ${t.detail || 'not run'}`).join('; '));
        return ok(`${tests.length} passed${also}`);
      } },
    { id: 'modules.skipped', area: 'Modules', side: 'site', title: 'No setup step left skipped',
      fix: 'Admin Panel → the page named beside each step: set its values there, and it leaves this list.',
      judge: (h, s) => {
        const k = Array.isArray(s.skipped) ? s.skipped : [];
        return k.length ? warn(`skipped: ${list(k)}`) : ok('none');
      } },
    // Read-aloud (round 1 contract 2): stream-api's GET /tts/status, asked by the host inside its
    // container. Judged only while read-aloud is switched on.
    { id: 'tts.ready', area: 'Modules', side: 'host', title: 'Read-aloud has its key and a voice',
      fix: 'Admin Panel → Utility → TTS: set the ElevenLabs key and a voice id.',
      judge: (h) => {
        const t = h.tts;
        if (!t || typeof t !== 'object') return grey('not checked');
        if (t.answered !== true) return grey('the chat service did not answer (not running, or older than this check)');
        if (t.enabled !== true) return grey('skipped: read-aloud is switched off');
        const missing = [t.keySet === true ? null : 'the ElevenLabs key', t.voiceSet === true ? null : 'a voice id'].filter(Boolean);
        return missing.length ? fail(`switched on, but ${list(missing)} ${missing.length > 1 ? 'are' : 'is'} not set — nothing is read aloud`) : ok('switched on; key and voice set');
      } },

    // A "media library" is what a module flagged `servesMedia` serves — files the operator
    // fills (songs, videos). The rig page's clips are not one: made by stream-api, at most minutes
    // old, held in memory, a few hundred KB (stream-api/rig.js).
    { id: 'media.tunnel', area: 'Media', side: 'both', title: 'No audio or video library through the tunnel',
      fix: 'Switch off the module that serves a media library, or run in direct mode. A library through Cloudflare breaks its terms: a product module takes an object store (signed links) for it; an owner module\'s library moves to one as the owner\'s own work.',
      judge: (h, s, input) => {
        const mods = (Array.isArray(s.modules) ? s.modules : []).filter((m) => m.on && m.servesMedia);
        if (!mods.length) return ok('no module that serves a media library is on');
        const all = list(mods.map((m) => m.id));
        let via;
        if (input.hostState === 'ok') via = h.mode === 'tunnel' ? 'the tunnel' : null;
        else if (s.door && s.door.apiCloudflare === true) via = 'Cloudflare (api. answers with its header)';
        else if (s.door && s.door.apiCloudflare === false) via = null;
        else return grey(`${all} serves a media library; the front door is unknown (${input.hostState === 'none' ? 'not a bundle install, and api. did not answer' : 'host not checked yet'})`);
        if (!via) return ok(`${all} serves a media library, not through Cloudflare`);
        const product = mods.filter((m) => !m.owner).map((m) => m.id);
        if (product.length) return fail(`${list(product)} serves a media library through ${via}, with no object store`);
        return warn(`${all} — the owner's own module — serves its library through ${via}; its move to an object store is the owner's own work`);
      } },

    { id: 'modules.failsafe', area: 'Modules', side: 'site', title: 'No switch is held on by the upgrade fail-safe',
      fix: 'Apply the pending database migrations (`sudo blackbranch migrate` on a bundle install), then reload this page. Until then the site keeps them on, as they were before they had switches.',
      judge: (h, s) => {
        const k = Array.isArray(s.heldOn) ? s.heldOn : null;
        if (!k) return grey('the site did not report');
        return k.length ? warn(`held on with no saved switch: ${list(k.map((x) => String(x).replace(/^modules\./, '')))}`) : ok('none');
      } },

    // Payments + Platforms: the setup pages' own Tests, run without recording.
    { id: 'payments.stripe', area: 'Payments', side: 'site', title: 'Stripe: this site\'s webhook exists, is enabled and sends every event, and the customer portal is saved',
      fix: 'Admin Panel → Payments → Connections, card Stripe: follow "The webhook" step (the address and the event list) and "The customer portal" step (Stripe → Settings → Billing → Customer portal → Save), then press Check.',
      judge: (h, s) => providerRow(s.payments && s.payments.stripe, 'Stripe') },
    { id: 'payments.cloudflare', area: 'Payments', side: 'site', title: 'Stripe gets past Cloudflare\'s bot protection',
      fix: 'Free plan: Bot Fight Mode blocks Stripe, and no rule can make an exception to it, so turn Bot Fight Mode off (Cloudflare → your domain → Security → Settings → Bot traffic). Pro plan or higher: use Super Bot Fight Mode with a custom rule that skips it for the URI path /api/billing/webhook.',
      judge: (h, s) => {
        const st = s.payments && s.payments.stripe;
        if (!st) return grey('the site did not report');
        if (!st.on) return ok('Stripe is switched off');
        return grey('cannot be checked without a Cloudflare token, so check by hand: Bot Fight Mode off on a Free plan, or a Super Bot Fight Mode skip rule for /api/billing/webhook on a paid plan');
      } },
    { id: 'payments.paypal', area: 'Payments', side: 'site', title: 'PayPal: the webhook id exists and points at this site',
      fix: 'Admin Panel → Payments → Connections, card PayPal: follow "The webhook" step, paste the webhook id PayPal shows, then press Check.',
      judge: (h, s) => providerRow(s.payments && s.payments.paypal, 'PayPal') },
    // A partial refund of a community gift ends the unclaimed slots and gifts it pays for; money that
    // covers no whole slot ends nothing (web giftServer.ts endGift) and is shown here.
    { id: 'payments.giftRefunds', area: 'Payments', side: 'site', title: 'Every gift refund covered whole gifts',
      fix: 'A partial refund of a community gift ended the unclaimed slots and gifts it covered; the rest of it covered only part of a slot, so no gift was ended for that part. Decide by hand: refund the rest in Stripe (the site then ends one more), or leave it.',
      judge: (h, s) => {
        const g = s.payments && s.payments.giftRefunds;
        if (!g || !Number.isInteger(g.partial)) return grey('the site did not report');
        return g.partial > 0
          ? warn(`${g.partial} partial refund${g.partial === 1 ? '' : 's'} of a community gift in the last 90 days covered part of a slot`)
          : ok('none in the last 90 days');
      } },
    // A platform whose channel is set but that has nothing to test (no app keys) is "not checked",
    // never a pass: the row says what was actually accepted.
    { id: 'platforms.credentials', area: 'Platforms', side: 'site', title: 'Platform keys accepted',
      fix: 'Admin Panel → Platforms → the platform\'s tab: correct the channel or the app\'s keys, then press Check.',
      judge: (h, s) => {
        const p = Array.isArray(s.platforms) ? s.platforms : null;
        if (!p) return grey('the site did not report');
        const used = p.filter((x) => x && x.set);
        if (!used.length) return ok('no platform is set up');
        const untested = used.filter((x) => x.tested === false);
        const tested = used.filter((x) => x.tested !== false);
        const notChecked = untested.length ? `not checked — ${list(untested.map((x) => x.label))}: channel set; nothing to test` : '';
        const bad = tested.filter((x) => x.ok === false);
        if (bad.length) return fail(bad.map((x) => `${x.label}: ${x.detail || 'failed'}`).join('; '));
        const unrun = tested.filter((x) => x.ok !== true);
        const okd = tested.filter((x) => x.ok === true).map((x) => x.label);
        if (unrun.length) return grey([unrun.map((x) => `${x.label}: ${x.detail || 'not checked'}`).join('; '), okd.length ? `${list(okd)} accepted` : '', notChecked].filter(Boolean).join('; '));
        if (!okd.length) return grey(notChecked);
        return ok([`${list(okd)} accepted`, notChecked].filter(Boolean).join('; '));
      } },

    // Alerts: the push to whoever runs the site (stream-api/notify.js) is optional. Without a topic
    // nothing is lost — the problems stay on this page — but nobody is told while away from it. The
    // host's own alerts (install/blackbranch alert) use the same topic when .env names none.
    { id: 'alerts.channel', area: 'Alerts', side: 'site', title: 'Alerts reach someone',
      fix: 'Optional: Admin Panel → Site → Site, card Alerts to your phone: paste an ntfy topic address (one is enough) and subscribe to that topic in the ntfy app. The server\'s own alerts (a failed backup or update, low disk) go to it too.',
      judge: (h, s) => {
        const a = s.alerts;
        if (!a || typeof a.topics !== 'number') return grey('the chat service did not report');
        if (a.topics === 0) return warn('Alerts reach nobody: no alert topic is set. Important problems stay visible here in the Admin Panel; a failed backup or update is seen only here (unless the server\'s .env names a channel of its own).');
        return ok(a.topics === 1 ? 'one topic: urgent and quiet alerts both go to it, the server\'s own (a failed backup or update, low disk) too'
          : 'urgent and quiet alerts each have a topic; the server\'s own (a failed backup or update, low disk) go to them too');
      } },
    { id: 'backups.age', area: 'Backups', side: 'host', title: `The last good backup is less than ${MAX_BACKUP_AGE_H} hours old`,
      fix: 'Run sudo blackbranch backup and read why it stops; sudo blackbranch status shows the last run. The nightly one runs at the quiet hour (Admin Panel → Site → Site, card Running the site).',
      judge: (h) => {
        const b = h.backups;
        if (!b) return grey('not checked yet: run sudo blackbranch doctor');
        const last = b.last;
        if (!last) return fail('no backup has been made yet');
        const now = Date.parse(h.at);
        const good = typeof last.lastOkAt === 'string' ? Date.parse(last.lastOkAt) : NaN;
        if (Number.isNaN(good)) return fail(last.ok === false ? 'every backup so far has failed' : 'no backup has been made yet');
        const hours = Number.isNaN(now) ? null : Math.floor((now - good) / 3_600_000);
        if (hours === null) return grey('could not read the time');
        if (hours >= MAX_BACKUP_AGE_H) return fail(`the last good backup is ${hours} hours old`);
        const age = hours < 1 ? 'less than an hour old' : `${hours} h old`;
        return last.ok === false ? warn(`the last run failed; the one before it is ${age}`) : ok(age);
      } },
    { id: 'backups.verify', area: 'Backups', side: 'host', title: 'The newest backup restores (checked weekly)',
      fix: 'sudo blackbranch restore latest --verify says which part failed. A damaged backup cannot be mended: make a new one (sudo blackbranch backup) and check it again.',
      judge: (h) => {
        const b = h.backups;
        if (!b) return grey('not checked yet: run sudo blackbranch doctor');
        const v = b.verify;
        if (!v) return fail('never checked: sudo blackbranch restore latest --verify');
        if (v.ok !== true) return fail(`the last check failed${Array.isArray(v.failed) && v.failed.length ? ` (${list(v.failed)})` : ''}`);
        const days = Math.floor((Date.parse(h.at) - Date.parse(v.at)) / 86_400_000);
        if (Number.isNaN(days)) return ok('passed');
        return days > MAX_VERIFY_AGE_D ? warn(`passed ${days} days ago; the weekly check has not run since`) : ok(`passed ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}`);
      } },
    { id: 'backups.target', area: 'Backups', side: 'host', title: 'The backup target answers',
      fix: 'Admin Panel → Site → Site, card Backups: check the address and keys, and that this server can reach it. For SFTP, the key sudo blackbranch backup key prints must be on that account.',
      judge: (h) => {
        const t = (h.backups && h.backups.target) || {};
        const where = TARGET_LABEL[t.kind] || 'the target';
        if (t.repo === 'ok') return ok(where);
        if (t.repo === 'missing') return fail(`${where} answers, but holds no backups yet`);
        if (t.repo === 'password') return fail(`${where} answers, but the backup passphrase does not open it`);
        if (t.repo === 'unreachable') return fail(`${where} does not answer`);
        if (t.repo === 'refused') return fail('the backup address is refused (only s3:https:// and sftp: addresses, never loopback, link-local or this server\'s own network) — sudo blackbranch backup says why');
        return grey('could not ask (no backup image yet, or the settings could not be read)');
      } },
    { id: 'updates.feed', area: 'Updates', side: 'host', title: 'The update feed was read in the last 3 days',
      fix: 'sudo blackbranch update --check says why: the box must reach its feed over the internet (BB_UPDATE_FEED in .env), and the feed must carry a signature from the key this box was installed with.',
      judge: (h) => {
        const c = h.updates && h.updates.check;
        if (!h.updates) return grey('not checked yet: run sudo blackbranch doctor');
        if (!c) return fail('the feed has never been read');
        const err = c.error ? ` (${c.error})` : '';
        const hours = typeof c.readAt === 'string' ? hoursSince(h, c.readAt) : null;
        if (hours === null) return fail(`the feed has never been read${err}`);
        if (hours >= FEED_QUIET_H) return fail(`not read for ${Math.floor(hours / 24)} days${err}`);
        const a = c.available;
        const what = c.refused ? `; ${a && a.version} is published but cannot be applied here: ${c.refused}`
          : a ? `; ${a.version} is available${a.security ? ' — a security release: it applies itself at the quiet hour, never while the stream is live' : ' — a feature release: Admin Panel → Updates'}`
            : '; up to date';
        if (c.ok === false) return warn(`the last read failed${err}; the one before was ${agoWords(hours)}${what}`);
        if (c.plainHttp === true) return warn(`read ${agoWords(hours)} over plain http — a network in between could hold a release back until the feed expires (set BB_UPDATE_FEED to an https address)${what}`);
        return ok(`read ${agoWords(hours)} — ${c.channel} channel, release ${c.current}${what}`);
      } },
    { id: 'updates.last', area: 'Updates', side: 'host', title: 'The last update finished',
      fix: 'sudo blackbranch status shows the release in use and what the last update said. Nothing is lost by a rollback: the box runs the release before with its data from just before the update. Send sudo blackbranch doctor --report to the project; the next release is offered as usual.',
      judge: (h) => {
        const u = h.updates;
        if (!u) return grey('not checked yet: run sudo blackbranch doctor');
        const st = u.state, l = u.last;
        if (st && st.state === 'running') return grey(`an update to ${st.to} is running — step ${st.step} of ${st.steps}: ${st.words}`);
        if (st && st.state === 'waiting') return grey(st.words || 'waiting');
        if (!l) return ok('no update has run on this box yet');
        const when = typeof l.at === 'string' ? l.at.slice(0, 10) : '';
        if (l.result === 'updated') return ok(`${l.from} → ${l.to} (${when})`);
        if (l.result === 'rolled-back') {
          // Only a chat reader failed (blackbranch readers_check): the timer tries it again, 3 nights in all.
          const n = typeof l.attempts === 'number' ? l.attempts : 1;
          const again = l.reason !== 'reader-regression' ? ''
            : n >= 3 ? ` — parked after ${n} attempts, each failed only by a chat reader: the timer does not try it again (apply it by hand to retry)`
              : ` — only a chat reader failed: the timer tries it again tonight (attempt ${n} of 3 done)`;
          return warn(`${l.to} ${l.message ? l.message.replace(/;.*$/, '') : 'failed'} (${when}); the box went back to ${l.from} and its data from just before, and passed its health check again${again}`);
        }
        if (l.result === 'not-applied') return warn(`${l.to} was not applied (${when}): ${l.message}`);
        if (l.result === 'rollback-failed') return fail(`${l.to} failed, and going back did not finish cleanly (${when}): ${l.message}`,
          'Run sudo blackbranch status and sudo blackbranch doctor; the backup made before the update brings the data back: sudo blackbranch restore <snapshot> --yes (sudo blackbranch backup list).');
        if (l.result === 'interrupted') return fail(`an update stopped without finishing (${when}): ${l.message}`,
          'Run sudo blackbranch status. If the site does not answer, bring back the backup made before the update: sudo blackbranch restore <snapshot> --yes (sudo blackbranch backup list), then sudo blackbranch up.');
        return grey('the last result is not readable');
      } },
  ];

  /** @param {DoctorInput} input @returns {DoctorRow[]} */
  function evaluate(input) {
    const h = input.host || {};
    const s = input.site || {};
    const hostGrey = input.hostState === 'none' ? 'not a bundle install' : 'not checked yet: run sudo blackbranch doctor';
    // Until setup finishes the site answers every API 503 ("this site is being set up"): that is the
    // site waiting, not a site that does not answer (I01). Any other error, or a 503 after setup, is.
    const setupWaits = input.setupRunning === true || (input.hostState === 'ok' && !!h.setup && h.setup.completed === false);
    const siteGrey = setupWaits && /\b503\b/.test(input.siteError || '') ? SETUP_WAITING
      : input.siteError ? `site unreachable (${input.siteError})` : 'site unreachable';
    return CHECKS.map((c) => {
      let v;
      if (c.side === 'later') v = grey('not checked in this release');
      else if ((c.side === 'host') && input.hostState !== 'ok') v = grey(hostGrey);
      else if ((c.side === 'site' || c.side === 'both') && !input.site) v = grey(siteGrey);
      else {
        try { v = c.judge ? c.judge(h, s, input) : grey('no check'); } catch { v = grey('could not judge these facts'); }
      }
      return { id: c.id, area: c.area, title: c.title, status: v.status, detail: v.detail || '', fix: v.fix || (input.hostState === 'none' && c.fixOutside) || c.fix };
    });
  }

  const MARK = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', grey: ' -  ' };
  /** The header's groups, in order, each with what it asks of the reader (W18b: four counts on one
   *  line read as one number). The page shows the same words. */
  const GROUPS = [
    { status: 'fail', words: 'failing', meaning: 'something does not work — fix these first; each says how' },
    { status: 'warn', words: 'to look at', meaning: 'works, but worth a look' },
    { status: 'ok', words: 'ok', meaning: '' },
    { status: 'grey', words: 'not checked', meaning: 'switched off, or a fact was missing — each row says which' },
  ];
  /** @param {DoctorRow[]} rows — while setup waits, the "not checked" group says so once. */
  function summary(rows) {
    const waits = rows.some((x) => x.detail === SETUP_WAITING);
    return GROUPS.map((g) => ({ ...g, ...(waits && g.status === 'grey' ? { meaning: `${g.meaning}; the site is ${SETUP_WAITING}` } : {}),
      n: rows.filter((x) => x.status === g.status).length }));
  }

  /** The command's printout: the groups' counts, then every check by area; a failing or warning
   *  check's fix below it. */
  function text(rows) {
    const out = [];
    const groups = summary(rows);
    const width = Math.max(...groups.map((g) => String(g.n).length));
    for (const g of groups) out.push(`${String(g.n).padStart(width)} ${g.words.padEnd(11)}${g.n && g.meaning ? ` ${g.meaning}` : ''}`.trimEnd());
    out.push('');
    for (const area of AREAS) {
      const r = rows.filter((x) => x.area === area);
      if (!r.length) continue;
      out.push(area);
      for (const x of r) {
        out.push(`  [${MARK[x.status]}] ${x.title}${x.detail ? ` — ${x.detail}` : ''}`);
        if ((x.status === 'fail' || x.status === 'warn') && x.fix) out.push(`         fix: ${x.fix}`);
      }
    }
    const n = (st) => rows.filter((x) => x.status === st).length;
    out.push('', `${n('fail')} failing · ${n('warn')} to look at · ${n('ok')} ok · ${n('grey')} not checked`, '', helpLine());
    return out.join('\n');
  }

  /** --report: what a helper needs and nothing else — no secret, no chat text, no viewer id, no domain. */
  function report({ rows, release, modules, at }) {
    const out = [
      'Black Branch doctor report',
      `made     ${at}`,
      `release  ${release || 'unknown'}`,
      `modules  ${Array.isArray(modules) ? (modules.map((m) => `${m.id}=${m.on ? 'on' : 'off'}`).join(' ') || 'none') : 'unknown (site unreachable)'}`,
      '',
      ...rows.map((x) => `${x.status.padEnd(4)}  ${x.id.padEnd(18)}  ${x.title}${x.detail ? ` — ${x.detail}` : ''}`),
    ];
    const failing = rows.filter((x) => x.status === 'fail');
    if (failing.length) out.push('', 'How to fix the failing checks', ...failing.map((x) => `  ${x.id}: ${x.fix}`));
    return `${out.join('\n')}\n`;
  }

  /** The update's verdict on these rows: every UPDATE_CHECKS row not failing, and the site's facts
   *  present (an install still in setup answers no site facts; then only the host's rows count). */
  function health(rows, input) {
    const bad = rows.filter((r) => UPDATE_CHECKS.includes(r.id) && (r.status === 'fail'
      || (!input.site && !input.setupRunning && CHECKS.find((c) => c.id === r.id).side !== 'host')));
    return { ok: bad.length === 0, failed: bad.map((r) => r.id), rows: bad };
  }

  return Object.freeze({ SCHEMA_VERSION, AREAS, UPDATE_CHECKS, CHECKS: CHECKS.map(({ id, area, title, side, fix }) => ({ id, area, title, side, fix })), GROUPS, HELP, helpLine, evaluate, summary, health, text, report });
})();
