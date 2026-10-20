# Contributing

Thank you for wanting to help.

## Reporting a bug

Open an issue with the **Bug report** template. Please attach the doctor's report — on the server:

```bash
sudo blackbranch doctor --report
```

It writes `doctor-report-<time>.txt` next to `/opt/blackbranch/.env`, with the release, the module
switches and every check. It holds **no secret, no chat text, no viewer id and no domain** (the
command checks that before it keeps the file), so it is safe to attach. Please do not paste anything
from `.env`, and do not post a security problem in an issue — see [SECURITY.md](SECURITY.md).

## Help with setup

Open an issue with the **Setup help** template: what you ran, what you expected and what happened,
and the doctor's report if the installer got far enough to install `blackbranch`.

## Asking for a feature

Open an issue with the **Feature request** template: what you want to do on your stream or in your
community, and what gets in the way today. The problem matters more to us than a proposed design.

## Code contributions

**Not open yet.** Outside code contributions open once the contributor paperwork is settled; until
then we cannot accept pull requests, however good. Bug reports and feature requests are the most
useful help right now, and they shape what gets built.

## How the code is held to account

If you read the code: every package runs `npm run check:all` (linters, the dead-export gate, the
literal gate, the generated-file checks) and its own test suite, and CI runs them on every push with
no production database anywhere in reach. The whole tree is held at zero literals by
`node tools/check-owner-literals.mjs --tree` — no private-network address, home folder, personal
email address or live key in any file — and scanned for secrets by `tools/secrets-scan.sh`.
