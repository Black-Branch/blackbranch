// The setup pages' server side. SERVER ONLY. Every /api/setup route goes through here.
//
// Rules this file holds:
//   • Everything is read through the settings layer and written through stream-api, the one
//     writer (writeInstanceValue) — never a raw settings query.
//   • Step 1 is the setup link's token and nothing else; it dies once `streamer.matrixId` (or any
//     admin) exists. Every later step needs the signed-in admin.
//   • Nothing here works once setup is finished: from then on the Admin Panel is the way.
//   • Display values (the site's name, the points' name…) are STAGED in `setup.state.install`
//     and reach .env through the host (`apply-install`), which checks each again, then restarts
//     the site once with them.

import pool from "@/lib/db";
import { instanceResolve, instanceState, instanceString, instanceBool, reloadInstanceConfig } from "../instanceConfigServer";
import { writeInstanceValue, clearInstanceValue, requireAdminResponse, requireAdminMutation, runInstanceTest, refindDerivedIds } from "../instanceAdminServer";
import { idsFoundFrom } from "../derivedIds";
import type { StreamApiSnapshot } from "../instanceAdminView";
import { streamApiFetch } from "../streamApi";
import { sameOriginRequest } from "../instanceAdminView";
import { installValue } from "../installValues";
import { matrixServerName } from "../matrixConfig";
import { createPasswordAccount, masAdmin } from "../matrixMasAdmin";
import { INSTANCE_KEYS, resolveInstanceValue, parseInstanceValue } from "../instanceSchema.generated.mjs";
import { hostRequestsAvailable, hostResult, requestHost, hostRecoveryPassphrase, type HostResult, type HostVerb } from "../hostRequests";
import { setupGateState, setupApiRefusal, type SetupGateState } from "./setupGate";
import { setupLinkConfigured, setupTokenMatches, setupLinkUsable } from "./setupToken";
import { stepOrder, resumeStep, nextStep, maySave, recordVisit } from "./setupFlow";
import { productModules, moduleSetupKeys, moduleSetupPage, coreSetupLists, wizardLists, wizardListPage, wizardListKeys, wizardSkipPrefix,
  type SetupAddresses, type SetupPage } from "./setupPages";
import { ADMIN_ONLY_SETUP, CHECK_VIA, expandChosen, formatProblem } from "./setupExtras";
import { checkStripePrice } from "./setupChecks";
import { checkIconSet, writeIconSet, iconAnswer, stageIconSet } from "./setupIcons";
import { ownerPluginInstalled } from "../plugins/installed";
import { validateSiteStep, validatePointsStep, SITE_FIELDS, POINTS_FIELDS, validateCommunityStep, joinChoice, joinWords, SIGNUP_SWITCH,
  validateAlertTopics, alertsSet, alertWords, installDay, communityWords } from "./setupValidate";
import { validateBackupTarget, backupTestPassed, publicKeyOf } from "./setupBackup";

export type SetupState = {
  step?: string;
  adminPending?: { id: string; username: string };
  install?: Record<string, string>;
  skipped?: string[];
  backupAskedAt?: string;
  core?: string[];
  /** The pages the operator has opened (W18b: the Doctor counts a never-configured module as failing
   *  only once its page was visited). Written only while the schema takes it — see VISITED_STORABLE. */
  visited?: string[];
};

/** Whether the setup-progress record (setup.state, config/instance-schema.mjs kind setupState) takes
 *  a `visited` list. It is a closed shape — stream-api refuses a field it does not list, and the
 *  save would fail — so the pages record visits only once the schema lists the field. */
const SETUP_STATE_ENTRY = INSTANCE_KEYS.find((k) => k.key === "setup.state");
const VISITED_STORABLE = !!SETUP_STATE_ENTRY && parseInstanceValue(SETUP_STATE_ENTRY, { visited: ["site"] }).ok;

/** The host's icon request. Not in hostRequests.ts's verb list yet (agent B2's file; the host's
 *  half is install/blackbranch's): asked by name, which its own check accepts. */
const ICON_VERB = "site-icons" as HostVerb;
type Out = { status: number; body: unknown };
const by = "setup";

// ── reading ─────────────────────────────────────────────────────────────────────────────────

export function setupStatus(): SetupGateState {
  return setupGateState({
    loaded: instanceState().loaded,
    completedAt: instanceString("setup.completedAt"),
    tokenConfigured: setupLinkConfigured(),
  });
}

function readState(): SetupState {
  const v = instanceResolve("setup.state").value;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as SetupState) : {};
}

