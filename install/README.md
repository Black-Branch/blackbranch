# The install bundle

Everything one community's site needs, on one Linux box, as one Docker Compose project.

**Box:** Debian stable or Ubuntu LTS, x86-64, 4 GB memory, 2 cores, 40 GB disk at minimum. A rented
VPS or a Linux machine at home. The site arrives as one prebuilt image — the same for every install —
so the box never builds it. (Installed from a checkout instead of a release, the box does build the
site's image, which takes most of a 4 GB box's memory; then a box under ~7.5 GB with no swap gets a
2 GB swap file at install.)

## Install

From a checkout or an unpacked release:

```bash
sudo ./install/install.sh                                   # asks two questions
sudo ./install/install.sh --domain example.com --mode tunnel   # or answer them up front
```

The one-line form: `tools/release.mjs cut` writes the release's `install.sh` stamped with that release
(version, size, sha256, `--base-url`); piped into bash it fetches the tarball, checks it, unpacks it as
`/opt/blackbranch/releases/<version>` and runs the installer inside it, with `--update-feed` set to where
it came from:

```bash
curl -fsSL https://blackbranch.app/install.sh | sudo bash
curl -fsSL https://blackbranch.app/install.sh | sudo bash -s -- --domain example.com --mode tunnel
```

The two questions:

1. **The domain** (`example.com`). The site answers there; `api.example.com` and
   `matrix.example.com` are used too. **It is permanent**: the chat server's name is the domain, and
   it can never change.
2. **The front door:**
   - `tunnel` (default): a Cloudflare tunnel. No open ports, works behind a home router. Needs a free
     Cloudflare account with the domain on it. The installer prints one link to sign in, then creates
     the tunnel and its three DNS records — every one of them, or it stops and says which (a name that
     already has a record: remove it in Cloudflare's dashboard and run it again; the tunnel is kept).
     Once the routes are in, it removes the sign-in certificate (`cloudflared/cert.pem`, the Cloudflare
     account's, not the tunnel's): the tunnel runs on its own credentials, and that folder is mounted into
     cloudflared and backed up. Changing the tunnel later starts with a new sign-in. Already made a tunnel
     in the Cloudflare dashboard? Pass `--tunnel-token` (it asks for the token, not shown) or
     `--tunnel-token-file <file>` — never the token itself on the command line, where every account on the
     box can read it and sudo logs it — and route the three names to `http://caddy:80` there. A wrong
     token stops the install at once with cloudflared's reason; given again on a re-run (`--tunnel-token`
     or `--tunnel-token-file`), it replaces the one in `.env`.
   - `direct`: the box takes ports 80 and 443 and gets Let's Encrypt certificates. Point the three
     names at the box first; the installer checks they resolve, and warns (and still finishes) when one
     resolves to an address that is not one of this server's.
   - `internal` — **lab mode, not for production.** Caddy issues certificates from its own local
     certificate authority, which no browser trusts until you add its root
     (`docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`). For a test box with no
     public DNS: put the three names in your own hosts file. Inside the box the apps trust that root
     already: `blackbranch up` copies the root certificate (never its key) to `/opt/blackbranch/lab-ca/`
     and `compose.lab.yaml` points web and stream-api at it, so the site's sign-in can reach the
     homeserver at `matrix.<domain>`.

In `direct` and `internal` mode every container resolves the three names to caddy (network aliases in
`compose.public.yaml`), so the site's own calls to them stay on the box. In `tunnel` mode they resolve
publicly and go through the tunnel — there are no certificates inside the box to answer with.

The installer installs Docker Engine if it is missing, writes `/opt/blackbranch/.env` with a random
value for every secret (mode 600, never printed), pulls the site's image and builds the other apps'
images on the box, starts everything and waits until every service is healthy. **Running it again changes nothing.**

## First boot: the setup link

The installer ends by printing **one setup link**, `https://<domain>/setup?token=…`. Open it in a
browser. Until setup is finished every page of the site shows "this site is being set up" and every
other API answers 503; sign-in, the setup pages and the Matrix discovery files stay open.

