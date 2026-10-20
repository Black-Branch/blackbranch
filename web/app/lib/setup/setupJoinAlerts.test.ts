// Setup's "Who can join?" question (the sign-up switch, matrix.registration) and its optional phone
// alerts (the two ntfy topics). Run: node --test app/lib/setup/setupJoinAlerts.test.ts
//
// Why: a fresh install never asked, so sign-up stayed closed (unset = closed in
// install/matrix/render.sh) while the sign-in page invited people to make an account — nobody but
// the admin could join. The Community step now asks; the Finish page says what was chosen and names
// the switch; the alerts are offered with words that say they are optional.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCommunityStep, joinChoice, joinWords, SIGNUP_SWITCH, validateAlertTopics, alertsSet, alertWords } from "./setupValidate.ts";
import { ADMIN_SECTIONS, KEY_GROUPS } from "../../features/instance/adminLayout.ts";
import { INSTANCE_KEYS } from "../instanceSchema.generated.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(here, "setupServer.ts"), "utf8");
const wizard = readFileSync(join(here, "../../features/setup/SetupWizard.tsx"), "utf8");
const render = readFileSync(join(here, "../../../../install/matrix/render.sh"), "utf8");

test("who can join: both answers are needed, and nothing else is one", () => {
  assert.deepEqual(validateCommunityStep({ federation: false, registration: "open" }), { ok: true, federation: false, registration: "open" });
  assert.deepEqual(validateCommunityStep({ federation: true, registration: "closed" }), { ok: true, federation: true, registration: "closed" });
  assert.equal(validateCommunityStep({ federation: false }).ok, false, "the question is not optional");
  assert.equal(validateCommunityStep({ federation: false, registration: "invite" }).ok, false);
  assert.equal(validateCommunityStep({ registration: "open" }).ok, false, "federation still needed");
  assert.equal(joinChoice("open"), "open"); assert.equal(joinChoice("closed"), "closed");
  for (const bad of [null, undefined, "", "Open", true]) assert.equal(joinChoice(bad), null, String(bad));
  // The answers are the schema's own values for the key.
  assert.deepEqual(INSTANCE_KEYS.find((k) => k.key === "matrix.registration")?.values, ["open", "closed"]);
});

test("the Finish page's words: unset reads as closed, exactly as the host renders it", () => {
  assert.equal(joinWords("open").state, "open"); assert.match(joinWords("open").words, /anyone can make an account/);
  assert.equal(joinWords("closed").state, "closed");
  assert.equal(joinWords(null).state, "closed", "unset = closed");
  assert.match(render, /case "\$\{v:-closed\}" in open\|closed\)/, "render.sh resolves unset to closed too");
  assert.match(joinWords(null).words, /nobody can make a new account/);
});

test("the switch the Finish page names is where the Admin Panel really shows it, under its own label", () => {
  const e = INSTANCE_KEYS.find((k) => k.key === "matrix.registration")!;
  assert.equal(SIGNUP_SWITCH.label, e.label);
  const group = KEY_GROUPS.find((g) => g.keys.includes("matrix.registration"));
  assert.ok(group, "the key is on an Admin Panel page");
  const section = ADMIN_SECTIONS.find((s) => s.key === group.section)!.label;
  assert.equal(SIGNUP_SWITCH.place, `Admin Panel → ${section} → ${group.title}`);
});

test("alert topics: optional, both or neither, real addresses, never the same one twice", () => {
  const none = { wake: false, quiet: false };
  assert.deepEqual(validateAlertTopics(undefined, none), { ok: true, write: {} }, "skipped");
  assert.deepEqual(validateAlertTopics({ wake: "", quiet: "  " }, none), { ok: true, write: {} }, "both left empty");
  const both = validateAlertTopics({ wake: " https://ntfy.sh/a-long-urgent-name ", quiet: "https://ntfy.sh/a-long-quiet-name" }, none);
  assert.deepEqual(both, { ok: true, write: { "ntfy.wakeUrl": "https://ntfy.sh/a-long-urgent-name", "ntfy.quietUrl": "https://ntfy.sh/a-long-quiet-name" } });
  // One alone sends nothing (stream-api notify.js needs both), so it is refused rather than saved.
  assert.match((validateAlertTopics({ wake: "https://ntfy.sh/only-one" }, none) as { error: string }).error, /both topics/);
  // ...unless the other is already saved: a blank field keeps it.
  assert.deepEqual(validateAlertTopics({ wake: "https://ntfy.sh/new-urgent", quiet: "" }, { wake: true, quiet: true }),
    { ok: true, write: { "ntfy.wakeUrl": "https://ntfy.sh/new-urgent" } });
  assert.equal(validateAlertTopics({ wake: "https://ntfy.sh/same", quiet: "https://ntfy.sh/same" }, none).ok, false, "muting one must never mute the other");
  for (const bad of ["ntfy.sh/x", "https://ntfy.sh/", "https://ntfy.sh", "ftp://ntfy.sh/x", "https://u:p" + "@ntfy.sh/x" /* split: the public cut holds the tree at zero email-shaped literals */, "https://ntfy.sh/a b", `https://ntfy.sh/${"x".repeat(300)}`]) {
    assert.equal(validateAlertTopics({ wake: bad, quiet: "https://ntfy.sh/q" }, none).ok, false, bad);
  }
  assert.equal(validateAlertTopics({ wake: 5, quiet: "x" }, none).ok, false);
  assert.equal(validateAlertTopics("x", none).ok, false);
});