function firstAdmin(): string | null {
  return instanceString("streamer.matrixId");
}

async function anyAdminRow(): Promise<boolean> {
  const { rows } = await pool.query("SELECT 1 FROM site.users WHERE is_admin LIMIT 1");
  return rows.length > 0;
}

/** The switched-on modules that get a setup page. OBS is set up in the Admin Panel: the rig
 *  page and the overlays are pasted into OBS, not into the site. */
function enabledModuleSteps(): string[] {
  return productModules().filter((m) => m.hasSetup && !(m.id in ADMIN_ONLY_SETUP) && instanceBool(`modules.${m.id}`)).map((m) => m.id);
}

/** The setup pages' lists chosen on the modules page, in their declared order. */
function chosenCoreSteps(state: SetupState = readState()): string[] {
  const chosen = new Set(expandChosen(state.core ?? []));
  return wizardLists().filter((c) => chosen.has(c.id)).map((c) => c.id);
}

function currentOrder(state: SetupState = readState()): string[] {
  return stepOrder(enabledModuleSteps(), chosenCoreSteps(state));
}

/** A page made from a setup list: `module:<id>` or `core:<id>`. `skip`: what its skipped steps are
 *  recorded under (`<skip>:<step>`). */
function listPage(step: string): { skip: string; page: SetupPage | null; keys: Set<string> } | null {
  if (step.startsWith("module:")) {
    const id = step.slice("module:".length);
    const audience = { ownerPlugin: ownerPluginInstalled(), wizard: true };
    return { skip: id, page: moduleSetupPage(id, addresses(), audience), keys: moduleSetupKeys(id, audience) };
  }
  if (step.startsWith("core:")) {
    const id = step.slice("core:".length);
    return { skip: wizardSkipPrefix(id), page: wizardListPage(id, addresses()), keys: wizardListKeys(id) };
  }
  return null;
}

/** The skip records a page owns: one per step it shows. */
const ownSkips = (skip: string, page: SetupPage | null) => new Set((page?.steps ?? []).map((s) => `${skip}:${s.id}`));

/** The admin's own user name, the streamer display name's starting value. */
function adminName(): string {
  const id = firstAdmin() ?? "";
  return /^@([^:]+):/.exec(id)?.[1] ?? "";
}

function addresses(): SetupAddresses {
  return {
    origin: installValue("site.origin"), apiOrigin: installValue("site.apiOrigin"),
    matrixOrigin: installValue("matrix.baseUrl"), serverName: installValue("matrix.serverName"),
  };
}

/** The staged display values that the running site does not hold yet (by .env name). A staged
 *  "" means unset, so it is compared the way the boot resolves an unset value — its default. */
function pendingInstall(state: SetupState): string[] {
  const out: string[] = [];
  for (const [name, staged] of Object.entries(state.install ?? {})) {
    const e = INSTANCE_KEYS.find((k) => k.tier === "install" && k.env[0] === name);
    if (!e) continue;
    const want = resolveInstanceValue(e, { [name]: staged }, null).value;
    if ((typeof want === "string" ? want : "") !== installValue(e.key as Parameters<typeof installValue>[0])) out.push(name);
  }
  return out;
}

/** The staged value of a display value, else the one the site runs with. */
function displayValue(name: string): string {
  const staged = readState().install?.[name];
  if (typeof staged === "string") return staged;
  const e = INSTANCE_KEYS.find((k) => k.tier === "install" && k.env[0] === name);
  return e ? installValue(e.key as Parameters<typeof installValue>[0]) : "";
}

/** Whether the alert topics are set: they are stream-api's keys alone, so its own status says
 *  (null when it does not answer). */
async function savedAlerts(): Promise<{ wake: boolean; quiet: boolean } | null> {
  try {
    const res = await streamApiFetch("/config", { cache: "no-store" });
    return res.ok ? alertsSet(((await res.json()) as StreamApiSnapshot).self) : null;
  } catch { return null; }
}

// ── writing ─────────────────────────────────────────────────────────────────────────────────

async function saveState(next: SetupState): Promise<void> {
  const r = await writeInstanceValue("setup.state", next, by);
  if (r.status !== 200) throw new Error(`could not save setup progress (${JSON.stringify(r.body)})`);
  await reloadInstanceConfig();
}

async function writeSetting(key: string, value: unknown): Promise<void> {
  const empty = value === null || value === undefined || value === "";
  const r = empty ? await clearInstanceValue(key, by) : await writeInstanceValue(key, value, by);
  if (r.status !== 200) throw new Error(`${key}: ${JSON.stringify(r.body)}`);
}

