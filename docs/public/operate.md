# Running your install

Everything here is done on the server with the `blackbranch` command, or in the site's Admin Panel.
The command needs root: run it with `sudo` from your usual account, as every recipe below does. (Without
`sudo` it answers "the install at /opt/blackbranch is root's: run it with sudo".) It works even when
the site is down. That is why it exists.

```
sudo blackbranch status                 what runs, which release, the last backup and update check
sudo blackbranch doctor [--report]      check the install (exit 1 when a check fails)
sudo blackbranch logs <service> [-f]    recent logs: postgres, stream-api, stream-ingest, web, caddy, synapse, mas, cloudflared
sudo blackbranch restart <service>
sudo blackbranch backup [list|key]      back up now · list the snapshots · print the SFTP target's key
sudo blackbranch restore <snapshot|latest> [--verify] [--with-env] [--from <address>] [--yes]
sudo blackbranch update [--check|--dry-run]   read the release feed; apply a newer release (asks first)
sudo blackbranch update --channel stable|beta
sudo blackbranch set <KEY> <value>      change one display value (SITE_NAME, LEGAL_*, CURRENCY_*…); the site restarts with it
sudo blackbranch federation [on|off]    show or switch federation with other Matrix servers
```

Where things are: `/opt/blackbranch/.env` holds the install's values and **every secret** (mode 600).
`/opt/blackbranch/releases/` holds each release's source; `release` points at the one in use.

## The doctor

`sudo blackbranch doctor` on the server and **Admin Panel → Doctor** in the site show the same checks with
the same verdicts: the box (memory, free disk, clock, security updates), the front door (the three
addresses resolve and answer; the tunnel or the certificates), the database, the chat server and its
sign-in service, the secrets, each module you switched on (its Test, run again), payments and
platforms, backups and updates. Every check only reads. A red row has a one-line fix under it; amber
means "look at this", grey means "not checked here".