test("whether alerts are set comes from stream-api's own status; the words say alerts are optional when none are", () => {
  assert.equal(alertsSet(undefined), null, "stream-api did not say: unknown, not 'none'");
  assert.deepEqual(alertsSet({ "ntfy.wakeUrl": { display: "…abcd" }, "ntfy.quietUrl": { display: "(set)" } }), { wake: true, quiet: true });
  assert.deepEqual(alertsSet({ "ntfy.wakeUrl": { display: null } }), { wake: false, quiet: false });
  assert.match(alertWords({ wake: false, quiet: false }), /Important problems always show in the Admin Panel \(Doctor\); alerts pushed to your phone are optional/);
  assert.match(alertWords({ wake: true, quiet: true }), /Phone alerts are on/);
  assert.match(alertWords(null), /could not be checked/);
  // The place the words name is where the Admin Panel shows the two topics; the Doctor is a section.
  const group = KEY_GROUPS.find((g) => g.keys.includes("ntfy.wakeUrl") && g.keys.includes("ntfy.quietUrl"))!;
  assert.ok(alertWords(null).includes(`Admin Panel → ${ADMIN_SECTIONS.find((s) => s.key === group.section)!.label} → ${group.title}`));
  assert.ok(ADMIN_SECTIONS.some((s) => s.label === "Doctor"));
  // The topics are stream-api's keys alone, which is why web asks stream-api rather than its own layer.
  for (const k of ["ntfy.wakeUrl", "ntfy.quietUrl"]) assert.deepEqual(INSTANCE_KEYS.find((e) => e.key === k)?.packages, ["stream-api"], k);
});

/** A function's body in setupServer.ts, from its signature to the next top-level closing brace. */
function body(sig: string): string {
  const start = server.indexOf(sig);
  assert.ok(start >= 0, `${sig} not found`);
  return server.slice(start, server.indexOf("\n}\n", start));
}

test("the server: the Community step saves the answer and will not move on without one; Finish shows it and checks alerts before writing", () => {
  const sc = body("export async function startCommunity(");
  assert.match(sc, /const v = validateCommunityStep\(body\);\n {2}if \(!v\.ok\) return fail\(400, v\.error\);/);
  assert.match(sc, /await writeSetting\("matrix\.registration", v\.registration\)/);
  const save = body("export async function saveStep(");
  const community = save.slice(save.indexOf('} else if (step === "community") {'), save.indexOf("} else {", save.indexOf('} else if (step === "community") {')));
  assert.match(community, /if \(!joinChoice\(instanceString\("matrix\.registration"\)\)\) return fail\(409, "who can join: choose open sign-up or closed"\);/);
  const finish = body("export async function finishSetup(");
  const check = finish.indexOf("validateAlertTopics(body.alerts");
  assert.ok(check > 0 && check < finish.indexOf('await writeSetting("updates.quietHour"'), "alerts are checked before anything is written");
  assert.match(finish, /for \(const \[key, value\] of Object\.entries\(alerts\.write\)\) await writeSetting\(key, value\);/);
  const data = body("async function stepData(");
  assert.match(data, /signup: \{ \.\.\.joinWords\(instanceString\("matrix\.registration"\)\), place: SIGNUP_SWITCH\.place, label: SIGNUP_SWITCH\.label \}/);
  assert.match(data, /registration: joinChoice\(instanceString\("matrix\.registration"\)\)/);
  // Vacuity anchor on the END of the file: the last route is still there.
  assert.match(server, /export async function finishStatus\(req: Request\): Promise<Out> \{[\s\S]*\n\}\n$/);
});

test("the page: Community asks and sends the answer; Finish shows who can join (also once done) and the alerts", () => {
  assert.match(wizard, /<legend className="px-1 text-xs font-medium text-body">Who can join\?<\/legend>/);
  assert.match(wizard, /call\("\/api\/setup\/community", \{ federation, registration \}\)/);
  assert.match(wizard, /disabled=\{state !== "done" \|\| !registration\}/, "Next waits for an answer");
  assert.equal((wizard.match(/<SignupLine signup=\{signup\} \/>/g) ?? []).length, 2, "on the form and on 'Your site is ready'");
  assert.match(wizard, /alerts: \{ wake, quiet: quietTopic \}/);
  // Vacuity anchor on the END of the file.
  assert.match(wizard, /return <Shell siteName=\{siteName\}><NotYou adminExists=\{view\.phase === "signin" && view\.adminExists\} \/><\/Shell>;\n\}\n$/);
});
