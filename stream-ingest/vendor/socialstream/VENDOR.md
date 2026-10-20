# Vendored Social Stream Ninja code

Source: https://github.com/steveseguin/social_stream
Pinned commit: `b2e6ba63ee805a6c90a90bc867cdeb2b7578e87c`

Copied, with **local extensions** marked in the file by `Local extension` comments (the
`MONETIZATION` and `MODERATION` events and their handlers, and the caught disconnect promise in
`teardownClient`; everything else is upstream's):

- `providers/twitch/chatClient.js` — `createTwitchChatClient()` / `createTmiClientFactory()`.
  Used directly by `platforms/twitch.js` (wraps npm `tmi.js`).

Nothing else is vendored: `platforms/kick.js` is a self-contained Pusher client whose
`App\Events\ChatMessageEvent` parsing follows upstream's `lite/plugins/kickPlugin.js`.

To update: re-clone the repo, copy the files, re-apply the marked local extensions, and bump the
commit hash above. Keep any further change a marked local extension, so upstream diffs still apply.

Licence: upstream Social Stream Ninja is GPL-3.0, and this file stays GPL-3.0. The rest of the
project is AGPL-3.0; the two licences' section 13 permits combining them, each part keeping its
own licence.
