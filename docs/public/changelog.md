# Changelog

What each release changed. Every release is signed and listed, with its checksum, at
<https://blackbranch.app/releases>. Black Branch is in **preview**: every release so far is a preview
on the beta channel.

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
  tickets can be forwarded to Black Branch; Leaderboard settings and an Emotes page exist; the Updates
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
  not a payment and grants nothing until the first charge succeeds.
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
