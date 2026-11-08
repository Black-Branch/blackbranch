# Changelog

What each release changed. Every release is signed and listed, with its checksum, at
<https://blackbranch.app/releases>. Black Branch is in **preview**: every release so far is a preview
on the beta channel.

## 0.1.0-preview.5, 2026-11-07

Your community's rooms run from the Admin Panel, Discord comes with the install, people can sign in
with an account they already have, and the fixes from two weeks of streams on the reference site.

Community management in the Admin Panel: the server keeps the community's rooms the way the panel
sets them, with no Matrix app needed.

- **Community page:** Admin Panel > Site > Community makes, renames, orders, moves and archives
  channels and categories. Each channel says in plain sentences who can see it and who can post in
  it, and how long it keeps messages. Encryption is offered when a channel that not everyone can see
  is made, with its costs listed first, and never changes afterwards. The roles (Admin, Staff, Mod,
  Bot, Supporter, Member, Timed out) take your own names and colours. **Last applied** shows what the
  server did, with **Check now** and **Apply now**.
- **Banner:** the Community page's **Banner** card takes a wide picture (PNG, JPEG or WebP, up to
  2 MB) that heads the channel list with the community's name over it, as a Discord server banner
  does. The server puts it on the community's space, so every app sees it; the community's icon
  stays as it is.
- **Staff:** a role between Admin and Mod, given on Site > Moderators. Staff moderate and edit
  channels; roles, who can see, how long messages are kept and encryption stay with admins.
- **The server keeps the rooms:** every 10 minutes and right after a change, as the install's own
  community account (never yours), it makes missing channels, gives each person the role they hold
  on the site in every room, invites people into the channels their role or support opens and
  removes them when they lose it, and turns site bans into room bans (a timeout makes the person
  read-only until it ends). A room ban made by hand is never lifted. A change made in Element is put
  back unless **Keep changes made in Element** (Site > Site, card Channels) is on; then it is only
  listed. A new install has this on; an updated install keeps it off until
  `sudo blackbranch community on`. `sudo blackbranch community reconcile --mode report` lists what it
  would change and changes nothing.
- **Bridge accounts:** a chat bridge's bot listed on Site > Community keeps its power and is never
  removed. A room's own claim to be bridged grants nothing.
- **Message retention:** one install setting, **Longest a channel keeps messages** (365 days by
  default, 0 for no limit, on Site > Site, card Channels). Every channel carries its own time up to
  it, and the chat server follows it at its next start.
- **Doctor:** four rows for the community: its account answers, its rooms are as the Community page
  sets them (amber when something was put back, left as it is or could not be looked after; red when
  a run failed), they were checked in the last 30 minutes, and the server keeps messages as long as
  the cap says. A failed run alerts once, and once more when a run works again.
- **Known gaps:** a change made in Element is not taken into the panel yet; a supporter enters a
  supporters' channel by accepting the community account's invite; a ban given while a run is going
  reaches the rooms on the next run, at most 10 minutes later.

Discord: the install comes with a Discord bridge, Out Of Your Element (OOYE), off until you set it
up. The page is [platforms/discord](platforms/discord.md).

- **Admin Panel > Site > Discord**, four steps: **The bot** (your own Discord application, its three
  privileged intents and its token, kept by the server and never shown again), **Import the Discord
  server** (categories, text and announcement channels and roles proposed from the server, with who
  can see and post read from Discord's permissions, never wider; forum and voice channels stay on
  Discord), **Link the Discord server** and **Links** (each room and its Discord channel).
- **On the server:** `sudo blackbranch discord on` builds and starts the bridge once the token is
  saved; `off` stops it. It never holds up an update. The bridge's page password is set for you, so
  nobody can add your bot to their own server through it.
- **The community account and the bridge** never fight: the bridge's bot is seated in the space and
  every linked room, and its Discord people are left alone. Nobody can sign up with a bridge name.
- **Doctor:** two rows, **Discord bridge** and **Discord bot sees the server**.
- **Known gaps:** a thread reply reaches Discord as a plain reply, stickers as a link, Discord files
  over 5 MB arrive as links; Discord bans are not carried; the bridge's own database is not in the
  backups yet; the panel's Bot and Import steps are tested against a stand-in Discord. The bridge
  itself carries the project's own Discord server, both ways, since 7 November.

Sign-in providers: people can sign in with an account they already have.

