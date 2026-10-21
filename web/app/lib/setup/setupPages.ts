// The setup pages GENERATED from the module manifests' `setup` field (config/modules.mjs) and the
// product's own lists (config/setup-core.mjs). Pure. A module's code and its setup instructions
// ship in the same commit; this file only turns them into a page for THIS install: every value to
// paste is computed from the install's own addresses, every field is the schema's own entry.
// The shape is checked where the lists are written (check:instance-schema), so a list that reaches
// here is well-formed; a placeholder this file cannot fill is still refused loudly.
// What the pages add on top — folding help, hidden steps, the setup pages' own steps and choices —
// is setupExtras.ts.

import { INSTANCE_KEYS, MODULES, SETUP_CORE } from "../instanceSchema.generated.mjs";
import { STEP_HELP, WIZARD_STEPS, WIZARD_LISTS, type RawStep, type StepHelp } from "./setupExtras.ts";

export type SetupAddresses = { origin: string; apiOrigin: string; matrixOrigin: string; serverName: string };

type Manifest = { id: string; label: string; kind: string; description: string; defaultOn: boolean; setup?: RawStep[] };

export type SetupField = { key: string; label: string; description: string; secret: boolean; kind: string; values?: string[] };
export type SetupStepView = Omit<RawStep, "fields" | "paste" | "ownerOnly"> & {
  paste: { label: string; value: string }[]; fields: SetupField[];
  /** The setup pages' own help for this step (setupExtras.ts STEP_HELP), its paste lines filled. */
  help: StepHelp | null;
};
export type SetupPage = { id: string; label: string; description: string; steps: SetupStepView[] };
export type ProductModule = { id: string; label: string; description: string; defaultOn: boolean; hasSetup: boolean };

const manifests = MODULES as unknown as Manifest[];

/** The values a paste template may use.
 *  @test-only the tests fill templates with it directly (the pages reach it through this file's
 *  own moduleSetupPage / coreSetupPage, which check-orphans does not count). */
export function placeholderValues(a: SetupAddresses): Record<string, string> {
  let domain = "";
  try { domain = new URL(a.origin).hostname; } catch { /* left empty: refused below if used */ }
  return { origin: a.origin, apiOrigin: a.apiOrigin, domain, matrixOrigin: a.matrixOrigin, serverName: a.serverName };
}

/** A paste template filled for this install. Throws on a placeholder it cannot fill — a value with
 *  a hole in it pasted into a provider's console is worse than no page.
 *  @test-only tested directly for the same reason as placeholderValues. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]*)\}/g, (_, name: string) => {
    const v = values[name];
    if (!v) throw new Error(`setup: no value for {${name}} on this install`);
    return v;
  });
}

function field(key: string): SetupField {
  const e = INSTANCE_KEYS.find((k) => k.key === key);
  if (!e) throw new Error(`setup: ${key} is not a settings key`);
  return { key, label: e.label, description: e.description, secret: e.secret, kind: e.kind, ...(e.values ? { values: [...e.values] } : {}) };
}

function stepView(list: string, raw: RawStep, values: Record<string, string>, wizard: boolean): SetupStepView {
  const s = { ...raw };
  delete s.ownerOnly; // which installs see a step is decided before this; the page does not carry it
  const h = STEP_HELP[`${list}/${raw.id}`];
  const help: StepHelp | null = h ? { ...h, ...(h.extraPaste ? { extraPaste: h.extraPaste.map((p) => ({ label: p.label, value: fillTemplate(p.value, values) })) } : {}) } : null;
  if (help && !wizard) delete help.later; // "add it later in the Admin Panel" read IN the Admin Panel says nothing
  return {
    ...s,
    paste: s.paste.map((p) => ({ label: p.label, value: fillTemplate(p.value, values) })),
    fields: s.fields.map(field),
    help,
  };
}

/** A list's steps as a page shows them: plus the setup pages' own steps (WIZARD_STEPS) when the
 *  page is a setup page rather than an Admin Panel guide. */
function withExtras(list: string, steps: readonly RawStep[], wizard: boolean): RawStep[] {
  const out = [...steps];
  if (!wizard) return out;
  for (const { after, step } of WIZARD_STEPS[list] ?? []) {
    const i = after ? out.findIndex((s) => s.id === after) : -1;
    out.splice(i >= 0 ? i + 1 : out.length, 0, step);
  }
  return out;
}

/** The product's modules (site plugins are never offered), in manifest order. */
export function productModules(): ProductModule[] {
  return manifests.filter((m) => m.kind === "module").map((m) => ({
    id: m.id, label: m.label, description: m.description, defaultOn: m.defaultOn, hasSetup: Array.isArray(m.setup) && m.setup.length > 0,
  }));
}

