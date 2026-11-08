// "Need help?": where a stuck operator goes — the guides, the project's Discord, and the report to
// attach. ONE place holds the addresses (config/doctor.mjs, DOCTOR.HELP); the install summary reads
// them from the release's copy, the doctor prints them, the Admin Panel's Doctor shows them.
// Run: node --test install/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTOR } from "../config/doctor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const installSh = readFileSync(path.join(here, "install.sh"), "utf8");
const LINE = /^ {3}Need help\? Guides: (\S+) · Ask: (\S+) · Attach the report from (sudo blackbranch doctor --report)$/m;

// install.sh's own help_line, run against a release whose config/ is this tree's.
function helpLine(configDir) {
  const fn = installSh.match(/\nhelp_line\(\) \{\n[\s\S]*?\n\}\n/)?.[0];
  assert.ok(fn, "install.sh defines help_line");
  const home = mkdtempSync(path.join(tmpdir(), "bb-help-"));
  try {
    mkdirSync(path.join(home, "release"));
    if (configDir) symlinkSync(configDir, path.join(home, "release/config"));
    return spawnSync("bash", ["-c", `set -euo pipefail\n${fn}\nhelp_line\necho done`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", BB_HOME: home } });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test("the project's help: the guides, the Discord and the report command, each held once", () => {
  assert.equal(DOCTOR.HELP.docs, "https://blackbranch.app/docs/");
  assert.match(DOCTOR.HELP.discord, /^https:\/\/discord\.gg\/[A-Za-z0-9]+$/);
  assert.equal(DOCTOR.HELP.report, "sudo blackbranch doctor --report");
  assert.ok(DOCTOR.helpLine().includes(DOCTOR.HELP.docs) && DOCTOR.helpLine().includes(DOCTOR.HELP.discord) && DOCTOR.helpLine().includes(DOCTOR.HELP.report));
});

test("the install summary ends with the help line, read from the release's doctor list", () => {
  const r = helpLine(path.join(root, "config"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\ndone\n$/);
  const m = r.stdout.match(LINE);
  assert.ok(m, r.stdout);
  assert.deepEqual(m.slice(1), [DOCTOR.HELP.docs, DOCTOR.HELP.discord, DOCTOR.HELP.report]);
  // A release without the list (an older one) prints nothing rather than a line with holes.
  const none = helpLine(null);
  assert.equal(none.status, 0, "an older release never stops the installer (set -e)"); assert.equal(none.stdout, "done\n");
  // install.sh holds no address of its own: the docs and the invite appear only through help_line.
  assert.ok(!installSh.includes("discord.gg"), "the invite is written into install.sh");
  // It ends the "Installed" summary (the setup link stays the installer's last line: bundle.test.mjs).
  const at = (re) => { const m = re.exec(installSh); assert.ok(m, String(re)); return m.index; };
  const summary = at(/\nsay "Installed"\n/), call = at(/\n\[ "\$MODE" = internal \] && echo [^\n]*\nhelp_line\n/), link = at(/\nBB_HOME="\$BB_HOME" \/usr\/local\/bin\/blackbranch setup-link \|\| true\nexit 0\n$/);
  assert.ok(summary < call && call < link, "after the summary, before the setup link");
});

test("the doctor's printout ends with the help line", () => {
  const rows = DOCTOR.evaluate({ host: null, hostState: "none", site: null, siteError: "no answer" });
  assert.ok(rows.length > 10, "vacuity: rows evaluated");
  assert.equal(DOCTOR.text(rows).split("\n").at(-1), DOCTOR.helpLine());
});
