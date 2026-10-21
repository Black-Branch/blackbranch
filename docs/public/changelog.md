# Changelog

What each release changed. Every release is signed and listed, with its checksum, at
<https://blackbranch.app/releases>. Black Branch is in **preview**: every release so far is a preview
on the beta channel.

## 0.1.0-preview.2 — 2026-10-21

Security and correctness fixes found by code scanning; nothing changes in how the site looks or is set up.

- Overlays: values arriving over the live socket reach the poll and sticker pages as plain text, and
  only `https:` addresses are used as images.
- Twitch: a chat-event reconnect is followed only to Twitch's own address.
- Sign-in: the bearer token is read in time proportional to its length.
- Emotes are recognised by the address's host, not by a part of the address.
- Chat: a YouTube link is unwrapped only from YouTube's own redirect; scraped link previews decode
  their text in one pass and check a post id where the address is built.
- The HTML sanitizer is updated to 2.18.1 (three advisories fixed).

## 0.1.0-preview.1 — 2026-10-20

The first signed release: the install bundle, the setup pages, the prebuilt site image, signed
self-updates with automatic rollback, nightly backups with a weekly restore test, and the doctor.