- **Admin Panel > Site > Site, card Sign-in providers:** Google, Discord, Twitch and one OpenID
  Connect server of your own (Authentik, Keycloak, Zitadel…), each a switch, its client id and
  secret, and the redirect URL to paste at the provider. Each one switched on is a "Continue with …"
  button on the sign-in page; saving re-renders the sign-in service ([operate.md](operate.md#sign-in-with-google-discord-twitch-or-your-own-server)).
- A user name a provider offers is only suggested, never forced onto an existing account; a Google
  name is never offered as a display name. With **Let people make accounts** off, a provider makes no
  new account. Switched off, a provider's button goes and its people keep their link for when it
  comes back; your own server's links belong to its address, so a different server starts with none.
- **Doctor:** one row per provider: offered by the sign-in service, and the provider answers (57 checks).

Mail: an install can send the sign-in service's mail.

- **Admin Panel > Site > Site, card Mail** (or `MAIL_SMTP_*` and `MAIL_FROM` in `.env`): with a mail
  server set, the sign-in page offers "Forgot password?" and a new account confirms its address by
  mail. Without one (a new install) nothing is sent and a password is reset on the server, as before.
  `sudo blackbranch mail test <address>` sends one message, and the Doctor has a **Mail** row. The
  site itself sends no email.

Accounts:

- **More than one admin:** Admin Panel > Site > Moderators, card **Admins**, with **Make admin** and
  **Remove admin**; the last admin can be neither removed nor deleted. On the server:
  `sudo blackbranch user admin <name> on|off`. Each change is in the mod log.
- **Signing out** also ends the session at the sign-in service, and the browser's encryption store is
  wiped only once the server has confirmed it. A burst of refused sessions alerts the operator once,
  naming no one.
- **Sign-in from another server** refuses this site's own server and says to use the main button.
- **A closed sign-up:** a first sign-in refused by lockdown says "New accounts are paused on this
  site right now."
- **A deleted account** whose Matrix account could not be removed is tried again every hour, with a
  Doctor row.

Moderation:

- **Ban and delete messages:** the ban step has **Delete message history**: Don't delete any (the
  default), Previous hour or Previous 7 days of the person's community messages (direct messages are
  never touched), and one Mod history row, "History deleted". **Also remove their recent messages**
  (on by default) takes their site chat from the last 24 hours, up to 250 messages. A ban takes the
  clicked line off at once; Undo lifts the ban, and removed messages stay removed.
- **Who lifts a ban:** a permanent ban placed by an admin needs an admin to lift or change it, and one
  placed by Staff needs Staff or an admin. The refusal names who placed it.
- **A new report** sends one quiet alert to the site's alert topics ("1 new report — Mod Panel ›
  Reports", with no name or reason), at most every 15 minutes, and **Reports** shows how many wait.
- **Mod history** also records identities merged, a report resolved, a held message allowed and
  history deleted.
- **A ban follows the person** across their linked platform accounts and through a merge; linking
  an account never lifts a platform-only ban.
- **Platform commands** (the pronoun commands) work from every platform. The word list no longer
  matches ordinary words through a wrong plural ending.

Chat:

- **Sending:** a retried line is never posted twice, and a message that spends points is never charged
  twice.
- **Settings > Colours > Mentions & highlights:** **Mention colour** and **Highlight colour** are two
  separate settings.
- **Admin Panel > Site > Auto-pin:** the crowd auto-pin's numbers (upvotes to pin, how that grows with
  the crowd, the most ever needed, minutes pinned) are yours to set; it never replaces a mod's pin.
- **The tab icon** has a small red dot while the stream is live.
- **The user card** has **Hide messages** and **Report** in a row under the name, away from the close
  button.
- **A tip under a typed name** shows as a plain card, with no account's picture, badges or colour; the
  payer stays on the money record.

The player:

- **Each platform's live state:** a source whose platform is offline leaves the player, and the card
  says "Live on <platform>." or "The stream has ended." A YouTube stream that is only scheduled is
  never read as live. Admins see each platform's live detection on the Stream tab's readers, and the
  Doctor has a **Live detection** row.
- **Kick** can play in the site's player, as an embed with its own switch.
- **Streamplace:** a dropped picture reconnects by itself, a busy relay says "The stream is busy" and
  tries again, and compatibility mode shows the end of a stream. **Smoother playback (adds delay)**,
  under Settings > Site & bars > Player, is off by default. Fullscreen works on Safari.

