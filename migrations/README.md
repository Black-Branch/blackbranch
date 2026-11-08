# migrations/

The database's schema changes, one file per version: `migrate-vN.sql`, applied in order, each in one
transaction, each recording itself in `public.schema_migrations`.

**Why the public repository starts at v147.** A new install never replays the whole history: it is
built from [`baseline/`](baseline/README.md) — the schema the history leaves, generated, plus the few
rows the product cannot run without — and then takes every migration newer than the baseline. The
first baseline ever released was v146, so an install may have started there; every migration after
it (v147 onward) is kept, because such an install still needs them. The older history the baseline
was generated from stays with the maintainers.

`../install/migrate.sh` is the runner: the baseline on an empty database, then each newer migration
the database does not record yet. A new migration lands in the same commit as a regenerated baseline,
and must apply both to a database built by the full history and to one that started from the
baseline — [`baseline/README.md`](baseline/README.md) has the rules and the check.

## Writing a migration

- **`public.schema_migrations` is the source of truth for what has been applied** — query it, never
  guess. (In the maintainers' full history it was created by v75, which back-filled every earlier
  version, so it answers from v2 onward; there is no v1 — the history's bootstrap file fills that slot.)
- **Every migration ends by recording itself:**
  `INSERT INTO public.schema_migrations (version, note) VALUES (…) ON CONFLICT DO NOTHING;`
- **Regenerate the baseline in the same commit:** `node tools/check-baseline.mjs --generate`
  rewrites `baseline/schema.sql` (generated — never hand-edited); `seed.sql` is hand-kept.
  `stream-api/baseline-gate.test.mjs` (Docker; fails, never skips, in CI) diffs chain against
  baseline and stays red until you do. The migration must apply to both.
- **Prove it rebuilds** (maintainers, full history): replay the bootstrap + every migration into a throwaway
  `pgvector/pgvector:pg18` container and diff `information_schema.columns` against the live
  database. That is how a migration's lost columns and another's silent failure were found. A
  column diff says WHICH columns differ, not why — anti-join `schema_migrations` before calling
  anything drift.

## Columns waiting to be dropped

Emptied first, dropped in a later migration, so a deploy that still names a column never meets
one that is gone:

- **`site.users.mx_access_token`, `mx_refresh_token`, `mx_token_expires`, `mx_device_id`** — the
  June-era Matrix token columns, superseded by `site.user_sessions` (v24) and emptied by v169. The
  drop migration also deletes `web/scripts/encrypt-tokens.mjs` (it encrypts only these columns) and
  the nulling of them in `web/app/lib/accountDeletion.ts`.

## Applied migrations whose words outlived their design

An applied migration is never edited, so its header and its `COMMENT ON` text can describe a design
that changed after it shipped. The current truth for each:

- **v166 `site.community_unbans`.** Its header and table comment say the community reconciler's
  feed lists the people lifted since the last apply run and lifts their room bans from that list.
  It does not: the reconciler lifts a room ban when the ban's reason is the site's marker and the
  person is no longer banned, and the feed carries no `unbanned` list. The table is an audit log of
  lifted permanent bans (who lifted whom, when), written by `LIFT_BAN_SQL`
  (`web/app/lib/community/unbans.ts`) and pruned there after 30 days. Nothing reads it to act.
