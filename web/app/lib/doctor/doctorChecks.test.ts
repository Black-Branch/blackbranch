// The doctor's newer verdicts, one fixture per state: services and chat (U17), platform keys that
// were never tested (U16), operator alerts (U15), and a homeserver managed outside the bundle.
// The rest of the list is tested where it lives (install/doctor.test.mjs).
// Run: node --test app/lib/doctor/doctorChecks.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCTOR } from "../doctor.generated.mjs";

type Site = Record<string, unknown> & {
  services: { api: { reachable: boolean; loaded: boolean }; ingest: { reportedMinutesAgo: number | null; loaded: boolean | null };
    platforms: { id: string; label: string; set: boolean; connected: boolean | null; lastMessageMinutes: number | null }[] };
  platforms: { id: string; label: string; set: boolean; tested?: boolean; ok: boolean | null; detail: string }[];
  alerts: { topics: number } | null;
  matrix: { federation: { switch: boolean; reachable: boolean } };
};

const site = (): Site => ({
  matrix: { federation: { switch: false, reachable: false } },
  services: {
    api: { reachable: true, loaded: true },
    ingest: { reportedMinutesAgo: 2, loaded: true },
    platforms: [
      { id: "twitch", label: "Twitch", set: true, connected: null, lastMessageMinutes: 5 },
      { id: "kick", label: "Kick", set: true, connected: null, lastMessageMinutes: null },
      { id: "youtube", label: "YouTube", set: false, connected: null, lastMessageMinutes: null },
    ],
  },
  platforms: [
    { id: "twitch", label: "Twitch", set: true, tested: true, ok: true, detail: "accepted" },
    { id: "kick", label: "Kick", set: true, tested: false, ok: null, detail: "not checked — channel set; nothing to test (no app to test)" },
  ],
  alerts: { topics: 2 },
});
const row = (id: string, mutate: (s: Site) => void = () => {}, hostState: "ok" | "none" | "missing" = "ok") => {
  const s = site();
  mutate(s);
  const r = DOCTOR.evaluate({ host: hostState === "ok" ? {} : null, hostState, site: s, siteError: null }).find((x) => x.id === id);
  assert.ok(r, `vacuity: ${id} is a check`);
  return r;
};

test("services: both answering is ok; a chat service that does not answer is red, and the ingest row is then grey, not red", () => {
  assert.equal(row("services.api").status, "ok");
  assert.equal(row("services.ingest").status, "ok");
  assert.match(row("services.ingest").detail, /reported 2 min ago/);
  const down = (s: Site) => { s.services.api.reachable = false; };
  assert.equal(row("services.api", down).status, "fail");
  assert.equal(row("services.ingest", down).status, "grey", "it could not be asked");
  assert.equal(row("services.platforms", down).status, "grey");
  assert.equal(row("services.api", (s) => { s.services.api.loaded = false; }).status, "warn");
});

test("services: an ingest service that stopped reporting is red, and so is the chat it no longer reads", () => {
  const stale = (s: Site) => { s.services.ingest.reportedMinutesAgo = 40; };
  assert.equal(row("services.ingest", stale).status, "fail");
  assert.match(row("services.ingest", stale).detail, /40 min ago/);
  assert.equal(row("services.ingest", (s) => { s.services.ingest.reportedMinutesAgo = null; }).status, "fail", "never reported");
  const p = row("services.platforms", stale);
  assert.equal(p.status, "fail");
  assert.match(p.detail, /nothing reads Twitch and Kick chat/);
});