The community client:

- **A message that did not send** stays in place with **Not sent · Retry · Delete**, and "Reconnecting
  to the community…" shows when the connection is lost for more than 10 seconds.
- **Cozy** (the default layout) puts the picture beside the message, as Discord does; **Compact**
  keeps it in the name line.
- **Long-press** on a phone opens one sheet with quick reactions and every action; holding a reaction
  shows who reacted.
- **Attachments** wait above the composer (up to 10) and go with your text as the caption. Video and
  audio play in place, a failed upload says why, and a file sent in a thread stays in the thread.
- **Reply quotes** load an original that is not on screen and jump to it when tapped.
- **Polls** started in other Matrix apps show as a card; voting is in a Matrix app for now.
- **Unread channels** show a number on mentions and a dot otherwise, by default.
- **Verification:** another person's request opens a prompt with their user id beside their name.
  Making a new recovery key keeps your message backup.
- **Layout:** the message you are reading keeps its place when the panel is resized. Home reflows
  with its pane, and Active threads lead with the newest. Avatars use one size scale, with the
  platform ring centred. People bridged from Discord keep the Discord mark. A tap on an emote shows
  its name.

Direct messages:

- **One conversation per person**, listed with the last line; earlier rooms with the same person fold
  into it. A conversation is made on the first message, a partner who left is invited back, and
  typing shows. `/dm` finds people by user name or display name.

On a phone:

- **Settings > Site & bars > On a phone:** **Community text** (same as chat, or 16 px) and **Edge to
  edge**; **Return key** (sends, or new line) is under Settings > Community > Composer. Defaults are as
  before.
- The tab strip shows part of a tab that does not fit instead of hiding it. One first-run prompt shows
  at a time, and the "use a Matrix app" banner is gone.
- **Faster:** name glows no longer repaint the page, and a chat reconnect fetches only what changed.

Money:

- **Gifts:** a gift to someone already paying monthly starts when their paid month ends. A refund or
  dispute ends a gift at once; a failed refund or a won dispute gives it back; a partial refund of a
  community gift ends only what it covers. A gift is credited in the currency it was paid in.
- **Subscriptions:** one checkout per viewer, so two open tabs cannot bill twice. The first month is
  credited from its paid invoice. Stripe's last failed retry ends the subscription here too. On a
  PayPal-only site a subscriber sees "Subscribed" under the player.
- **Switching Stripe or PayPal off** asks first, with the number of subscribers and what to cancel at
  the provider.
- **Amounts** are written one way, whatever the viewer's browser language.
- **Stripe's customer portal** not yet saved is named by the Stripe Check and the Doctor.

Install and operate:

- **Updates:** the site stops cleanly while it is busy, so an update no longer waits for a forced stop.
- **Security:** the web framework and a server library updated for open advisories; requests to
  Streamplace servers refuse private addresses.

## 0.1.0-preview.4, 2026-10-22