/** Which installs see a step: an ownerOnly step only an install with a site plugin. `wizard`: a
 *  setup page (it adds the setup pages' own steps), not an Admin Panel guide. */
type Audience = { ownerPlugin?: boolean; wizard?: boolean };
const stepsFor = (m: Manifest, { ownerPlugin = false, wizard = false }: Audience): RawStep[] =>
  withExtras(`module:${m.id}`, (m.setup ?? []).filter((s) => ownerPlugin || s.ownerOnly !== true), wizard);

/** The setup page of one product module, or null when it has none. A public install (no owner
 *  plugin — the default) never sees an ownerOnly step. */
export function moduleSetupPage(id: string, addresses: SetupAddresses, audience: Audience = {}): SetupPage | null {
  const m = manifests.find((x) => x.id === id && x.kind === "module");
  const steps = m ? stepsFor(m, audience) : [];
  if (!m || !steps.length) return null;
  const values = placeholderValues(addresses);
  return { id: m.id, label: m.label, description: m.description, steps: steps.map((s) => stepView(`module:${m.id}`, s, values, audience.wizard === true)) };
}

type CoreList = { id: string; label: string; description: string; release: string; steps: RawStep[] };
const coreLists = SETUP_CORE as unknown as CoreList[];
const released = (id: string | null) => coreLists.find((x) => x.id === id && x.release === "now") ?? null;

/** The product's non-module setup lists (Twitch, Kick, Streamplace, the donation services); a
 *  list released 'later' carries no steps yet. */
export function coreSetupLists(): { id: string; label: string; description: string; later: boolean }[] {
  return coreLists.map((c) => ({ id: c.id, label: c.label, description: c.description, later: c.release === "later" }));
}

/** The Admin Panel guide of one of the product's own lists, or null (unknown, or released later). */
export function coreSetupPage(id: string, addresses: SetupAddresses): SetupPage | null {
  const c = released(id);
  if (!c?.steps.length) return null;
  const values = placeholderValues(addresses);
  return { id: c.id, label: c.label, description: c.description, steps: withExtras(`core:${c.id}`, c.steps, false).map((s) => stepView(`core:${c.id}`, s, values, false)) };
}

// ── the setup pages' own choices (setupExtras.ts WIZARD_LISTS) ──────────────────────────────

/** A setup-page list's steps: from its config list (only the named steps), or its own. `list` is
 *  where its help is looked up. */
function wizardSteps(id: string): { list: string; steps: RawStep[] } | null {
  const w = WIZARD_LISTS.find((x) => x.id === id);
  if (!w) return null;
  if (!w.source) return { list: `core:${w.id}`, steps: withExtras(`core:${w.id}`, w.own ?? [], true) };
  const c = released(w.source);
  if (!c) return null;
  return { list: `core:${c.id}`, steps: withExtras(`core:${c.id}`, w.steps ? c.steps.filter((s) => w.steps!.includes(s.id)) : c.steps, true) };
}

/** The setup pages' "where you stream, and other services" choices, in order. */
export function wizardLists(): { id: string; label: string; description: string }[] {
  return WIZARD_LISTS.flatMap((w) => {
    const c = released(w.source);
    if (w.source && !c) return [];
    return [{ id: w.id, label: w.label || c?.label || w.id, description: w.description || c?.description || "" }];
  });
}

/** The setup page of one of those choices, or null. */
export function wizardListPage(id: string, addresses: SetupAddresses): SetupPage | null {
  const s = wizardSteps(id);
  const meta = wizardLists().find((x) => x.id === id);
  if (!s?.steps.length || !meta) return null;
  const values = placeholderValues(addresses);
  return { ...meta, steps: s.steps.map((x) => stepView(s.list, x, values, true)) };
}

/** Every key one of those pages may write. */
export function wizardListKeys(id: string): Set<string> {
  return new Set((wizardSteps(id)?.steps ?? []).flatMap((s) => s.fields));
}

/** The name a skipped step of that page is recorded under, `<name>:<step>`: the config list's id,
 *  so the Admin Panel's checklist names the list it shows. */
export function wizardSkipPrefix(id: string): string {
  return WIZARD_LISTS.find((x) => x.id === id)?.source ?? id;
}

/** Every key a module's setup page may write — the step save accepts these and nothing else. A
 *  setup page passes `wizard`: its own steps' keys count too. */
export function moduleSetupKeys(id: string, audience: Audience = {}): Set<string> {
  const m = manifests.find((x) => x.id === id && x.kind === "module");
  return new Set((m ? stepsFor(m, audience) : []).flatMap((s) => s.fields));
}