const fail = (status: number, error: string): Out => ({ status, body: { error } });

/** For every route but the status: setup must be POSITIVELY running — finished (409) and
 *  unknown (503, the settings not loaded) both refuse. Never the public gate's fail-open. */
function closedResponse(): Out | null {
  const r = setupApiRefusal(setupStatus());
  return r ? fail(r.status, r.error) : null;
}

/** The signed-in admin, for a step after the first. */
async function requireSetupAdmin(req: Request, mutate: boolean): Promise<string | Out> {
  const closed = closedResponse();
  if (closed) return closed;
  const who = mutate ? await requireAdminMutation(req) : await requireAdminResponse();
  if (who instanceof Response) return { status: who.status, body: await who.json().catch(() => ({ error: "refused" })) };
  return who;
}

// ── the page's view ─────────────────────────────────────────────────────────────────────────

export type SetupView =
  | { phase: "closed"; reason: "complete" }
  | { phase: "unavailable" }
  | { phase: "token"; linkOk: boolean | null; adminExists: boolean; of: number }
  | { phase: "signin"; adminExists: boolean }
  | { phase: "wizard"; me: string; step: string; order: string[]; data: Record<string, unknown> };

/** What /setup shows to this browser. `token` is the link's token when it carried one. */
export async function setupView(sessionUser: string | null, token: string | null): Promise<SetupView> {
  const status = setupStatus();
  if (status === "complete") return { phase: "closed", reason: "complete" };
  // The settings are not loaded: whether setup is finished cannot be told, so nothing is offered.
  if (status === "unknown") return { phase: "unavailable" };
  const admin = firstAdmin();
  // A database error is "cannot check right now" — never "no admin yet", which would show a used
  // link as usable.
  const adminRow = admin ? true : await anyAdminRow().catch(() => null);
  const adminExists = adminRow === true;
  if (sessionUser && adminExists) {
    const { rows } = await pool.query<{ is_admin: boolean }>("SELECT is_admin FROM site.users WHERE matrix_id = $1", [sessionUser])
      .catch(() => ({ rows: [] as { is_admin: boolean }[] }));
    if (rows[0]?.is_admin) {
      const order = currentOrder();
      const step = resumeStep(readState().step, order, true);
      return { phase: "wizard", me: sessionUser, step, order, data: await stepData(step) };
    }
  }
  if (token !== null) {
    return { phase: "token", linkOk: adminRow === null ? null : setupLinkUsable({ tokenOk: setupTokenMatches(token), adminExists }), adminExists,
      of: currentOrder().length };
  }
  return { phase: "signin", adminExists };
}

