# Licences of the software the bundle builds

Black Branch itself is under the GNU Affero General Public License, version 3 only (see the
repository's LICENSE). This page lists the software an install **builds on its own server** from
someone else's source, with that software's licence and where its source is.

## Out Of Your Element (the Discord bridge)

- **What it is:** the bridge between your Discord server and your site's chat. It runs only when the
  Discord bridge is switched on (`discord` in `COMPOSE_PROFILES`).
- **Licence:** GNU Affero General Public License, version 3 or later (`AGPL-3.0-or-later`).
  Copyright Cadence and its contributors. The licence text is the file `COPYING` in its source, and
  it stays in the bridge's image at `/opt/ooye/COPYING`.
- **Source:** <https://gitdab.com/cadence/out-of-your-element>, tag `v3.7`, commit
  `2430d60809f6fb914258a64ba07c735831c729b0`. Your server downloads exactly that commit when it builds
  the bridge (`install/ooye/Dockerfile`) and refuses to build if the tag names any other. Black Branch
  does not change its code: the two files beside it in the image (`install/ooye/entrypoint.js` and
  `install/ooye/init.js`, which start it and do the part of its setup that needs no Discord
  application) are Black Branch's own, under Black Branch's licence.
- **Your part, if you change it:** the bridge's web page is reachable by the people who use your
  site, so if you run a changed copy, the AGPL asks you to offer them the source of your changed
  version. Unchanged, the link above is that source.
- **The bot's description:** the bridge's author asks that the Discord bot's description says
  **Powered by OOYE** (the bridge's own setup checks for it). Put it in the description of your bot
  in the Discord Developer Portal.