The setup pages, in order — each saves as you go, so a closed browser comes back to the same page
(open `https://<domain>/setup` again; you are still signed in):

1. **Your account** — a user name and a password. The account is made on the homeserver and becomes
   the site's admin and the streamer's account; you then sign in with it.
2. **Recovery sheet** — the backup passphrase and where `.env` lives. Shown once.
3. **Your site** — the name, short name, share line, description, the legal details, the time zone
   and the date the site's history starts. The domain and the server name are permanent.
4. **Points** — what the community's points are called.
5. **Modules** — one switch per optional part. A module you switch on gets its own page next, made
   from its manifest's `setup` steps (explanation, links, values to paste, fields, a Test button).
6. **Community** — makes the community space and `#general` as your account, and the federation
   switch (off by default).
7. **Finish** — the quiet hour, opt-in bug reports (off), and where backups go (this server, an
   S3-compatible bucket or an SFTP server). **Finish waits for a test backup**: one backup, then a
   restore of it into a scratch database on the server — it must pass. The site is then rebuilt once
   with the values from pages 3 and 4, and setup is done.

**The link works once.** It is good until the first admin account exists, then it is dead.
`blackbranch setup-link` prints it again while it is still good; `blackbranch setup-link --new` makes a
fresh one (the old one stops working). The token itself is kept only in
`/opt/blackbranch/state/setup-token` (root, mode 600); the site holds its sha256 (`SETUP_TOKEN_HASH`).

An install that already ran before this release counts as set up as soon as it updates: a database
built by the migration history gets `setup.completedAt` from migration v143; one that started from
the baseline shows the setup pages.

## What is on the box

| Path | What |
|---|---|
| `/opt/blackbranch/.env` | The one place for this install's values and secrets. **Back it up**: its secrets exist nowhere else |
| `/opt/blackbranch/compose.yaml` | The bundle (`compose.public.yaml` adds ports 80/443 in direct/internal mode) |
| `/opt/blackbranch/releases/<version>/` | Each release's source — the images and the site are built from it. `release/` points at the one in use; an update keeps the one before it to go back to |
| `/opt/blackbranch/rendered/` | Generated from `.env` (and the federation switch) — never edit by hand, the next render overwrites it: `Caddyfile` (the router), `synapse/homeserver.yaml` + `log.config`, `mas/config.yaml` |
| `/opt/blackbranch/matrix/mas-keys.yaml` | The sign-in service's signing keys, generated once. **Back it up** with `.env` |
| `/opt/blackbranch/requests/`, `results/` | Where the site asks the host for a fixed action, and reads the answer (below) |
| `/usr/local/bin/blackbranch` | The host command |

Services: `postgres` (one server; databases `stream`, `synapse`, `mas`, each with its own role),
`migrate` (one-shot: the baseline on an empty database, then newer migrations), `stream-api`,
`stream-ingest`, `web` (the site), `caddy` (the router), `cloudflared`
(tunnel mode), and the community's chat server: `synapse` (the homeserver) and `mas` (its sign-in
service). The Discord bridge is declared under the Compose profile `discord`, off until a later release.

The site is **one image for every install**: nothing about an install is built into it. Its name,
addresses, legal details and points words are read from `.env` when it starts, so a release pulls it by
digest and a changed display value applies when the site restarts (`blackbranch set`). An install's
own files — its icons and its points icon — go in `/opt/blackbranch/site-files/`, which the site serves
at `/site-files/` (set `SITE_ICON_SET=/site-files` for icons named `icon.png`, `icon-192.png`,
`icon-512.png`, `icon-maskable-512.png` and `apple-touch-icon.png`; `CURRENCY_ICON=/site-files/<file>`).

## The chat server

Every install runs its own Matrix homeserver. Its **server name is the domain** (`@name:example.com`),
fixed for good; the homeserver itself answers at `https://matrix.example.com`, and the site's
`https://example.com/.well-known/matrix/client` points every Matrix app there and to the sign-in
service at `https://matrix.example.com/auth/`.

