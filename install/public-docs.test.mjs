// What the public docs say about the product, held to the code that does it. Each claim here was
// once wrong in a shipped page (site review area 7, 2026-10-25): the page said the opposite of the
// code, and a streamer reading it looked for something that was not there, or never found something
// that was. Every negative assertion reads a file that is checked first for its own last line, so a
// short read cannot pass it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
/** The file, after checking that its last non-empty line was read. */
function whole(rel, lastLine) {
  const src = read(rel);
  assert.match(src.trimEnd().split("\n").at(-1), lastLine, `${rel} was read to its end`);
  return src;
}
// The public README: public-root/ in this checkout, the root of the public tree (where the cut puts it).
const README_PATH = existsSync(path.join(root, "public-root/README.md")) ? "public-root/README.md" : "README.md";
const README = () => whole(README_PATH, /the source of your changed version\.$/);
const INSTALL_README = () => whole("install/README.md", /It is `BACKUP_PASSPHRASE` in `\.env`\.$/);
const INSTALL_MD = () => whole("docs/public/install.md", /please open a setup-help issue\.$/);
const CHANGELOG = () => whole("docs/public/changelog.md", /and the doctor\.$/);

test("mail: the site can send the sign-in service's mail once a mail server is set, and the docs say so", async () => {
  const { INSTANCE_KEYS } = await import("../config/instance-schema.mjs");
  assert.ok(INSTANCE_KEYS.some((k) => k.key === "mail.smtp.host"), "the Mail card's server setting exists");
  assert.match(read("install/matrix/render.sh"), /password_recovery_enabled: \$mail/, "a mail server turns password recovery on");
  for (const [rel, src] of [[README_PATH, README()], ["install/README.md", INSTALL_README()]]) {
    assert.doesNotMatch(src, /sends no (email|mail) yet|this release sends no mail/, `${rel}: no "sends no mail" claim`);
    assert.match(src, /card Mail/, `${rel}: names where mail is set`);
  }
});

test("the Forums reader: the installer makes it, and the known limits do not say otherwise", () => {
  const bb = read("install/blackbranch");
  assert.match(bb, /\n\s*reader_ensure\b/, "blackbranch up makes the reader account");
  assert.doesNotMatch(INSTALL_MD(), /installer does not make yet|says forums are not available/);
});

test("support tickets: forwarding is not available yet, and the release notes do not promise it", () => {
  assert.match(read("web/app/lib/ticketForward.ts"), /return \{ available: false,/);
  const log = CHANGELOG();
  assert.doesNotMatch(log, /tickets can be forwarded to Black Branch/);
  assert.match(log, /sending them arrives in a later release/);
});

test("a trial: the gift-covered trial entitles; only a trial that ends unpaid never does", () => {
  const records = read("web/app/lib/subscriptions/stripeRecords.ts");
  assert.match(records, /trialing/, "the Stripe reader knows a trial");
  const log = CHANGELOG();
  assert.doesNotMatch(log, /grants nothing until the first charge/);
  assert.match(log, /a trial that ends unpaid never entitles/);
});

test("vacuity: this file was read to its end", () => {
  const me = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.match(me, /\n\/\/ END: public-docs\.test\.mjs\n$/);
});

// END: public-docs.test.mjs
