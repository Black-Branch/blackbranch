// Setup step 8's backup half: where backups go, and the rule that setup finishes only once a test
// backup has run AND restored (`restore --verify`) after the target was last saved.
// Pure: the routes in setupServer.ts call these. The ADDRESS is judged by the settings layer's own
// rule, checkBackupTarget (config/instance-schema.mjs) — the same function the settings layer runs on
// every write and the box runs (with the resolved address) before every backup, so the page shows the
// box's own words.

import type { HostResult } from "../hostRequests";
import { checkBackupTarget } from "../instanceSchema.generated.mjs";

const BACKUP_TARGETS = ["local", "s3", "sftp"] as const;
type BackupTarget = (typeof BACKUP_TARGETS)[number];
type BackupForm = { target: BackupTarget; repository: string; region: string; accessKeyId: string; secretAccessKey: string };

const ONE_WORD = /^[^\s"'\\$`]*$/;

/** The form, checked. A blank key keeps the one already saved. */
export function validateBackupTarget(body: Record<string, unknown>): { ok: true; form: BackupForm } | { ok: false; error: string } {
  const s = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const target = s("target") as BackupTarget;
  if (!(BACKUP_TARGETS as readonly string[]).includes(target)) return { ok: false, error: "choose where backups go" };
  const form: BackupForm = { target, repository: s("repository"), region: s("region"), accessKeyId: s("accessKeyId"), secretAccessKey: s("secretAccessKey") };
  // The address is the settings layer's to judge (below); these are the other fields.
  for (const [k, v, max] of [["region", form.region, 64], ["access key id", form.accessKeyId, 200], ["secret key", form.secretAccessKey, 200]] as const) {
    if (v.length > max) return { ok: false, error: `the ${k} is longer than ${max} characters` };
    if (!ONE_WORD.test(v)) return { ok: false, error: `the ${k} may not contain spaces, quotes, $, \` or \\` };
  }
  if (target === "local") form.repository = "";
  const t = checkBackupTarget(target, form.repository);
  if (!t.ok) return { ok: false, error: t.error };
  if (form.region && !/^[A-Za-z0-9-]+$/.test(form.region)) return { ok: false, error: "the region is a name like auto or us-east-1" };
  if (target === "local") { form.region = ""; form.accessKeyId = ""; form.secretAccessKey = ""; }
  if (target === "sftp") { form.region = ""; form.accessKeyId = ""; form.secretAccessKey = ""; }
  return { ok: true, form };
}

/** Did a test backup pass — backed up AND verified — since the target was last saved? */
export function backupTestPassed(askedAt: string | undefined, result: HostResult | null): boolean {
  if (!askedAt || !result) return false;
  return result.ok && Date.parse(result.at) >= Date.parse(askedAt);
}

/** The SFTP key's public half, as the host's `backup-key` answer carries it. */
export function publicKeyOf(result: HostResult | null): string | null {
  const m = result?.ok ? /ssh-ed25519 [A-Za-z0-9+/=]+ [A-Za-z0-9._-]+/.exec(result.message) : null;
  return m ? m[0] : null;
}
