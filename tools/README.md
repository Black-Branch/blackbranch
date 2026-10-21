# tools/

The repository's own checks, generators and release tool. Run each from the repository root.

| File | What it is |
|---|---|
| `check-orphans.mjs` | The dead-export gate for `stream-api/` and `stream-ingest/`: an export nothing imports fails `npm run check:all`. |
| `check-owner-literals.mjs` | The literal gate: no private-network address, home folder, personal email address or live key in the code; `--tree <dir>` holds a whole tree at zero. |
| `literals.json` | The literal gate's configuration: the patterns it looks for, and every exclusion with its reason. |
| `owner-literals.baseline.json` | The literal gate's per-file counts, which may only go down. |
| `check-owner-seam.mjs` | The plugin-seam gate: each package reaches an optional plugin folder through one file only, so it builds and runs without one. |
| `gen-instance-schema.mjs` | Writes each package's generated copies of the shared lists in `config/` (the settings schema, the doctor's checks, the AI adapter); `--check` fails when a copy differs. |
| `gen-platform-docs.mjs` | Writes `docs/public/platforms/*.md` from the setup lists in `config/`; `--check` fails when a page differs. |
| `check-migration-commit.mjs` | Fails when anything follows a migration's own `COMMIT`. |
| `release.mjs` | Cuts a signed release: the source tarball, the signed feed and the one-line installer. |
| `secrets-scan.sh` | Scans a directory for secrets with gitleaks, pinned by version and checksum. |
| `public-suites.sh` | Runs every package's test suite the way CI does, with no production database in reach. |
