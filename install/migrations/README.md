# `.env` migrations

An install's values and secrets live in one file, `/opt/blackbranch/.env`. A release that renames,
adds or retires one of its keys carries a numbered script here that rewrites `.env` — the same idea
as a database migration.

- **Name:** `NNN-what-it-does.sh`, three digits, the next free number. Never renumber or edit one that
  has shipped; fix it with a new one.
- **Body:** source `lib.sh` and use its helpers — `envm_add KEY VALUE`, `envm_rename OLD NEW`,
  `envm_drop KEY` (`envm_has`, `envm_get` to read). Each is safe to repeat. Never print a value.
- **Applied:** `.env`'s `BB_ENV_VERSION` is the last number applied. `blackbranch up` (so the
  installer) applies the newer ones; an update first runs them on a copy (a dry run), and refuses to
  start if the result holds a key this release's `install/.env.example` does not know, or lacks one
  it needs — naming the key.
- **Every key** the release reads must be in `install/.env.example` and in the `.env` that
  `install/install.sh` writes; a new install starts at the newest `BB_ENV_VERSION`.