The Admin Panel's second pass, the chat and money fixes from the first weeks of real use, and the
release behind the direct-mode (Let's Encrypt) install proof.

- **Admin Panel:** the status strip is gone. Site > Site holds Streamer, Site, Legal, Community
  (federation and "Let people make accounts"), Sign-in from other servers, Alerts to your phone,
  Running the site and Backups, with a read-only "Install values" card and the community room ids.
  The AI pages have Simple and Advanced views. Platform ids (the Twitch broadcaster id, the Kick user
  id, the Streamplace DID) are found from the channel or handle, never typed. Player is one switch
  per source; points prices are edited as prices, apart from earn rates; there is no Modules tab (each
  switch heads its own page); the OBS page lists every overlay address beside its settings; support
  tickets have a Forward to Black Branch card in place (sending them arrives in a later release); Leaderboard settings and an Emotes page exist; the Updates
  page shows the feed's release notes; the Doctor's header is three lines.
- **Setup pages:** OBS setup left the wizard. Every page links its guide on blackbranch.app. Each
  pasted value has a Check button. Streamplace asks for the handle only. Ko-fi, Patreon and Streamlabs
  are donation pages, each optional.
- **Chat:** a platform's refusal reaches the sender in the platform's own words, while a network or
  server failure stays silent. A chat connection that has gone quiet is dropped and reopened after 90
  seconds. The help desk's greeting brings the chat on screen on a phone. The compact tab bar hides
  while a chat window is open. A moderator's message menu reaches poll cards and highlighted messages.
  A tip card keeps the name the tipper typed. The help desk's facts follow the module switches, and
  it knows that voting exists.
- **Money:** a message written in another script is no longer posted twice. A YouTube gift of ten
  memberships counts ten; Super Chat, Super Sticker and membership events are each paid once. A card
  with no author can be pinned. A card subscription bought while a gifted one is running starts
  billing when the gift ends; a Stripe subscription set to cancel reads as "renewal off"; a trial is
  not a payment, and a trial that ends unpaid never entitles.
- **Sign-in:** an account on the site's own homeserver always refreshes its session through the
  site's own client, so a stale record can no longer sign it out every few minutes.
- **Install and operate:** the community rooms are checked at every start, boot and restore. The
  Forums reader account is made at install. The settings that apply only at a restart are listed from
  the schema by `blackbranch help` and `blackbranch status`. The server alerts its operator (an ntfy
  topic or an email command) when a backup or restore check fails, an update goes back, the disk runs
  low, or a certificate is near expiry. A chat reader switched off reports it at once. The one-line
  install is `curl -fsSL https://blackbranch.app/install.sh | sudo bash`. A site that sells its
  subscription through PayPal only shows the Subscribe button.

## 0.1.0-preview.3, 2026-10-21

The first release that makes the promised features work on a new install, and the first one most
installs receive as an update.

- **Subscriptions:** the Supporter subscription can be sold through Stripe (set its price in Admin
  Panel → Payments → Connections → Stripe) and through PayPal (a monthly billing plan in
  **Subscription plans**). The price and currency shown on the site come from Stripe or PayPal, and a
  gift costs what the subscription costs. A viewer who pays through both is warned before paying twice.
- **Spoken alerts:** text-to-speech has its own switch and voices in Admin Panel → Utility → TTS, and
  the Doctor checks that the key and a voice are set.
- **Overlays:** four OBS browser sources for any install (alerts, support bar, support meter and a
  "support the stream" reminder), listed with their addresses in Admin Panel → Utility → Overlays.
- **YouTube:** the chat reader runs inside the install (the chat image carries its own browser), and a
  reader that fails to start shows in the Doctor, in `status` and on the Stream tab.
- **Kick:** the chatroom and channel ids can be set by hand when Kick's protection blocks the lookup;
  a refused copy to Kick is explained to the viewer.
- **Forums:** setup makes a `#forum` room. News and its tab stay hidden until a feed has items.
- **Setup pages:** a time zone list, an icon upload, a Check button for each pasted value, the
  streamer's display name, a donate link, and Ko-fi, Patreon and Streamlabs as separate choices. OBS
  setup moved to the Admin Panel.
- **Install and updates:** Docker Compose 2.20 or newer and an IPv4 route to the image registry are
  checked before anything changes; Docker's own failures end in a reason and the next step; commands
  in hints print `sudo`; a tunnel-mode site can move to a new server with `--moving`; an update's
  front-door check asks the server itself, so a home router does not roll it back; a release rolled
  back only because a chat reader failed is tried again on the next nights, three times in all.
- **Moderation:** a ban stops a chatter's platform lines at once; the account-age lever never holds a
  platform it cannot check, and says which; a ban of something that is not an account is refused in
  words.
- **Security:** a review of the payment and subscription paths (paid-for access only, one subscribe at
  a time, a price floor that fails closed), the chat service's health address bound to the server
  itself, and a voice id sent as one encoded part of the address.

## 0.1.0-preview.2, 2026-10-21

Security and correctness fixes found by code scanning; nothing changes in how the site looks or is set up.

- Overlays: values arriving over the live socket reach the poll and sticker pages as plain text, and
  only `https:` addresses are used as images.
- Twitch: a chat-event reconnect is followed only to Twitch's own address.
- Sign-in: the bearer token is read in time proportional to its length.
- Emotes are recognised by the address's host, not by a part of the address.
- Chat: a YouTube link is unwrapped only from YouTube's own redirect; scraped link previews decode
  their text in one pass and check a post id where the address is built.
- The HTML sanitizer is updated to 2.18.1 (three advisories fixed).

## 0.1.0-preview.1, 2026-10-20

The first signed release: the install bundle, the setup pages, the prebuilt site image, signed
self-updates with automatic rollback, nightly backups with a weekly restore test, and the doctor.