/** The values a step's form starts from. Never a secret. */
async function stepData(step: string): Promise<Record<string, unknown>> {
  const state = readState();
  if (step === "site") {
    const instanceValue = (name: string): string | null =>
      name === "SITE_TIME_ZONE" ? (instanceString("site.timeZone") ?? "")
        : name === "SITE_DATA_SINCE" ? (instanceString("site.dataSince") ?? "")
          : name === "STREAMER_DISPLAY_NAME" ? (instanceString("streamer.displayName") ?? adminName()) : null;
    return {
      values: Object.fromEntries(SITE_FIELDS.map((f) => [f.name, instanceValue(f.name) ?? displayValue(f.name)])),
      fields: SITE_FIELDS, domain: addresses().origin.replace(/^https?:\/\//, ""), serverName: addresses().serverName,
      // The icons: whether this install can take an upload (it goes through the host), and whether
      // one is staged for Finish already.
      icons: { upload: hostRequestsAvailable(), staged: state.install?.SITE_ICON_SET === "/site-files" },
    };
  }
  if (step === "points") return { fields: POINTS_FIELDS, values: Object.fromEntries(POINTS_FIELDS.map((f) => [f.name, displayValue(f.name)])) };
  if (step === "modules") {
    const chosen = chosenCoreSteps(state);
    return {
      // A module set up only in the Admin Panel (OBS) is not offered here at all, only named.
      modules: productModules().filter((m) => !(m.id in ADMIN_ONLY_SETUP)).map((m) => ({ ...m, on: instanceBool(`modules.${m.id}`) })),
      elsewhere: Object.values(ADMIN_ONLY_SETUP),
      core: wizardLists().map((c) => ({ ...c, chosen: chosen.includes(c.id) })),
      later: coreSetupLists().filter((c) => c.later),
      donateUrl: instanceString("site.donateUrl") ?? "",
    };
  }
  const list = listPage(step);
  if (list) {
    const { skip, page } = list;
    const values: Record<string, string> = {};
    const isSet: Record<string, boolean> = {};
    for (const s of page?.steps ?? []) for (const f of s.fields) {
      const r = instanceResolve(f.key);
      isSet[f.key] = r.value !== null && r.value !== undefined && r.value !== "";
      if (!f.secret) values[f.key] = typeof r.value === "string" ? r.value : typeof r.value === "boolean" ? String(r.value) : "";
    }
    const own = ownSkips(skip, page);
    return { page, values, isSet, skipped: (state.skipped ?? []).filter((x) => own.has(x)) };
  }
  if (step === "community") {
    // registration: the answer to "who can join?" — null until it is given (the page asks).
    const result = await hostResult("matrix-bootstrap");
    return { federation: instanceBool("matrix.federation"), registration: joinChoice(instanceString("matrix.registration")),
      hub: instanceString("matrix.rooms.hub"), general: instanceString("matrix.rooms.general"),
      made: communityWords(displayValue("SITE_NAME"), result?.ok ? result.message : null),
      serverName: addresses().serverName, hostRequests: hostRequestsAvailable() };
  }
  if (step === "finish") {
    const q = instanceResolve("updates.quietHour").value;
    const alerts = await savedAlerts();
    return { quietHour: typeof q === "number" ? q : 4,
      // The zone the quiet hour is in; null = UTC (the page says so beside the hour).
      timeZone: instanceString("site.timeZone"),
      pending: pendingInstall(state), hostRequests: hostRequestsAvailable(),
      // Who can join, as the host will render it once setup is finished, and where it changes later.
      signup: { ...joinWords(instanceString("matrix.registration")), place: SIGNUP_SWITCH.place, label: SIGNUP_SWITCH.label },
      alerts: { set: alerts, words: alertWords(alerts) },
      // The name typed on "Your site": the header shows it while the running site still holds the old one.
      stagedName: typeof state.install?.SITE_NAME === "string" && state.install.SITE_NAME.trim() ? state.install.SITE_NAME : null,
      backup: { target: instanceString("backup.target") ?? "local", repository: instanceString("backup.repository") ?? "", region: instanceString("backup.s3.region") ?? "" } };
  }
  return {};
}

// ── step 1: the first admin ─────────────────────────────────────────────────────────────────

let creating = false;

export async function createFirstAdmin(req: Request, body: { token?: unknown; username?: unknown; password?: unknown }): Promise<Out> {
  if (!sameOriginRequest(req.headers)) return fail(403, "cross-site request refused");
  const closed = closedResponse();
  if (closed) return closed;
  const adminExists = !!firstAdmin() || (await anyAdminRow());
  if (!setupLinkUsable({ tokenOk: setupTokenMatches(body.token), adminExists })) {
    return fail(adminExists ? 410 : 403, adminExists ? "this setup link no longer works: the first admin exists — sign in instead" : "this setup link is not valid");
  }
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[a-z0-9._=-]{1,64}$/.test(username)) return fail(400, "a user name of lower-case letters, digits and . _ = - (at most 64)");
  if (password.length < 8 || password.length > 512) return fail(400, "a password of at least 8 characters");
  if (creating) return fail(429, "an account is being created — wait a moment");
  creating = true;
  try {
    const state = readState();
    const resume = state.adminPending?.username === username ? state.adminPending.id : null;
    const r = await createPasswordAccount(masAdmin(), username, password, resume);
    if (!r.ok) {
      if (r.id) await saveState({ ...state, adminPending: { id: r.id, username } });
      if (r.code === "taken") return fail(409, `the name ${username} is taken — choose another`);
      if (r.code === "name_refused") return fail(400, `the account server refused that name${r.reason ? `: ${r.reason}` : ""}`);
      if (r.code === "weak_password") return fail(400, `the account server refused that password${r.reason ? `: ${r.reason}` : ""} — try a longer one`);
      if (r.code === "not_allowed") return fail(503, "the site cannot manage accounts on its homeserver (its admin access is not allowed)");
      return fail(502, `the account server did not answer as expected (${r.code})`);
    }
    const matrixId = `@${username}:${matrixServerName()}`;
    await pool.query(
      `INSERT INTO site.users (matrix_id, display_name, created_at, is_admin) VALUES ($1, $2, NOW(), TRUE)
       ON CONFLICT (matrix_id) DO UPDATE SET is_admin = TRUE`,
      [matrixId, username],
    );
    await writeSetting("streamer.matrixId", matrixId);
    const rest: SetupState = { ...state };
    delete rest.adminPending;
    await saveState({ ...rest, step: "recovery" });
    // The host prepares the recovery sheet now, so the next page does not wait for it.
    void requestHost("recovery-sheet");
    return { status: 200, body: { ok: true, matrixId } };
  } finally {
    creating = false;
  }
}

