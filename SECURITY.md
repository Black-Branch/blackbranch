# Security

## Reporting a vulnerability

**Please report security problems privately**, not in a public issue: email
**security@blackbranch.app**
with what you found, how to reproduce it, and the release it affects (`blackbranch status` shows it).

We aim to answer within three days, to agree a fix and a date with you, and to credit you in the
release notes unless you would rather not be named. Please give us a reasonable time to ship a fix
before you publish details.

What we especially want to hear about: anything that lets a site visitor, a chat user or a moderator
do more than their role allows; any way to read a secret from `/opt/blackbranch/.env` or the database;
any way for the site to make the server run something other than its fixed actions; anything that
gets around the signature check on updates; and secrets or personal data in this repository.

## Which versions get security fixes

Black Branch releases come on two channels (`blackbranch update --channel stable|beta`):

| Channel | Gets security releases |
|---|---|
| **stable** | yes — the newest stable release |
| **beta** | yes — the newest beta release |

A fix ships as a new release on each channel, marked as a **security release**. An install applies a
security release by itself at its quiet hour, never while the stream is live, so a box that is up to
date on either channel needs nothing from you. Older releases are not patched: update to the newest
release on your channel.

## How releases are protected

Installing from a clone of this repository trusts what you cloned: check that it is the project's own
repository before you run the installer. From then on, updates are checked:

every release is listed in a feed signed with the project's release key; an install checks that
signature with the public key it was installed with (`install/release-key.pub`), and checks the
release's source against the sha256 the signed feed names. Every third-party image is pinned by
digest. An install refuses an unsigned or expired feed, an older release, and a release for another
channel.
