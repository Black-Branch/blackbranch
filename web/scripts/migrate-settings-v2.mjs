#!/usr/bin/env node
// One-off: convert every saved settings blob to layout v2. The web app already
// converts on every read and write, so this only makes the STORED rows match —
// run it after the v2 web deploy has been stable for a day, never before.
//
// DRY RUN by default: prints each row that would change and the totals, then
// rolls back. Apply with:  node scripts/migrate-settings-v2.mjs --apply
// Uses $DATABASE_URL — the database whose rows are converted.
//
// Column list verified against migrations/migrate-v33.sql + migrate-v79.sql:
//   site.user_settings:   matrix_id, device_class, settings, updated_at  (PK matrix_id+device_class)
//   site.setting_presets: matrix_id, slot, name, settings, updated_at   (PK matrix_id+slot)
// Both tables DO have updated_at, so both UPDATEs stamp it.
import pg from "pg";
import { migrateSettingsBlob } from "../app/lib/settingsMigrate.ts";

const apply = process.argv.includes("--apply");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const stats = { settings: 0, settingsChanged: 0, presets: 0, presetsChanged: 0 };
const diff = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k] ?? "∅"} → ${b[k] ?? "∅"}`);
};
try {
  await client.query("BEGIN");
  const s = await client.query("SELECT matrix_id, device_class, settings FROM site.user_settings FOR UPDATE");
  for (const r of s.rows) {
    stats.settings++;
    const next = migrateSettingsBlob(r.settings ?? {});
    const d = diff(r.settings ?? {}, next);
    if (d.length === 0) continue;
    stats.settingsChanged++;
    console.log(`user_settings ${r.device_class} [${stats.settings}]  ${d.join(" · ")}`);
    await client.query(
      "UPDATE site.user_settings SET settings = $3::jsonb, updated_at = now() WHERE matrix_id = $1 AND device_class = $2",
      [r.matrix_id, r.device_class, JSON.stringify(next)]);
  }
  const p = await client.query("SELECT matrix_id, slot, settings FROM site.setting_presets FOR UPDATE");
  for (const r of p.rows) {
    stats.presets++;
    const next = migrateSettingsBlob(r.settings ?? {});
    const d = diff(r.settings ?? {}, next);
    if (d.length === 0) continue;
    stats.presetsChanged++;
    console.log(`setting_presets slot ${r.slot} [${stats.presets}]  ${d.join(" · ")}`);
    await client.query(
      "UPDATE site.setting_presets SET settings = $3::jsonb, updated_at = now() WHERE matrix_id = $1 AND slot = $2",
      [r.matrix_id, r.slot, JSON.stringify(next)]);
  }
  await client.query(apply ? "COMMIT" : "ROLLBACK");
  console.log(`${apply ? "APPLIED" : "DRY RUN (rolled back)"}:`, stats);
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(e);
  process.exitCode = 1;
} finally {
  await client.end();
}