// ── step 2: the recovery sheet ──────────────────────────────────────────────────────────────

export async function recoverySheet(req: Request): Promise<Out> {
  const who = await requireSetupAdmin(req, false);
  if (typeof who !== "string") return who;
  const order = currentOrder();
  if (resumeStep(readState().step, order, true) !== "recovery") return fail(410, "the recovery sheet is shown once — on the server it is BACKUP_PASSPHRASE in .env");
  // From the host, never this process's environment (hostRecoveryPassphrase says why).
  const passphrase = await hostRecoveryPassphrase();
  if (!passphrase && hostRequestsAvailable()) return fail(503, "the server did not hand over the recovery sheet — reload to try again (on the server it is BACKUP_PASSPHRASE in .env)");
  return { status: 200, body: { passphrase, envFile: process.env.BB_ENV_FILE || null } };
}

// ── steps 2–7: save a page ──────────────────────────────────────────────────────────────────

/** The page's visit, added to what is recorded — only while the record takes it (VISITED_STORABLE). */
const withVisit = (state: SetupState, page: string): SetupState =>
  VISITED_STORABLE ? { ...state, visited: recordVisit(state.visited, page) } : state;

export async function saveStep(req: Request, body: { step?: unknown; data?: unknown; goto?: unknown; stay?: unknown; icons?: unknown; iconsAskedAt?: unknown }): Promise<Out> {
  const who = await requireSetupAdmin(req, true);
  if (typeof who !== "string") return who;
  const state = readState();
  const order = currentOrder();
  const current = resumeStep(state.step, order, true);

  // Back: move the saved step to an earlier page (never to the one-way ones).
  if (typeof body.goto === "string") {
    if (!maySave(body.goto, current, order) || body.goto === current) return fail(400, "cannot go to that step");
    await saveState({ ...withVisit(state, current), step: body.goto });
    return { status: 200, body: { ok: true, step: body.goto } };
  }

  // The site's icons, from "Your site": hand them to the host, then (once it answered) stage them.
  if (body.icons !== undefined || body.iconsAskedAt !== undefined) {
    if (!maySave("site", current, order)) return fail(409, `this is the ${current} step`);
    return body.icons !== undefined ? uploadIcons(body.icons) : iconsAnswer(body.iconsAskedAt);
  }

  const step = typeof body.step === "string" ? body.step : "";
  if (!maySave(step, current, order)) return fail(409, `this is the ${current} step`);
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? (body.data as Record<string, unknown>) : {};
  let next: SetupState = { ...state };

  try {
    if (step === "recovery") {
      if (data.saved !== true) return fail(400, "tick the box once the sheet is saved");
    } else if (step === "site") {
      const v = validateSiteStep(data);
      if (!v.ok) return fail(400, v.error);
      next = { ...next, install: { ...(next.install ?? {}), ...v.install } };
      await writeSetting("site.timeZone", v.timeZone);
      await writeSetting("site.dataSince", v.dataSince);
      await writeSetting("streamer.displayName", v.displayName);
    } else if (step === "points") {
      const v = validatePointsStep(data);
      if (!v.ok) return fail(400, v.error);
      next = { ...next, install: { ...(next.install ?? {}), ...v.install } };
    } else if (step === "modules") {
      const want = data.modules && typeof data.modules === "object" ? (data.modules as Record<string, unknown>) : {};
      // The donate link (contract 7): where Donate goes when no payment provider is on.
      if (data.donateUrl !== undefined) {
        if (typeof data.donateUrl !== "string") return fail(400, "Donate link: text expected");
        const problem = formatProblem("site.donateUrl", data.donateUrl);
        if (problem) return fail(400, `Donate link: ${problem}`);
      }
      for (const m of productModules()) {
        if (typeof want[m.id] !== "boolean" || m.id in ADMIN_ONLY_SETUP) continue;
        if (want[m.id] !== instanceBool(`modules.${m.id}`)) await writeSetting(`modules.${m.id}`, want[m.id]);
      }
      if (typeof data.donateUrl === "string" && data.donateUrl.trim() !== (instanceString("site.donateUrl") ?? "")) {
        await writeSetting("site.donateUrl", data.donateUrl.trim() || null);
      }
      if (Array.isArray(data.core)) {
        const known = new Set(wizardLists().map((c) => c.id));
        next = { ...next, core: data.core.filter((x): x is string => typeof x === "string" && known.has(x)) };
      }
      await reloadInstanceConfig();
    } else if (listPage(step)) {
      const { skip, page, keys: allowed } = listPage(step)!;
      const values = data.values && typeof data.values === "object" ? (data.values as Record<string, unknown>) : {};
      // Every value is checked before any is written: a page is saved whole or not at all.
      for (const [key, value] of Object.entries(values)) {
        if (!allowed.has(key)) return fail(400, `${key} is not on this page`);
        if (typeof value !== "string") return fail(400, `${key}: text expected`);
        const problem = formatProblem(key, value);
        if (problem) return fail(400, `${INSTANCE_KEYS.find((k) => k.key === key)?.label ?? key}: ${problem}`);
      }
      for (const [key, value] of Object.entries(values) as [string, string][]) {
        const e = INSTANCE_KEYS.find((k) => k.key === key);
        if (e?.secret && !value.trim()) continue; // a blank secret field keeps what is stored
        await writeSetting(key, value.trim() || null);
      }
      // A channel or app key saved here: the platform id behind the channel is found and saved too.
      if (Object.keys(values).some((k) => idsFoundFrom(k).length)) {
        await reloadInstanceConfig();
        if ((await refindDerivedIds(Object.keys(values), by)).some((f) => f.ok)) await reloadInstanceConfig();
      }
      const skippedNow = Array.isArray(data.skipped) ? data.skipped.filter((x): x is string => typeof x === "string") : [];
      const own = ownSkips(skip, page);
      const keep = (next.skipped ?? []).filter((x) => !own.has(x));
      next = { ...next, skipped: [...keep, ...skippedNow.map((s) => `${skip}:${s}`).filter((s) => own.has(s))] };
    } else if (step === "community") {
      // "Who can join?" may be answered (or changed) here too, after the rooms were made.
      if (data.registration !== undefined) {
        const reg = joinChoice(data.registration);
        if (!reg) return fail(400, "who can join: choose open sign-up or closed");
        if (reg !== instanceString("matrix.registration")) await writeSetting("matrix.registration", reg);
      }
      await reloadInstanceConfig();
      if (!instanceString("matrix.rooms.hub") || !instanceString("matrix.rooms.general")) {
        return fail(409, "make the community first — its rooms do not exist yet");
      }
      if (!joinChoice(instanceString("matrix.registration"))) return fail(409, "who can join: choose open sign-up or closed");
    } else {
      return fail(400, "unknown step");
    }
    // `stay`: save without moving on (a module page saves its fields before its Test runs).
    const after = body.stay === true ? current : (nextStep(step, currentOrder(next)) ?? "finish");
    next = { ...withVisit(next, step), step: after };
    await saveState(next);
    // Past the recovery step: the host takes the sheet back, for good.
    if (step === "recovery") void requestHost("recovery-sheet");
    return { status: 200, body: { ok: true, step: after } };
  } catch (e) {
    return fail(502, e instanceof Error ? e.message.slice(0, 300) : "could not save");
  }
}