- **Config is generated, never edited.** `blackbranch render` writes Synapse's and the sign-in
  service's config from `.env`: the database, the shared secret between the two, message retention
  (180 days by default; a room may choose 1 day–1 year; `#general` keeps 30 days), the site's sign-in
  client and its return address, and the site's right to delete an account when its owner asks. The
  homeserver's signing key is made once, in the `synapse-data` volume, and never replaced — **losing it
  cannot be undone**, which is why backups include it.
- **Federation is off** on a new install: no other Matrix server can reach this one, and it reaches
  none. `blackbranch federation on` turns it on (it re-renders and restarts Synapse; the server name
  does not change); `blackbranch federation off` turns it back off; `blackbranch federation` shows it.
  The setting lives with the site's other settings (`matrix.federation`), so the Admin Panel can switch
  it too.
- **Sign-up is closed until setup is finished.** The setup pages make your account through the
  sign-in service's admin API, so nobody needs sign-up before then — and keeping it shut means no one
  can claim the community's room names first. Once setup is finished it follows the Admin Panel's
  switch (Site → Community server → *Sign-up on the bundled homeserver*): unset means **closed** —
  set it to `open` when you want viewers to make accounts — and the site re-renders the config when it
  changes. With the database down a render keeps
  what the last one wrote. No email address is required: this release sends no mail, and requiring
  an address nothing can verify would lock everyone out. The site's raid switch closes sign-ups too.
  Uploads to the homeserver are capped at 20 MB (`max_upload_size`, from the generator's `MX_MAX_UPLOAD`).
- **The sign-in service's admin API is not on the internet.** It answers only on the service's
  internal listener (port 8081 inside the bundle's network), which the router never routes; the site
  reaches it there (`MAS_ADMIN_URL`).
- **The community space and `#general`** are created by `blackbranch matrix bootstrap`, as the
  streamer's own account, so the rooms are theirs. It looks before it creates, so running it again
  changes nothing, and it records the two room ids in the site's settings. The streamer's account is
  made by the setup pages' first page, and their Community page runs the bootstrap. Both rooms are
  listed in the server's public room list: the rendered Synapse config allows listing exactly those
  two aliases and nothing else, and listing a room still takes that room's own power.
- **It never adopts a room it did not make alone.** A room's creators (room version 12) keep their
  power for good, so if `#community-hub` or `#general` already exists and was made by another account
  — or names another account among its creators, or is of another room version — the bootstrap stops
  and says so instead of recording that room as the community's.

**A community alias someone else made.** Remove that room — and with it its alias — as a server
admin, from inside the box, then run the Community page (or `blackbranch matrix bootstrap`) again.
Use your own account's name for `<you>`, and the room id the bootstrap printed with its `!` written
as `%21`:

```bash
cd /opt/blackbranch
tok=$(docker compose exec -T mas mas-cli manage issue-compatibility-token \
  --yes-i-want-to-grant-synapse-admin-privileges <you> 2>&1 | grep -oE 'mct_[A-Za-z0-9_]+')
docker compose exec -T synapse curl -fsS -X DELETE -H "Authorization: Bearer $tok" \
  -H 'Content-Type: application/json' -d '{"purge": true}' 'http://localhost:8008/_synapse/admin/v2/rooms/%21<room id>'
docker compose exec -T synapse curl -fsS -X POST -H "Authorization: Bearer $tok" 'http://localhost:8008/_matrix/client/v3/logout'
```

The last line ends that admin session, so the token is good for this one job only.

**Trying the bootstrap without the setup pages** (a test box): make an account with the sign-in
service's own command, then bootstrap as it.

```bash
cd /opt/blackbranch
docker compose exec mas mas-cli manage register-user --yes --no-admin -p '<a password>' testadmin
blackbranch matrix bootstrap --as testadmin
```

The bootstrap signs in as that account for the length of the run only, and signs out when it ends.

## The `blackbranch` command

```
blackbranch status                 what runs and whether it is healthy
blackbranch logs <service> [-f]    recent logs
blackbranch restart <service>
blackbranch render                 regenerate the router, Synapse and sign-in config; restart what changed
blackbranch set <KEY> <value>      change one display value (SITE_NAME, LEGAL_*, CURRENCY_*, …); the site restarts with it
blackbranch migrate                apply database migrations now
blackbranch up                     bring everything to its configured state
blackbranch matrix bootstrap [--as <name>]   create the community space and #general (safe to repeat)
blackbranch federation [on|off]    show or switch federation
blackbranch setup-link [--new]     print the setup link while no admin exists (--new: a fresh one)
blackbranch apply-install          write the setup pages' display values into .env and restart the site once
blackbranch doctor [--report]      check the install; exit 1 when a check fails
blackbranch backup [list|key]      back up now; list the snapshots; print the SFTP target's key
blackbranch restore <snapshot|latest> [--verify] [--with-env] [--from <address>] [--yes]
                                   bring a backup back (asks first), or --verify: check it restores;
                                   asks for the recovery sheet's passphrase when .env's does not open it
blackbranch update [--check|--dry-run]   read the update feed; apply a newer release (asks first)
blackbranch update --channel stable|beta which releases this box takes
blackbranch health                 the update's health check, on demand
```

`user` arrives in a later release; until then it says so and exits with an error.

## Updates

A **release** is one version that pins everything on the box: the source of the apps (a tarball the
box checks by its sha256; stream-api, stream-ingest and the backup tool are built from it as at
install) and every image — **the site's own, prebuilt**, the database, the chat server and its sign-in
service, the router, the tunnel, the backup tool's and the build's base — by digest, so a re-published
tag can never change what a release is. The project announces the newest
release on each channel in a **signed feed** (`<BB_UPDATE_FEED>/<channel>.json`, by default
`https://blackbranch.app/releases/stable.json`). The box checks the signature with the key it was
installed with (`BB_RELEASE_KEY` in `.env`; `install/release-key.pub`), using the release it already
runs; an update never changes that key. The box refuses a release older than the one it runs, a feed
for another channel, a feed whose publisher has not signed it again before it expired, and any release
that would move the database to another Postgres major version — that is always its own announced step.

**When:** the timer `blackbranch-update.timer` reads the feed every night at the quiet hour (Admin Panel
→ Site → Running the site) plus up to ten minutes. A **security release** applies itself then — but
never while the stream is live: it waits, checking every minute, until the stream ends (for up to six
hours; after that, the next night). A **feature release** waits for you: the Admin Panel's Updates
section shows it with an Apply button, or run `blackbranch update`. A box that cannot read its feed
for three days says so on the doctor page and in `blackbranch doctor`.

**What an update does, in order** — nothing live changes until step 6:

1. read and check the signed feed;
2. fetch the release's source and check its size and sha256 against the feed (only plain files, all in
   one folder), and unpack it as `releases/<version>/`;
3. run the release's `.env` migrations on a **copy** of `.env` (`install/migrations/`) — it stops here,
   naming the key, if `.env` would hold a key the release does not know or lack one it needs;
4. fetch every image by digest (the site's among them), build the release's own images (tagged with
   its version), and check that its router, Synapse and sign-in templates render with the migrated
   `.env`;
5. start the release's site beside the running one, with the migrated `.env`, and check it answers
   (then remove it — the running site keeps serving);
6. stop the site, the chat services and the chat server, and **back up** (so nothing written before
   the stop can be lost if it has to go back);
7. switch: `release/` points at the new release, `.env` becomes the migrated copy, the new release's
   host files go in place, and the new release brings itself up — migrations, the chat server (it
   migrates itself), stream-api, stream-ingest, the site;
8. **health check** — the new release's own (`blackbranch health`): every doctor check an update can
   affect, a WebSocket frame from stream-api, and a sign-in round trip (the site starts a sign-in the
   sign-in service accepts; a token it issues for the streamer works on the homeserver, then ends);
   then the apps are restarted twice and checked again.

If the health check passes, the release is recorded and the release from two updates ago is removed
(its images and folder). If anything after step 6 fails, the box **goes back**: the previous release's
folder, `.env` and host files, the databases and the chat server's media from the backup made in step
6, and the previous release's health check. Both results are on the Admin Panel and in
`blackbranch status`. `blackbranch update --dry-run` runs steps 1–3 and changes nothing.

**An update that is stopped** (`systemctl stop`, a shutdown) puts the box back before it exits: during
step 6 it starts the site again on the release in use; from step 7 on it goes back as above. The update
units give it the time (`KillMode=mixed`, `TimeoutStopSec=30min`). **One cut off harder** (a power loss)
is finished at the next boot by `blackbranch-reconcile.service` (`blackbranch update --reconcile`; every
`blackbranch update` runs it first too): without it the stopped services would stay down — they are
`restart: unless-stopped` — and `release/` would already name the new version, so nothing would notice.

"Started again" means `docker compose up` succeeded **and** every service came back healthy. When it
did not, the last update's result says so — *starting it again FAILED: the site is down* — and the
update's progress marker stays: the boot unit and every `blackbranch update` try again (the reconcile
exits with an error until it works, so the boot unit shows failed), and no new update starts on top of
it. An update that passed its health checks but whose clean-up of older releases failed is recorded as
**updated**, with the clean-up named.

## Requests from the site

## Backups

**What a backup holds:** the three databases (`stream`, `synapse`, `mas` — `pg_dump`, one after the
other in one run), the chat server's media store and **signing key**, and the install's own files:
`.env`, MAS's keys (`matrix/mas-keys.yaml`) and the tunnel's credentials. A manifest inside records
each dump's table count and hash and the keys' hashes. Not in it: the site's image (pulled again by
the release), `site-files/` (your own icons — keep your copy of them), Caddy's certificates (fetched
again) and the chat service's sound scratch files.