**The doctor shows; it does not send.** A failing check (a Stripe or PayPal webhook that is
missing, switched off or lacks an event, say) turns red when you open the doctor or run it (the
Admin Panel's Stream tab counts the same verdicts when you open it), and nowhere else: this release
sends no message, email or push about it. The same goes for a payment that failed, was refunded or
disputed: it is listed in **Admin Panel → Payments → Payment history**, and nothing else tells you.
Look at both now and then, and after any change at Stripe or PayPal.

Stuck? The Doctor page (and the end of the install) says where to ask: the guides and the project's
Discord. When you ask for help, attach `sudo blackbranch doctor --report`: it writes a report next to `.env` with
the release, the module switches and every check, and no secret, no chat text, no viewer id and no
domain. Before it keeps the file it searches it for every value in `.env` and refuses if it finds one.

## Ending a stream

**End each stream on the site when you stop.** The site marks you live when a platform says so, but
it does not yet notice every stream ending by itself: until you end it, the site keeps showing you
as live (the live player, the timer, watch points). End it from the site: type `/stream end` in the
site's chat (the admin and moderators can), or press **Force offline** in the stream page's
**Community embeds** window.

## Backups and restores

**What is backed up:** the three databases (the site, the chat server, its sign-in service), the chat
server's media and its **signing key**, and the install's own files: `.env`, the sign-in service's
keys and the tunnel's credentials. Backups are [restic](https://restic.net) snapshots, encrypted with
the **backup passphrase** from your recovery sheet.

**When:** every night at the quiet hour, and before every update. Every Sunday, half an hour after the
backup, the server checks that the newest backup really restores. Both results are on the doctor.
Kept: 7 daily and 4 weekly snapshots (Admin Panel → Site → Site, card Backups).

**Where:** set on setup's last page, changed in the Admin Panel: this server
(`/opt/blackbranch/backups/`), an S3-compatible bucket, or an SFTP server (put the key
`sudo blackbranch backup key` prints into that account's `authorized_keys`). Note: a backup on the same disk
does not survive losing the server, so add a bucket or another server.

- A bucket must exist before the first backup (create it at the provider: Black Branch never creates
  one; a bucket that is not there is reported as "the bucket … does not exist"), and its address needs a
  certificate browsers trust (Backblaze B2, Cloudflare R2, Wasabi and Amazon S3 all have one).
- SFTP: `sftp:<user>@<host>:/srv/backups/site` is a folder from the server's root;
  `sftp://<user>@<host>:<port>/backups/site` (another port) is a folder **inside that account's home**.

**Check a backup without touching anything:** `sudo blackbranch restore latest --verify` restores the
newest snapshot into a throwaway container and checks every database, the keys and the media. A
damaged snapshot fails loudly.

**Restore:** `sudo blackbranch restore latest` (or a snapshot id from `sudo blackbranch backup list`). It asks you
to type the domain, stops the site, puts back the databases, media and keys, and starts everything
again. Anything written after that snapshot is gone.

**Lost the server and its `.env` too?** All you need is the backups and the recovery sheet's
passphrase:

1. Install a new server with **the same domain** and front door, and do not open the setup link.
2. Make the backups reachable: for a local target, copy the backups folder you kept into
   `/opt/blackbranch/backups/` (a plain folder of encrypted files); for an SFTP server, add the new
   server's key (`sudo blackbranch backup key`) to that account first.
3. `sudo blackbranch restore latest --with-env`. For a bucket or SFTP server add `--from <its address>`
   (a bucket asks for its two keys). It sees that the new `.env`'s passphrase does not open the
   backups and asks for the one on your recovery sheet; then it brings back the databases, the chat
   server's media and signing key, its sign-in keys **and your old `.env`**. Your accounts, rooms and
   settings are back; sign in as before. (Unattended: `BB_RECOVERY_PASSPHRASE`, and
   `BB_S3_ACCESS_KEY_ID` / `BB_S3_SECRET_ACCESS_KEY` for a bucket.)

**Two things cannot be replaced if lost: the backup passphrase and the chat server's signing key.**
Without the passphrase no backup can be opened; the signing key is in every backup. Keep `.env` and
the passphrase somewhere off the server.

### Encrypted messages: what a backup can and cannot give back

Four different things keep the install and its members' encrypted messages recoverable. Only the
first is yours as the operator.

| | What it is | Who holds it | What it opens |
|---|---|---|---|
| **The recovery sheet** | The backup passphrase (and where `.env` lives), shown once on setup's second page. | You, off the server. `.env` holds it too. | The install's backups. Nothing else: it is not anyone's chat key. |
| **A member's recovery key** | A long code their own browser makes when they set up encryption: a random key, written out in an encoded form so it can be copied. Encoded is not hidden: **it is a secret**, like a password, and nobody should ask for it. | That member alone. The server never receives it. | Their encrypted messages' keys on a new device, and the key backup below. |
| **The key backup** | The keys to a member's encrypted messages, kept on the chat server encrypted; the key that opens them is stored there too, **locked with the member's recovery key**. | The chat server, so it is inside your install's backups, still locked. | Is read only with that member's recovery key, or from one of their verified devices. |
| **Device verification** | Confirming a new browser or phone from one already signed in, by comparing emoji on both. | The member's devices. | Passes the keys from the old device to the new one. |

Encrypted here means direct messages started on the site (they are encrypted from the start; one
opened from another Matrix app may not be) and any room someone has switched encryption on in.

**After you restore a backup** (from this server, a bucket or SFTP), accounts, rooms and messages are
back as of that snapshot; encrypted messages come back still encrypted, and each member's key backup
comes back still locked. A member reads their old encrypted messages again with a device that still
holds the keys, or with their recovery key. Nothing you hold can unlock them for someone: not the passphrase, not `.env`, not the
backup.

**A member who loses every signed-in device and their recovery key** cannot read their earlier
encrypted messages again, and no restore changes that. They can start fresh from their encryption
settings (new keys, new recovery key) and go on; new messages work as before. The site keeps no copy
of anyone's recovery key, and offers no place to store one: a member who wants a spare keeps it
themselves, in a password manager.

## Updates and rollback

A **release** is one version number that pins everything on the server: the source of the site and
its services (checked by its sha256) and every other piece (database, chat server, sign-in service,
router, tunnel, backup tool) by digest. The project announces releases in a **signed feed**; your
server checks the signature with the key it was installed with, and refuses a feed signed by anyone
else, an older release, an expired feed and any release that would move the database to a new
Postgres major version (that is always its own announced step).

**When:** every night, 45 minutes after the quiet hour, the server reads the feed.
- A **security release** applies itself then, **never while you are live**: it waits, checking every
  minute, until the stream ends (up to six hours; after that, the next night).
- A **feature release** waits for you: **Admin Panel → Updates** shows it with an **Apply** button, or
  run `sudo blackbranch update`.
- `sudo blackbranch update --check` only looks; `--dry-run` also downloads and checks the release and
  changes nothing.

**What an update does:** downloads and checks the release; updates `.env` for it on a copy (and stops,
naming the setting, if something is not understood); fetches its images (the site's is prebuilt)
and tries the new site beside the running one; then stops the site (usually for well under a minute), **backs up**, switches
to the new release, starts it, and runs a health check (the doctor's checks, a live chat connection
and a sign-in round trip), then restarts the services twice and checks again.
The front door is checked on the server itself (in direct mode, at its own port 443 by each name),
so a home router that cannot reach its own public address from inside does not roll an update back.
Whether the site answers **from outside** is the doctor's "Reachable from outside" row: a warning,
because from inside many home networks it cannot succeed. Open the site on a phone with Wi-Fi off
to be sure.

**Rollback is automatic:** if anything fails after the stop, the server goes back to the previous
release, its `.env`, and the databases and media from the backup it made just before, then checks
health again. Both results show on the Admin Panel and in `sudo blackbranch status`. A release that rolled
back is not retried by the nightly timer, with one exception: when the only thing that failed was a
chat reader (Twitch, Kick, YouTube or Streamplace not answering), the timer tries it again on each of
the next nights, three attempts in all, then stops and says so. `sudo blackbranch update --apply <version>`
tries it again by hand.

**Channels:** `stable` (the default) or `beta` (earlier releases, for people who want to help test):
`sudo blackbranch update --channel beta`. Every release so far is a preview on `beta`, and `stable` has
none yet; a server installed with the one-line form already follows `beta`.

## Mail and password resets

Mail is optional. Without a mail server (a new install) the sign-in service sends nothing: a forgotten
password is reset on the server (below), and sign-up asks for no address. Set a mail server in **Admin
Panel → Site → Site, card Mail** (or `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_MODE`, `MAIL_SMTP_USERNAME`,
`MAIL_SMTP_PASSWORD` and `MAIL_FROM` in `/opt/blackbranch/.env`, then `sudo blackbranch render`) and
the sign-in page offers "Forgot password?", and a new account confirms its address by mail. Your mail
provider gives you the server, port and user name; most use STARTTLS on port 587. Try it with
`sudo blackbranch mail test you@example.com`: the Doctor's **Mail** row is green once a test message
was sent and red when the last one failed, with the reason. Accounts made before you set mail have no
address yet; they add one on the sign-in service's account page before they can use "Forgot password?".

Without mail, or for an account with no address, a forgotten password is reset on the server, through
the chat server's sign-in service:

```bash
read -rs NEWPW && sudo docker compose --project-directory /opt/blackbranch exec mas mas-cli manage set-password <username> "$NEWPW"; unset NEWPW
```

(`read -rs` keeps the password out of your shell history.) A `sudo blackbranch user reset-password`
command comes in a later release.

## Sign in with Google, Discord, Twitch or your own server

Optional. Each provider you switch on adds a "Continue with …" button to the sign-in page, beside the
username and password. Switch them on in **Admin Panel → Site → Site, card Sign-in providers** (or the
`SIGNIN_*` lines in `/opt/blackbranch/.env`, then `sudo blackbranch render`):

1. Make an app at the provider: Google Cloud console (APIs & Services → Credentials → OAuth client ID,
   type Web application), the Discord Developer Portal (Applications → OAuth2), the Twitch developer
   console (Register Your Application), or a confidential OpenID Connect client on your own server
   (Authentik, Keycloak, Zitadel, Authelia…).
2. Paste the **redirect URL** the card shows under the provider's switch into that app. For Google,
   Discord and Twitch it never changes. For your own server it appears once its address (`https://…`,
   exactly as the server names itself) is saved, and belongs to that address.
3. Copy the app's client id and secret into the card. Saving re-renders the sign-in service and restarts it.

The Doctor has a row per provider: green once the sign-in service offers it and the provider answers;
red with the reason when a field is missing, the provider does not answer, or (your own server) it
names a different address for itself. A user name the provider offers is only suggested, never forced
onto an existing account. With **Let people make accounts** off, a provider still signs in the people
it is linked to but makes no new account. No e-mail address is taken from a provider:
the person adds one on their account page, where it is checked. Switching a provider off removes its button; the people who signed in with it
keep their link and use it again when you switch it back on. Your own server's link belongs to its
address: a different address is a different server (a new redirect URL to paste), and nobody's link
carries over to it; switch back to the old address and the old links work again. Do not run
`mas-cli config sync --prune`: it deletes those links for good.

## When a viewer deletes their account

**Settings → Delete my account** erases the person's site data at once and then deactivates their
Matrix account through the chat server's sign-in service. When the sign-in service cannot do that at
that moment (it is down, or the site's sign-in client lacks its admin grant), the site tries again every
hour until it lands, and the Doctor's row **Deleted accounts: their Matrix accounts are removed** is red
with the count until then. If it stays red, the site's client cannot deactivate accounts: the bundle
gives it that grant, so on a bundle install check `sudo blackbranch doctor` for the sign-in rows; on a
homeserver you run yourself, list the client in MAS's `policy.data.admin_clients`, or deactivate the
account there by hand. The site marks it done on its next try either way.

## Changing the site's name and other display values

The site's name, its legal details and the points names live in `/opt/blackbranch/.env`, and the site
reads them when it starts. The setup pages set them; afterwards change one on the server with
`sudo blackbranch set SITE_NAME "New name"`. The site restarts with it (a few seconds), and goes back to the
old value by itself if it does not come back healthy. The domain and the chat server's name can never
change.

**Your own icons:** put `icon.png` (512 px), `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` and
`apple-touch-icon.png` (180 px) in `/opt/blackbranch/site-files/`, then `sudo blackbranch set SITE_ICON_SET
/site-files`. A points icon goes there too: `sudo blackbranch set CURRENCY_ICON /site-files/<file>`. The
folder is yours: it is not in the backups, so keep your own copy of what you put there.

## Who can do what: viewers, moderators and the admin

The first admin is the account made on setup's first page. Any admin can make another account an
admin, or remove one, in **Admin Panel → Site → Moderators, card Admins**; the site always keeps at least one
(removing the last admin is refused, and so is the last admin's "Delete my account"). On the server,
`sudo blackbranch user admin <name> on|off` does the same, which is how you get an admin back when
nobody can sign in as one. Every change is in the moderation log. A second admin is the simplest
insurance against a lost admin account. Admins make and remove moderators (the `/mod <name>` and
`/unmod <name>` chat commands). Every line below is checked by the server, not only hidden from the
page. A moderator cannot ban, time out, clear or merge an admin.

| | Viewer | Moderator | Admin |
|---|---|---|---|
| Chat, vote, read the public chat history (deleted messages left out) | yes | yes | yes |
| Delete messages; time out, ban and unban; clear a person's recent messages, on the site and on Twitch, Kick or YouTube where the site can | no | yes | yes |
| Read chat messages sent for supporters only | supporters | yes | yes |
| Start a poll, and end their own | supporters | yes | yes |
| End or extend anyone's poll, pin a chat message, post an announcement | no | yes | yes |
| Slow mode, closing sign-ups during a raid, the link gate, blocklist words, switching the AI automod on or off, reviewing held messages | no | yes | yes |
| **Search the whole chat history, deleted messages included**; the moderation log; whether an action reached each platform; user reports and support tickets | no | yes | yes |
| **A person's details:** their names on every platform, how much they chat, when they were first seen, the chat bot's notes on them (when a bot runs), suspicious-account marks; set their pronouns | no | yes | yes |
| **Merge two chat identities into one person** (permanent: there is no unmerge) | no | yes | yes |
| Stream controls: the timer, resetting the support bar and timer, forcing the site offline, the community embeds and the videos shown while nobody is live, refreshing emotes | no | yes | yes |
| Highlight a message on stream, pin forum posts, define badges, house looks, store and style prices, force-rebuilding the emotes | no | no | yes |
| Payment history; forgetting a person's AI memory | no | no | yes |
| Make or remove moderators; the list of moderators | no | no | yes |
| Make or remove admins (never the last one) | no | no | yes |
| The Admin Panel: every setting and credential, module switches, AI settings, the Doctor, Updates, restarting services, the OBS rig page, points, the Stream tab | no | no | yes |

`/mod` also gives the person moderator power in the community rooms, and `/unmod` takes it away
again: the site asks the server to bring the rooms up to date at once, and the server checks them
every 10 minutes as well (see below). To see what it would change, without changing anything, run
`sudo blackbranch community reconcile --mode report`. On an install where the server does not keep
the rooms yet (switched off, below), the rooms are updated the next time the admin opens the
community instead.

## The community's rooms, kept by the server

The server can keep the community's rooms the way the Admin Panel sets them: every 10 minutes, and
right after a change in the panel, it makes any room that is missing and lets each person into the
rooms their role or support allows. It does this as the install's own community account, never as
yours.

A name or setting changed somewhere else (in Element, say) follows the panel's setting
**Keep changes made in Element** (Admin Panel → Site → Site, card Channels). Off (the default): the server puts it back the way the panel has it. On: the
change stays, and the server only reports it. While it is on, changes made in the panel to a channel that
already exists are not applied either (they are listed as differences); new channels, who is in which
channel and who is a moderator still are.

Whatever that setting says, the server always applies three things: each person's role in every
room (admin, Staff, mod, bot, supporter), who is in a channel only some people can see (an invite
when someone gains the right, removed when they lose it), and site bans and timeouts (a ban becomes a
room ban carrying the site's reason; a timed-out person stays in the rooms, read-only until it ends).
A room ban someone made by hand is never lifted by the server. A supporter enters a channel for
supporters by accepting the invite the community account sends them. A ban or timeout given while a
run is going waits for the next run, at most 10 minutes later.

The Doctor shows how it went. **The community's rooms are as the Community page sets them** is green
when the last run had nothing to put back, amber when it put something back, left a difference as it
is, or could not look after a room (the row says which, and Admin Panel → Site → Community lists
them under **Last applied**), and red when the last run failed: one change the chat server refused
fails only its own room, and the other rooms are still kept. **The community's rooms were checked in
the last 30 minutes** turns amber when runs stop. When a run fails after one that worked, the server
sends one alert (to the same place as a failed backup's), and one more when a run works again.

A new install has this on. An install set up before it existed has it off, and its rooms stay as they
are until you turn it on:

```
sudo blackbranch community on      # keep the rooms as the panel sets them (a first run starts now)
sudo blackbranch community off     # stop; the rooms stay as they are now
```

Either one restarts the site, which takes a few seconds.

To see what the server would change, without changing anything:

```
sudo blackbranch community reconcile --mode report
```

It prints one line per change, then one last line holding the whole result for scripts (it starts
with `{"mode":"report"`). It exits with 0 when it finished, whether or not something would change
(what would change is in that last line), with 2 when it could not run, and with 75 when another run
(or an update) is going or the site is still being set up; wait a minute, then run it again.

The community account joins only the community's own rooms: an invite to any other room stays
pending and is not listed, and a room linked into the community that the account is not in is listed
under **Last applied** on the Admin Panel's Community page. A room is the community's own when you
or an admin of the main space linked it into the main space, or into a category or space you linked
there, at any depth, and invited the account.

If a chat bridge you run yourself already serves some of the rooms, list its bot's account in
Admin Panel → Site → Community, card Bridge accounts, before you switch this on. The server leaves
a listed account's power alone and never removes it; a room that only says it is bridged, by an
account that is not listed, gets no such exception: the Doctor turns amber, and the Community page
names the room and the account.

## Payments: what each provider does

| | Stripe (cards) | PayPal / Venmo | Ko-fi | Patreon | Streamlabs |
|---|---|---|---|---|---|
| The monthly Supporter subscription (supporter perks, renewing) | yes, with a price set | yes, with a billing plan set | no | no | no |
| Gift a subscription to someone, or to recent chatters | yes | no | no | no | no |
| A one-time tip, announced on stream | yes | yes | yes | no | yes |
| Buying points | yes | yes | no | no | no |
| How it reaches the site | the site's own checkout | the site's own button | Ko-fi's webhook | Patreon's webhook | Streamlabs' live feed |

- **The Supporter subscription is sold through Stripe, PayPal, or both.** Stripe needs the price
  (Admin Panel → Payments → Connections, card Stripe, **Supporter subscription price**, a `price_…` id);
  PayPal needs a billing plan (card PayPal, **Subscription plans**, `{"supporter":"P-…"}`). The price and currency shown on the site are
  read from Stripe or PayPal. A PayPal plan must bill monthly at a fixed price and have a payment
  failure threshold set. Without either, no subscribe button is offered.
- **Gifts are card payments (Stripe) only**, and charge what the subscription costs.
- **Venmo shows only when PayPal finds the buyer eligible:** in practice a US business account and a
  US buyer paying in dollars.
- **A signed-in tipper also gets points for the tip**, with either Stripe or PayPal; a refund or a
  lost dispute takes them back. Buying points needs an account; a tip does not.
- **Ko-fi, Patreon and Streamlabs bring events in; they grant nothing on the site.** Each event
  becomes an alert on stream, moves the support bar and is listed in Payment history. Ko-fi sends
  each tip and each membership payment; Patreon sends a new pledge only (not renewals or
  cancellations); Streamlabs sends tips. A Ko-fi or Patreon member is not a supporter on the site.
- No subscription on the site? **Admin Panel → Payments → Connections, card Links, Outside subscribe link** sends the
  Subscribe button to a page of your choice (your Patreon, say). It is only a link: nothing comes back
  from it. **Donate link** does the same for the Donate button and `!dono` when no payment provider is
  on.

## Moving to a bigger server

A move is a restore onto a new server:

1. On the old server: `sudo blackbranch backup` (a fresh snapshot), then stop it:
   `sudo docker compose --project-directory /opt/blackbranch stop`.
2. Get the backup repository onto the new server. A local target: copy `/opt/blackbranch/backups/`
   across (`sudo rsync -a`). A bucket or SFTP target: copy the repository folder from there into
   `/opt/blackbranch/backups/restic/` on the new server (it is a plain folder of encrypted files).
3. On the new server, install with **the same domain** and the same front door, adding `--moving`:
   `… install.sh --domain example.com --mode tunnel --moving` (or `--mode direct`). It installs
   everything but starts nothing, makes no tunnel and prints no setup link. The restore brings all
   of that back.
4. `sudo blackbranch restore latest --with-env`. It takes the snapshot's `.env` (your secrets) as well as
   the data, then starts the site. (A bucket or SFTP target can be read directly: add `--from <its address>`.)
5. The front door:
   - **Tunnel mode:** nothing to change. The restore brings back the site's own tunnel, which now
     connects from the new server; its DNS records already point at it. (Keep the old server stopped:
     two servers on one tunnel would both answer.)
   - **Direct mode:** point the three DNS records at the new server.

   Then check `sudo blackbranch doctor`.

**If the installer already made a new tunnel** (you installed without `--moving`): the restore keeps
the new server's own tunnel and says so: its routes are the ones in place. Delete the old tunnel in
Cloudflare's dashboard (Zero Trust → Networks → Tunnels) once the old server is gone. **If you deleted
the old tunnel before restoring** and the site's own is gone: make a tunnel in the dashboard, route
the three names to `http://caddy:80`, and give the new server its token:
`sudo /opt/blackbranch/release/install/install.sh --tunnel-token` (or `--tunnel-token-file <file>`);
it replaces the signed-in tunnel with that one.

Note: this path is built and its refusals are tested, but the project has not yet rehearsed a whole move
on two fresh servers. Try it on a spare server first, and keep the old one until the new one is green.

## Bigger server, same box

Adding memory or disk to the same server needs nothing from Black Branch: shut it down, resize, start
it. Everything comes back on its own.

## Settings that apply at a restart

<!-- restart-settings: generated by install/restart-settings.mjs; edit the schema, then run it with --write -->

These 32 settings are read once, when the service that uses them starts. Changing one does
nothing until that service restarts. The Admin Panel says "applies at restart" beside each of its own;
this is the whole list in one place. `sudo blackbranch help` prints it too, and `sudo blackbranch status`
names any that were changed in the Admin Panel after their service last started.

**Changed in the Admin Panel.** After you change one, restart each service in its row:
`sudo blackbranch restart <service>`.

| Setting | Restart | What it is |
|---|---|---|
| `modules.lights` | `stream-api` | Room lights |
| `modules.meter` | `stream-api` | Support meter |
| `modules.obs` | `stream-api` | OBS control |
| `modules.radio` | `stream-api` | Radio |
| `obs.password` | `stream-api` | OBS WebSocket password |
| `streamlabs.socketToken` | `stream-api` | Streamlabs socket token |
| `tts.enabled` | `stream-api` | Speak alerts and paid messages |

**Display values in `.env`.** Change them with `sudo blackbranch set <KEY> <value>`: it restarts what
reads them for you. If you edit `.env` by hand instead, run `sudo blackbranch up` afterwards (a plain
restart keeps the old value).

| Key in `.env` | Restart | What it is |
|---|---|---|
| `COMMUNITY_SCORE_NAME` | `web` | Vote score name |
| `CURRENCY_ICON` | `web` | Points icon |
| `CURRENCY_NAME` | `web` | Points name (one) |
| `CURRENCY_NAME_PLURAL` | `web` | Points name (many) |
| `CURRENCY_SYMBOL` | `web` | Points symbol |
| `LEGAL_CONTACT_EMAIL` | `web` | Contact e-mail |
| `LEGAL_EFFECTIVE_DATE` | `web` | Last updated |
| `LEGAL_GOVERNING_LAW` | `web` | Governing law |
| `LEGAL_OPERATOR` | `web` | Operator |
| `SITE_DESCRIPTION` | `web` | Site description |
| `SITE_HOME_HEADING` | `web` | Home heading |
| `SITE_HOME_INTRO` | `web` | Home intro |
| `SITE_ICON_SET` | `web` | Icon folder |
| `SITE_NAME` | `web`, `stream-ingest` | Site name |
| `SITE_SHORT_NAME` | `web` | Short name |
| `SITE_TAGLINE` | `web` | Share card line |
| `YOUTUBE_VOD_PLAYLIST` | `web` | VOD playlist |

**The install's identity in `.env`.** These are permanent: the chat server's name and the site's
addresses can never change. They are listed so you know not to.

| Key in `.env` | Restart | What it is |
|---|---|---|
| `COMMUNITY_LOCALPART` | `web` | Community account name |
| `MATRIX_HOMESERVER_URL` | `web` | Matrix homeserver address |
| `MATRIX_OAUTH_CLIENT_ID` | `web` | Matrix sign-in client id |
| `MATRIX_OAUTH_ISSUER` | `web` | Matrix sign-in issuer |
| `MATRIX_SERVER_NAME` | `web`, `stream-api` | Matrix server name |
| `SITE_API_ORIGIN` | `web` | API address |
| `SITE_API_WS_ORIGIN` | `web` | Live socket address |
| `SITE_ORIGIN` | `web`, `stream-ingest` | Site address |

<!-- /restart-settings -->

## Alerts from the server

The server can tell you about problems that only it can see. You do not have to open the doctor to
find them. It sends an alert when:

- the nightly backup fails;
- the weekly check that the newest backup restores fails;
- an update fails and goes back to the release before it;
- going back after a failed update does not finish, or an update stops before it finishes;
- the morning check finds less than 15 % free disk;
- the morning check finds a certificate that runs out within 14 days (direct mode only);
- the morning check finds no good backup in the last 36 hours.

Each alert says what happened and which command shows why. It never holds a password, a key or a
program's own error text.

**Choose where alerts go.** The alerts topic you set in **Admin Panel → Site → Site, card Alerts to
your phone** carries these alerts too: every problem to the urgent topic, the test alert and "working
again" notes to the quiet one (one topic takes both). If the database is down when an alert goes out, the server uses the
topic it read last. To send them somewhere else, set one or both of these in `/opt/blackbranch/.env`
(a topic here replaces the site's for these alerts). The server never prints them.

- `BB_ALERT_NTFY_URL` is an [ntfy](https://ntfy.sh) topic address, such as
  `https://ntfy.sh/<a long private topic name>`. Install the ntfy app and subscribe to the same
  topic. Anyone who knows the topic name can read it, so pick a name nobody can guess.
- `BB_ALERT_EMAIL_COMMAND` is a command on the server that sends an email. The server gives it the
  whole message on its input, headers first. For example:
  `BB_ALERT_EMAIL_COMMAND='sendmail you@example.com'`. This needs a mail program on the server, such
  as msmtp. The subject is also in `$BB_ALERT_SUBJECT`.

**Test it.** Run `sudo blackbranch alerts test`. It sends a test alert and says whether it went out.

With no topic in the Admin Panel and neither of these set, alerts only go to the server's log. Read it with `journalctl -u
blackbranch-backup` or `journalctl -u blackbranch-check`. If the server cannot reach your topic or
run your command, it says so in the log. A failed alert never stops a backup or an update.

The site's own alerts (what the site itself notices while it runs) go to the same Admin Panel topic.