// ── step 6: a module's Test button ──────────────────────────────────────────────────────────

let lastPriceCheck = 0;

export async function setupTest(req: Request, body: { key?: unknown }): Promise<Out> {
  const who = await requireSetupAdmin(req, true);
  if (typeof who !== "string") return who;
  const key = typeof body.key === "string" ? body.key : "";
  const audience = { ownerPlugin: ownerPluginInstalled(), wizard: true };
  const onPages = [...enabledModuleSteps().map((id) => moduleSetupKeys(id, audience)), ...chosenCoreSteps().map((id) => wizardListKeys(id))];
  // A key checked through another (CHECK_VIA: the handle's found DID) counts as that page's too.
  if (!onPages.some((keys) => keys.has(key) || [...keys].some((k) => CHECK_VIA[k] === key))) return fail(404, "no such test on these pages");
  // The subscription price has no check in the schema: the setup pages' own (contract 6).
  if (key === "stripe.supporterPriceId") {
    if (Date.now() - lastPriceCheck < 3000) return fail(429, "checked a moment ago — wait a few seconds");
    lastPriceCheck = Date.now();
    const r = await checkStripePrice(instanceString("stripe.supporterPriceId"), instanceString("stripe.secretKey"), fetch);
    return { status: 200, body: { ok: true, key, results: [{ package: "web", ok: r.ok, detail: r.detail }] } };
  }
  return runInstanceTest(key);
}

