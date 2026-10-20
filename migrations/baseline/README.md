# The fresh-install baseline

A new install's database is built from two files, never from the migration history:

| File | What it is |
|---|---|
| `schema.sql` | The schema a full replay of `../schema.sql` + every `../migrate-vN.sql` leaves, with **no data**, plus one `schema_migrations` row per version (note `baseline`). **Generated — never edited by hand.** |
| `seed.sql` | The only rows a new install starts with. Each is one the product cannot run without, and each is neutral: its key and the schema's column defaults, nothing else. |

Applied once, to an empty database, in that order; then every migration newer than the
baseline's last version. A database that already holds a schema takes migrations, never a second
baseline.

## In the public repository

The migration history the baseline is generated from, and its generator and check
(`tools/check-baseline.mjs`, `stream-api/baseline-gate.test.mjs`), are kept by the maintainers: the
public repository carries this baseline and every migration after it, and the two sections below run
in the maintainers' CI. What holds here too: every migration must apply to a database that started
from this baseline — `tools/public-suites.sh` builds one from it for the database tests, the way
`install/migrate.sh` builds an install's.

## The rule: a new migration lands with a regenerated baseline

The check fails while any `migrate-vN.sql` is newer than the baseline. In the commit that adds a
migration, run

```bash
node tools/check-baseline.mjs --generate     # or, from stream-api/: npm run baseline:generate
```

and commit the rewritten `schema.sql` with it. Generation replays the chain into a throwaway
`pgvector/pgvector:pg18` container (Docker required) and writes the dump; it is deterministic, so
regenerating an up-to-date baseline changes nothing.

Before that, the same failing run has already told you whether the new migration applies to a
database that started from the baseline: newer migrations are applied to it and the two
databases diffed. **Every migration must work on both** — a long-lived database built by the chain
and an install that began here. A migration that writes rows only one install should have (a person, a
channel, a price) does not belong in the shared chain.

A migration's own `COMMIT;` (if it has one) must be its **last statement**. `install/migrate.sh`
applies each file in one transaction, and a file's COMMIT ends that transaction: whatever follows it
runs outside any, so a failure there leaves the migration half applied. `node
tools/check-migration-commit.mjs` holds every migration to this (the install suite runs it).

If a migration adds a row the product genuinely cannot run without (a settings singleton read
with `UPDATE … WHERE id = 1`, say), add the same neutral row to `seed.sql`. The check compares
each seed row with the row the chain wrote and fails on any difference.

## The check

```bash
node tools/check-baseline.mjs                # or, from stream-api/: npm run baseline:check
```

In one throwaway container it builds two databases — the chain, and baseline + seed + newer
migrations — and:

1. **Seed census:** after baseline + seed, the only tables with rows are `schema_migrations` and
   the seed's own tables (one row each).
2. **Equivalence:** relations, columns (type, nullability, default, identity, generation, order),
   indexes, constraints, extensions, functions, triggers, views, sequences, enums, the seed rows
   and the `schema_migrations` version set are compared: zero differences.
3. **A new migration on both:** a probe migration is applied to both and the comparison must stay
   at zero.
4. **Staleness:** any migration newer than the baseline fails the check until regenerated.

CI runs it in the `stream-api` job through `baseline-gate.test.mjs`, which fails — never skips —
when Docker is missing in CI. The owner-literal ratchet holds this folder at zero.

## Seed decisions (v142, measured)

A full replay of the chain into an empty database leaves rows in these tables:

| Table | Rows | Decision | Why |
|---|---|---|---|
| `public.schema_migrations` | 141 | baseline | written by `schema.sql` itself |
| `site.chat_settings` | 1 | **seed** | slow mode is saved with `UPDATE … WHERE id = 1`; no row, no slow mode |
| `site.lockdown` | 1 | **seed** | the link-gate setting is saved with `UPDATE … WHERE id = 1` |
| `stream.timer_state` | 1 | **seed** | the timer is saved with `UPDATE … WHERE id = 1`; values are column defaults |
| `site.store_prices` | 5 | dropped — fills itself | prices are an install's own; the app writes its defaults into an empty store |
| `site.store_price_state` | 1 | dropped — fills itself | written by the app with the store defaults |
| `site.badges` | 1 | dropped — install data | badge art is an install's own; billing grants no subscriber badge until an admin flags one |
| `site.badge_slots` | 2 | dropped — install data | rows for one install's accounts |
| `site.badge_unlocks` | 2 | dropped — install data | rows for one install's accounts |
| `site.community_embeds` | 4 | dropped — install data | one install's featured channels |