**Where:** [restic](https://restic.net) snapshots, encrypted with the **backup passphrase** on the
recovery sheet (`BACKUP_PASSPHRASE` in `.env`). The target is a setting (setup's last page, or Admin
Panel → Site → Backups): `local` (default, `/opt/blackbranch/backups/restic`), `s3`
(`s3:https://<endpoint>/<bucket>[/<folder>]` with an access key id and secret key — Backblaze B2,
Cloudflare R2, …) or `sftp` (`sftp:<user>@<host>:<folder>`; put the key `blackbranch backup key`
prints into that account's `authorized_keys`). Kept: 7 daily and 4 weekly snapshots (settings
`backup.keepDaily`, `backup.keepWeekly`). A local target does not survive losing the disk — add a bucket.

**When:** every night at the quiet hour (`blackbranch-backup.timer`), and a check every Sunday half an
hour later that the newest backup restores (`blackbranch-verify.timer`). Both are rendered from the
quiet hour and the site's time zone at every `render` and after every backup. Results:
`results/backup-last.json` and `results/backup-verify-last.json`; the doctor's **Backups** rows read
them (last good backup under 36 hours old, last check passed, the target answers).

**How the server reads the target's keys:** the bucket's keys are secret settings (encrypted in the
database). `blackbranch` reads them itself, as root, by running this release's own settings code
inside the stream-api image with `INSTANCE_MASTER_KEY` from `.env` — no web address hands a secret out,
and the site only ever names a request. The last target used is kept root-only in
`state/backup-target.env`, so a restore works while the database is gone. The keys reach restic
through its container's environment, never a command line.

**`blackbranch restore latest --verify`** restores the snapshot into a scratch folder inside a
throwaway container that has no database password and no live volume, starts a Postgres of its own
there (a unix socket only), loads the three dumps and checks: each dump's hash against the manifest,
each database's table count, one stored token decrypts with the snapshot's `TOKEN_ENC_KEY` ("none
stored yet" is not a failure), the signing key and MAS's keys are there and unchanged, `.env` holds
the secrets a restore needs, and the media store came back whole. A damaged snapshot fails loudly:
exit status 1 and `VERIFY FAILED: …` naming what is wrong.

**`blackbranch restore <snapshot|latest>`** stops the site, the chat server and the chat services,
replaces the three databases from the snapshot, puts the media store, signing key and MAS's keys
back, and starts everything again (`up`, which applies any newer migration). It asks you to type the
domain first (`--yes` skips that). It refuses a snapshot made with other secrets than this box's
`.env`; on a **new box** (installed fresh, setup not run), `--with-env` restores the snapshot's `.env`
too (keeping `BB_RELEASE` on the release the box runs, and refusing a snapshot of another domain) and
makes the empty database again with its passwords. When the box's `.env` passphrase does not open the
backups (the old `.env` was lost), it asks for the recovery sheet's (or reads `BB_RECOVERY_PASSPHRASE`);
`--from <s3:…|sftp:…>` reads a bucket or SFTP server the new box has no settings for.

## The doctor

`blackbranch doctor` and the Admin Panel's **Doctor** page (`/admin/doctor`) show the same list of
checks with the same verdicts: the box (memory, free disk, clock, security updates), the front door
(the three names, the tunnel or the certificates, the three addresses answering), the database, the
chat server (Synapse, the sign-in service, the well-known files, the rendered config, federation), the
secrets, the switched-on modules' Tests, media through the tunnel and backups (the last good one under
36 hours old, the weekly restore check passed, the target answers). Payments, platforms and updates
show as "not checked in this release". Every check only reads, and each failing one prints
a plain fix line.

The two halves of the facts come from where they can be known: the command reads the box and writes
what it found (numbers and yes/no only) to `results/doctor-host.json`; the site reads its database,
asks the chat server through its public names and runs the modules' Tests without recording them. The
page's **Check again** asks the box for fresh facts through the request folder (`doctor.req`). With the
site down the command still prints the box's checks; the site's say "site unreachable".

`blackbranch doctor --report` writes `doctor-report-<time>.txt` beside `.env`: the release, the module
switches, every check and the failing checks' fix lines — no secret, no chat text, no viewer id, no
domain. Before it is kept, the report is searched for every `.env` value of six or more characters
(the three keys that hold the product's own words — `COMPOSE_PROJECT_NAME`, `COMPOSE_PROFILES`,
`BB_TLS_MODE` — excepted); a report that holds one is deleted and the command fails.

## Requests from the site

The site never gets control of Docker. To ask the host for something it drops a file into
`/opt/blackbranch/requests/`: `restart-stream-api.req`, `restart-stream-ingest.req`,
`restart-web.req`, `render.req` (after the Admin Panel changes the federation or sign-up switch, and at setup's Finish),
`matrix-bootstrap.req` and `apply-install.req` (the setup pages' Community and Finish pages),
`doctor.req` (the Doctor page's Check again: the box's facts only), `backup.req` (a backup now),
`backup-test.req` (setup's Finish page: a backup, then a verify of it), `backup-key.req` (the SFTP
key's public half), `recovery-sheet.req` (setup's recovery page; see below), `update-check.req` (the Updates section's Check now) and `update-v<version>.req`
(its Apply button: the version rides in the name, and the box applies it only if the signed feed names
exactly that release; the update runs as `blackbranch-update@<version>.service`, and its answer is
`results/update.json`). The systemd path
unit `blackbranch-requests.path` runs the matching fixed verb, deletes the request and writes the
result to `/opt/blackbranch/results/<name>.json` — a directory only root writes and the site only
reads, kept outside the drop box. Any other file name is refused and gets no answer (an answer named
after it could overwrite one of the box's own records there); a request is never opened. While an update
runs, only `update-check`, `doctor` and `backup-key` run; every other known request is answered "an
update is running", an unknown one still gets no answer (and the nightly backup and weekly verify skip
their turn).

**The recovery sheet** is the one secret the site ever gets from the box, and never through its
environment: the site also chooses where backups go, so a site that held the passphrase that opens them
could send them to its own server and read every secret in them. While — and only while — setup's
recovery page is current, `recovery-sheet.req` makes root write the passphrase into
`results/recovery-passphrase.json`, readable by the site's user alone (group 1000, the image's `node`).
Root takes it back on the first request after setup moves on (and at Finish, and at `blackbranch up`
once setup is finished), and records that it was shown in `state/recovery-sheet-shown`: the site writes
the setup state, so a site that rewinds its step does not get the sheet again. It is due at all only
on an install whose `.env` install.sh wrote with this check in it (`state/recovery-sheet-due`): a box
set up before it never gets one, whatever the database says. Lost it? It is `BACKUP_PASSPHRASE` in `.env`.