// ── "Your site": the icons ──────────────────────────────────────────────────────────────────

async function uploadIcons(files: unknown): Promise<Out> {
  if (!hostRequestsAvailable()) return fail(503, "this install cannot hand files to its server — put the icons in site-files/ there and run sudo blackbranch set SITE_ICON_SET /site-files");
  const v = checkIconSet(files);
  if (!v.ok) return fail(400, v.error);
  try { await writeIconSet(v.files); } catch (e) {
    return fail(502, `could not hand the icons to the server: ${e instanceof Error ? e.message.slice(0, 200) : "write failed"}`);
  }
  const r = await requestHost(ICON_VERB);
  return r.ok ? { status: 200, body: { ok: true, requestedAt: r.requestedAt } } : fail(503, r.error);
}

/** The host's answer to the icons asked for at `askedAt`. Answered ok → SITE_ICON_SET=/site-files is
 *  staged for Finish; not answered yet → `waiting` (the page stops asking after a while and says
 *  this server does not take uploads yet). */
async function iconsAnswer(askedAt: unknown): Promise<Out> {
  if (typeof askedAt !== "string" || !Number.isFinite(Date.parse(askedAt))) return fail(400, "icons: when they were asked for");
  const answer = iconAnswer(await hostResult(ICON_VERB), askedAt);
  if (answer.state !== "placed") return { status: 200, body: { ok: true, ...answer } };
  const state = readState();
  try {
    await saveState({ ...state, install: stageIconSet(state.install) });
  } catch (e) {
    return fail(502, e instanceof Error ? e.message.slice(0, 300) : "could not save");
  }
  return { status: 200, body: { ok: true, state: "placed" } };
}

// ── step 7: the community ───────────────────────────────────────────────────────────────────

export async function startCommunity(req: Request, body: { federation?: unknown; registration?: unknown }): Promise<Out> {
  const who = await requireSetupAdmin(req, true);
  if (typeof who !== "string") return who;
  const v = validateCommunityStep(body);
  if (!v.ok) return fail(400, v.error);
  try {
    if (v.federation !== instanceBool("matrix.federation")) await writeSetting("matrix.federation", v.federation);
    // Sign-up stays closed while setup runs whatever this says; Finish's render applies it.
    if (v.registration !== instanceString("matrix.registration")) await writeSetting("matrix.registration", v.registration);
  } catch (e) { return fail(502, e instanceof Error ? e.message : "could not save"); }
  const r = await requestHost("matrix-bootstrap");
  if (!r.ok) return fail(503, r.error);
  // Federation is rendered into the homeserver's config; the host applies it after the rooms exist.
  if (v.federation) await requestHost("render");
  return { status: 200, body: { ok: true, requestedAt: r.requestedAt } };
}

export async function communityStatus(req: Request): Promise<Out> {
  const who = await requireSetupAdmin(req, false);
  if (typeof who !== "string") return who;
  await reloadInstanceConfig();
  const result: HostResult | null = await hostResult("matrix-bootstrap");
  return { status: 200, body: { hub: instanceString("matrix.rooms.hub"), general: instanceString("matrix.rooms.general"), result,
    made: communityWords(displayValue("SITE_NAME"), result?.ok ? result.message : null) } };
}

// ── step 8: the backup target and its test ──────────────────────────────────────────────────

/** Save where backups go, then ask the host for a test: one backup, then a verify of it. Only an
 *  answer from after this counts, so a target changed later needs its own test before Finish. */
export async function startBackupTest(req: Request, body: Record<string, unknown>): Promise<Out> {
  const who = await requireSetupAdmin(req, true);
  if (typeof who !== "string") return who;
  if (resumeStep(readState().step, currentOrder(), true) !== "finish") return fail(409, "finish the earlier steps first");
  if (!hostRequestsAvailable()) return fail(503, "this install cannot ask its server for a backup; run sudo blackbranch backup there");
  const v = validateBackupTarget(body);
  if (!v.ok) return fail(400, v.error);
  try {
    await writeSetting("backup.target", v.form.target);
    await writeSetting("backup.repository", v.form.repository || null);
    await writeSetting("backup.s3.region", v.form.region || null);
    // A blank key keeps what is saved; the host says so if none is.
    if (v.form.accessKeyId) await writeSetting("backup.s3.accessKeyId", v.form.accessKeyId);
    if (v.form.secretAccessKey) await writeSetting("backup.s3.secretAccessKey", v.form.secretAccessKey);
    const r = await requestHost("backup-test");
    if (!r.ok) return fail(503, r.error);
    await saveState({ ...readState(), backupAskedAt: r.requestedAt });
    return { status: 200, body: { ok: true, requestedAt: r.requestedAt } };
  } catch (e) {
    return fail(502, e instanceof Error ? e.message.slice(0, 300) : "could not save");
  }
}