test("chat: a quiet platform is NOT a problem — inactivity is told apart from failure", () => {
  const quiet = row("services.platforms", (s) => { s.services.platforms[0]!.lastMessageMinutes = 3 * 24 * 60; });
  assert.equal(quiet.status, "ok", "days without a message: normal while offline");
  assert.match(quiet.detail, /Twitch: read by the running ingest service; last message 3 days ago/);
  assert.match(quiet.detail, /Kick: read by the running ingest service; no message in 30 days/);
  assert.match(quiet.detail, /no messages is normal while offline or quiet/);
  assert.doesNotMatch(quiet.detail, /YouTube/, "a platform that is not set up is not listed");
  // A connection the ingest service reports broken is the failure, whatever the last message.
  const broken = row("services.platforms", (s) => { s.services.platforms[0]!.connected = false; });
  assert.equal(broken.status, "fail");
  assert.match(broken.detail, /Twitch: connection broken; last message 5 min ago/);
  assert.match(row("services.platforms", (s) => { s.services.platforms[0]!.connected = true; }).detail, /Twitch: connected/);
  assert.equal(row("services.platforms", (s) => { s.services.platforms.forEach((p) => { p.set = false; }); }).detail, "no platform is set up");
});

test("platforms: a channel with nothing to test is 'not checked', never a pass", () => {
  const r = row("platforms.credentials");
  assert.equal(r.title, "Platform keys accepted");
  assert.equal(r.status, "ok", "Twitch's key was tested and accepted");
  assert.equal(r.detail, "Twitch accepted; not checked — Kick: channel set; nothing to test");
  const onlyUntested = row("platforms.credentials", (s) => { s.platforms = [s.platforms[1]!]; });
  assert.equal(onlyUntested.status, "grey", "nothing was tested: not green");
  assert.equal(onlyUntested.detail, "not checked — Kick: channel set; nothing to test");
  const bad = row("platforms.credentials", (s) => { s.platforms[0] = { ...s.platforms[0]!, ok: false, detail: "rejected (HTTP 401)" }; });
  assert.equal(bad.status, "fail");
});

test("alerts: no topic is amber with the plain sentence; one topic is enough", () => {
  const none = row("alerts.channel", (s) => { s.alerts = { topics: 0 }; });
  assert.equal(none.status, "warn");
  assert.equal(none.detail, "Alerts reach nobody: no alert topic is set. Important problems stay visible here in the Admin Panel; external notifications are optional.");
  assert.match(none.fix, /^Optional: Admin Panel → Site → Site, the "Alerts to your phone" card: /);
  assert.equal(row("alerts.channel", (s) => { s.alerts = { topics: 1 }; }).status, "ok");
  assert.equal(row("alerts.channel", (s) => { s.alerts = null; }).status, "grey");
});

test("a homeserver managed outside Black Branch: no switch to match, and no blackbranch command in the fix", () => {
  const bundle = row("matrix.federation", (s) => { s.matrix.federation.reachable = true; });
  assert.equal(bundle.status, "fail", "on a bundle the switch is off and others can reach it");
  assert.match(bundle.fix, /blackbranch render/);
  const outside = row("matrix.federation", (s) => { s.matrix.federation.reachable = true; }, "none");
  assert.equal(outside.status, "grey");
  assert.equal(outside.detail, "managed outside Black Branch — other servers can reach it");
  assert.doesNotMatch(outside.fix, /blackbranch/);
  for (const id of ["matrix.synapse", "matrix.mas", "matrix.issuer", "matrix.wellknown", "services.api", "services.ingest"]) {
    assert.doesNotMatch(row(id, () => {}, "none").fix, /blackbranch (render|up|restart|status|logs)/, `${id}'s fix on an install that is not a bundle`);
    assert.match(row(id, () => {}, "ok").fix, /blackbranch/, `${id} keeps its bundle fix`);
  }
});

test("the new areas are on the printed list, in order", () => {
  const areas = DOCTOR.AREAS as readonly string[];
  assert.ok(areas.indexOf("Services") > areas.indexOf("Front door") && areas.indexOf("Alerts") > areas.indexOf("Platforms"));
  const printed = DOCTOR.text(DOCTOR.evaluate({ host: null, hostState: "none", site: site(), siteError: null }));
  assert.match(printed, /^Services$/m);
  assert.match(printed, /^Alerts$/m);
});
