# Running your install

Everything here is done on the server with the `blackbranch` command, or in the site's Admin Panel.
The command needs root: run it with `sudo` from your usual account, as every recipe below does. (Without
`sudo` it answers "the install at /opt/blackbranch is root's: run it with sudo".) It works even when
the site is down — that is why it exists.

```
sudo blackbranch status                 what runs, which release, the last backup and update check
sudo blackbranch doctor [--report]      check the install (exit 1 when a check fails)
sudo blackbranch logs <service> [-f]    recent logs: postgres, stream-api, stream-ingest, web, caddy, synapse, mas
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

**The doctor shows; it does not send.** A failing check — a Stripe or PayPal webhook that is
missing, switched off or lacks an event, say — turns red when you open the doctor or run it (the
Admin Panel's Stream tab counts the same verdicts when you open it), and nowhere else: this release
sends no message, email or push about it. The same goes for a payment that failed, was refunded or
disputed: it is listed in **Admin Panel → Payments → Payment history**, and nothing else tells you.
Look at both now and then, and after any change at Stripe or PayPal.

When you ask for help, attach `sudo blackbranch doctor --report`: it writes a report next to `.env` with
the release, the module switches and every check — no secret, no chat text, no viewer id and no
domain. Before it keeps the file it searches it for every value in `.env` and refuses if it finds one.

## Ending a stream

**End each stream on the site when you stop.** The site marks you live when a platform says so, but
it does not yet notice every stream ending by itself: until you end it, the site keeps showing you
as live (the live player, the timer, watch points). End it from the site — type `/stream end` in the
site's chat (the admin and moderators can), or press **Force offline** in the stream page's
**Community embeds** window.

## Backups and restores

**What is backed up:** the three databases (the site, the chat server, its sign-in service), the chat
server's media and its **signing key**, and the install's own files: `.env`, the sign-in service's
keys and the tunnel's credentials. Backups are [restic](https://restic.net) snapshots, encrypted with
the **backup passphrase** from your recovery sheet.

**When:** every night at the quiet hour, and before every update. Every Sunday, half an hour after the
backup, the server checks that the newest backup really restores. Both results are on the doctor.
Kept: 7 daily and 4 weekly snapshots (Admin Panel → Site → Backups).

**Where:** set on setup's last page, changed in the Admin Panel: this server
(`/opt/blackbranch/backups/`), an S3-compatible bucket, or an SFTP server (put the key
`sudo blackbranch backup key` prints into that account's `authorized_keys`). Note: a backup on the same disk
does not survive losing the server — add a bucket or another server.

- A bucket must exist before the first backup (create it at the provider — Black Branch never creates
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
2. Make the backups reachable: a local target — copy the backups folder you kept into
   `/opt/blackbranch/backups/` (a plain folder of encrypted files); an SFTP server — add the new
   server's key (`sudo blackbranch backup key`) to that account first.
3. `sudo blackbranch restore latest --with-env` — for a bucket or SFTP server add `--from <its address>`
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
| **The recovery sheet** | The backup passphrase (and where `.env` lives), shown once on setup's second page. | You, off the server. `.env` holds it too. | The install's backups. Nothing else — it is not anyone's chat key. |
| **A member's recovery key** | A long code their own browser makes when they set up encryption: a random key, written out in an encoded form so it can be copied. Encoded is not hidden — **it is a secret**, like a password, and nobody should ask for it. | That member alone. The server never receives it. | Their encrypted messages' keys on a new device, and the key backup below. |
| **The key backup** | The keys to a member's encrypted messages, kept on the chat server encrypted; the key that opens them is stored there too, **locked with the member's recovery key**. | The chat server, so it is inside your install's backups — still locked. | Is read only with that member's recovery key, or from one of their verified devices. |
| **Device verification** | Confirming a new browser or phone from one already signed in, by comparing emoji on both. | The member's devices. | Passes the keys from the old device to the new one. |

Encrypted here means direct messages started on the site (they are encrypted from the start; one
opened from another Matrix app may not be) and any room someone has switched encryption on in.

**After you restore a backup** (from this server, a bucket or SFTP), accounts, rooms and messages are
back as of that snapshot; encrypted messages come back still encrypted, and each member's key backup
comes back still locked. A member reads their old encrypted messages again with a device that still
holds the keys, or with their recovery key. Nothing you hold — not the passphrase, not `.env`, not the
backup — can unlock them for someone.

**A member who loses every signed-in device and their recovery key** cannot read their earlier
encrypted messages again, and no restore changes that. They can start fresh from their encryption
settings (new keys, new recovery key) and go on; new messages work as before. The site keeps no copy
of anyone's recovery key, and offers no place to store one: a member who wants a spare keeps it
themselves, in a password manager.

## Updates and rollback

A **release** is one version number that pins everything on the server: the source of the site and
its services (checked by its sha256) and every other piece — database, chat server, sign-in service,
router, tunnel, backup tool — by digest. The project announces releases in a **signed feed**; your
server checks the signature with the key it was installed with, and refuses a feed signed by anyone
else, an older release, an expired feed and any release that would move the database to a new
Postgres major version (that is always its own announced step).

**When:** every night, 45 minutes after the quiet hour, the server reads the feed.
- A **security release** applies itself then — **never while you are live**: it waits, checking every
  minute, until the stream ends (up to six hours; after that, the next night).
- A **feature release** waits for you: **Admin Panel → Updates** shows it with an **Apply** button, or
  run `sudo blackbranch update`.
- `sudo blackbranch update --check` only looks; `--dry-run` also downloads and checks the release and
  changes nothing.

**What an update does:** downloads and checks the release; updates `.env` for it on a copy (and stops,
naming the setting, if something is not understood); fetches its images — the site's is prebuilt —
and tries the new site beside the running one; then stops the site (usually for well under a minute), **backs up**, switches
to the new release, starts it, and runs a health check — the doctor's checks, a live chat connection
and a sign-in round trip — then restarts the services twice and checks again.
The front door is checked on the server itself (in direct mode, at its own port 443 by each name),
so a home router that cannot reach its own public address from inside does not roll an update back.
Whether the site answers **from outside** is the doctor's "Reachable from outside" row: a warning,
because from inside many home networks it cannot succeed — open the site on a phone with Wi-Fi off
to be sure.

**Rollback is automatic:** if anything fails after the stop, the server goes back to the previous
release, its `.env`, and the databases and media from the backup it made just before, then checks
health again. Both results show on the Admin Panel and in `sudo blackbranch status`. A release that rolled
back is not retried by the nightly timer.

**Channels:** `stable` (the default) or `beta` (earlier releases, for people who want to help test):
`sudo blackbranch update --channel beta`. Every release so far is a preview on `beta`, and `stable` has
none yet; a server installed with the one-line form already follows `beta`.

## Password resets

The site does not send email yet, so a forgotten password is reset on the server, through the chat
server's sign-in service:

```bash
read -rs NEWPW && sudo docker compose --project-directory /opt/blackbranch exec mas mas-cli manage set-password <username> "$NEWPW"; unset NEWPW
```

(`read -rs` keeps the password out of your shell history.) A `sudo blackbranch user reset-password`
command comes in a later release.

## Changing the site's name and other display values

The site's name, its legal details and the points names live in `/opt/blackbranch/.env`, and the site
reads them when it starts. The setup pages set them; afterwards change one on the server with
`sudo blackbranch set SITE_NAME "New name"` — the site restarts with it (a few seconds), and goes back to the
old value by itself if it does not come back healthy. The domain and the chat server's name can never
change.

**Your own icons:** put `icon.png` (512 px), `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` and
`apple-touch-icon.png` (180 px) in `/opt/blackbranch/site-files/`, then `sudo blackbranch set SITE_ICON_SET
/site-files`. A points icon goes there too: `sudo blackbranch set CURRENCY_ICON /site-files/<file>`. The
folder is yours: it is not in the backups, so keep your own copy of what you put there.

## Who can do what: viewers, moderators and the admin

The admin is the account made on setup's first page. The admin makes and removes moderators (the
`/setmod` and `/unsetmod` chat commands); the site has no way to make a second admin. Every line
below is checked by the server, not only hidden from the page. A moderator cannot ban, time out,
clear or merge the admin.

| | Viewer | Moderator | Admin |
|---|---|---|---|
| Chat, vote, read the public chat history (deleted messages left out) | yes | yes | yes |
| Delete messages; time out, ban and unban; clear a person's recent messages — on the site, and on Twitch, Kick or YouTube where the site can | — | yes | yes |
| Read chat messages sent for supporters only | supporters | yes | yes |
| Start a poll, and end their own | supporters | yes | yes |
| End or extend anyone's poll, pin a chat message, post an announcement | — | yes | yes |
| Slow mode, closing sign-ups during a raid, the link gate, blocklist words, switching the AI automod on or off, reviewing held messages | — | yes | yes |
| **Search the whole chat history, deleted messages included**; the moderation log; whether an action reached each platform; user reports and support tickets | — | yes | yes |
| **A person's details:** their names on every platform, how much they chat, when they were first seen, the chat bot's notes on them (when a bot runs), suspicious-account marks; set their pronouns | — | yes | yes |
| **Merge two chat identities into one person** (permanent — there is no unmerge) | — | yes | yes |
| Stream controls: the timer, resetting the support bar and timer, forcing the site offline, the community embeds and the videos shown while nobody is live, refreshing emotes | — | yes | yes |
| Highlight a message on stream, pin forum posts, define badges, house looks, store and style prices, force-rebuilding the emotes | — | — | yes |
| Payment history; forgetting a person's AI memory | — | — | yes |
| Make or remove moderators; the list of moderators | — | — | yes |
| The Admin Panel: every setting and credential, module switches, AI settings, the Doctor, Updates, restarting services, the OBS rig page, points, the Stream tab | — | — | yes |

A moderator here is a site role only: it gives no power in the chat server's rooms, which keep their
own room permissions.

## Payments: what each provider does

| | Stripe (cards) | PayPal / Venmo | Ko-fi | Patreon | Streamlabs |
|---|---|---|---|---|---|
| A recurring site membership (supporter perks, renewing) | yes | — | — | — | — |
| Gift a membership to someone, or to recent chatters | yes | — | — | — | — |
| A one-time tip, announced on stream | yes | yes | yes | — | yes |
| Buying points | yes | yes | — | — | — |
| How it reaches the site | the site's own checkout | the site's own button | Ko-fi's webhook | Patreon's webhook | Streamlabs' live feed |

- **Only Stripe makes someone a supporter here.** A Stripe subscription or a gift sub is the one
  thing the site's supporter perks are read from. Subscriptions renew and cancel through Stripe,
  and a viewer manages theirs in Stripe's billing portal.
- **PayPal is one-time payments only:** a tip or a points purchase. Venmo shows only when PayPal
  finds the buyer eligible — in practice a US business account and a US buyer paying in dollars.
- **A signed-in tipper also gets points for the tip**, with either Stripe or PayPal; a refund or a
  lost dispute takes them back. Buying points needs an account; a tip does not.
- **Ko-fi, Patreon and Streamlabs bring events in; they grant nothing on the site.** Each event
  becomes an alert on stream, moves the support bar and is listed in Payment history. Ko-fi sends
  each tip and each membership payment; Patreon sends a new pledge only (not renewals or
  cancellations); Streamlabs sends tips. A Ko-fi or Patreon member is not a supporter on the site.
- No Stripe? **Admin Panel → Payments → Connections → Outside subscribe link** sends the Subscribe
  button to a page of your choice (your Patreon, say). It is only a link: nothing comes back from it.

## Moving to a bigger server

A move is a restore onto a new server:

1. On the old server: `sudo blackbranch backup` (a fresh snapshot), then stop it:
   `sudo docker compose --project-directory /opt/blackbranch stop`.
2. Get the backup repository onto the new server. A local target: copy `/opt/blackbranch/backups/`
   across (`sudo rsync -a`). A bucket or SFTP target: copy the repository folder from there into
   `/opt/blackbranch/backups/restic/` on the new server (it is a plain folder of encrypted files).
3. On the new server, install with **the same domain** and the same front door, adding `--moving`:
   `… install.sh --domain example.com --mode tunnel --moving` (or `--mode direct`). It installs
   everything but starts nothing, makes no tunnel and prints no setup link — the restore brings all
   of that back.
4. `sudo blackbranch restore latest --with-env` — it takes the snapshot's `.env` (your secrets) as well as
   the data, then starts the site. (A bucket or SFTP target can be read directly: add `--from <its address>`.)
5. The front door:
   - **Tunnel mode:** nothing to change. The restore brings back the site's own tunnel, which now
     connects from the new server; its DNS records already point at it. (Keep the old server stopped:
     two servers on one tunnel would both answer.)
   - **Direct mode:** point the three DNS records at the new server.

   Then check `sudo blackbranch doctor`.

**If the installer already made a new tunnel** (you installed without `--moving`): the restore keeps
the new server's own tunnel and says so — its routes are the ones in place. Delete the old tunnel in
Cloudflare's dashboard (Zero Trust → Networks → Tunnels) once the old server is gone. **If you deleted
the old tunnel before restoring** and the site's own is gone: make a tunnel in the dashboard, route
the three names to `http://caddy:80`, and give the new server its token —
`sudo /opt/blackbranch/release/install/install.sh --tunnel-token` (or `--tunnel-token-file <file>`);
it replaces the signed-in tunnel with that one.

Note: this path is built and its refusals are tested, but the project has not yet rehearsed a whole move
on two fresh servers. Try it on a spare server first, and keep the old one until the new one is green.

## Bigger server, same box

Adding memory or disk to the same server needs nothing from Black Branch: shut it down, resize, start
it. Everything comes back on its own.