/** The SFTP target's key: the host makes it once; its public half comes back in the answer. */
export async function requestBackupKey(req: Request): Promise<Out> {
  const who = await requireSetupAdmin(req, true);
  if (typeof who !== "string") return who;
  const r = await requestHost("backup-key");
  return r.ok ? { status: 200, body: { ok: true, requestedAt: r.requestedAt } } : fail(503, r.error);
}

export async function backupTestStatus(req: Request): Promise<Out> {
  const who = await requireSetupAdmin(req, false);
  if (typeof who !== "string") return who;
  const askedAt = readState().backupAskedAt ?? null;
  const result = await hostResult("backup-test");
  const key = await hostResult("backup-key");
  return { status: 200, body: { askedAt, result, passed: backupTestPassed(askedAt ?? undefined, result), publicKey: publicKeyOf(key), keyResult: key } };
}

// ── step 8: finish ──────────────────────────────────────────────────────────────────────────

async function complete(): Promise<void> {
  // "Data since" left empty: the site's history starts the day it was set up.
  if (!instanceString("site.dataSince")) await writeSetting("site.dataSince", installDay(new Date(), instanceString("site.timeZone")));
  await writeSetting("setup.completedAt", new Date().toISOString().replace(/\.\d+Z$/, "Z"));
  await reloadInstanceConfig();
  // The two services read their switches and channels at start (a module switch, the platforms
  // to read): restart them once so what setup wrote applies now. And a render: the bundled
  // homeserver's sign-up stays closed while setup runs and follows its switch once it is finished
  // (install/matrix/render.sh), which only a render applies. Best effort — on an install without
  // the host's request folder the operator restarts them.
  if (hostRequestsAvailable()) for (const v of ["restart-stream-api", "restart-stream-ingest", "render"] as const) await requestHost(v);
}

export async function finishSetup(req: Request, body: { quietHour?: unknown; alerts?: unknown; complete?: unknown }): Promise<Out> {
  const who = await requireSetupAdmin(req, true);
  if (typeof who !== "string") return who;
  const order = currentOrder();
  if (resumeStep(readState().step, order, true) !== "finish") return fail(409, "finish the earlier steps first");
  try {
    if (body.complete === true) {
      // The second half: the host has rebuilt the site with the staged values (or there were none).
      const pending = pendingInstall(readState());
      if (pending.length) return fail(409, `the site is not built with ${pending.join(", ")} yet`);
      await complete();
      return { status: 200, body: { ok: true, phase: "done" } };
    }
    // A backup that has not been read back is not a backup: no Finish before a test passed.
    if (hostRequestsAvailable() && !backupTestPassed(readState().backupAskedAt, await hostResult("backup-test"))) {
      return fail(409, "run a test backup first — setup finishes once one has been made and restored");
    }
    const q = body.quietHour;
    if (typeof q !== "number" || !Number.isInteger(q) || q < 0 || q > 23) return fail(400, "quiet hour: 0–23");
    // Phone alerts are optional: one topic, both, or neither. Unknown (stream-api did not say) counts as unset.
    const alerts = validateAlertTopics(body.alerts, (await savedAlerts()) ?? { wake: false, quiet: false });
    if (!alerts.ok) return fail(400, alerts.error);
    await writeSetting("updates.quietHour", q);
    for (const [key, value] of Object.entries(alerts.write)) await writeSetting(key, value);
    const pending = pendingInstall(readState());
    if (!pending.length) {
      await complete();
      return { status: 200, body: { ok: true, phase: "done" } };
    }
    const r = await requestHost("apply-install");
    if (!r.ok) return fail(503, `${r.error} — set the values with \`sudo blackbranch set\`, then finish again`);
    return { status: 200, body: { ok: true, phase: "applying", requestedAt: r.requestedAt, pending } };
  } catch (e) {
    return fail(502, e instanceof Error ? e.message.slice(0, 300) : "could not save");
  }
}

export async function finishStatus(req: Request): Promise<Out> {
  const who = await requireSetupAdmin(req, false);
  if (typeof who !== "string") return who;
  return { status: 200, body: { pending: pendingInstall(readState()), result: await hostResult("apply-install") } };
}
