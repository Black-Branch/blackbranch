// The setup pages GENERATED from the module manifests' `setup` field (config/modules.mjs) and the
// product's own lists (config/setup-core.mjs). Pure. A module's code and its setup instructions
// ship in the same commit; this file only turns them into a page for THIS install: every value to
// paste is computed from the install's own addresses, every field is the schema's own entry.
// The shape is checked where the lists are written (check:instance-schema), so a list that reaches
// here is well-formed; a placeholder this file cannot fill is still refused loudly.

import { INSTANCE_KEYS, MODULES, SETUP_CORE } from "../instanceSchema.generated.mjs";

export type SetupAddresses = { origin: string; apiOrigin: string; matrixOrigin: string; serverName: string };

type RawStep = {
  id: string; title: string; need: "required" | "optional"; explain: string;
  links: { label: string; url: string }[]; paste: { label: string; value: string }[];
  fields: string[]; test: string | null;
  /** Shown only on an install with an owner plugin (config/setup-core.mjs). */
  ownerOnly?: boolean;
};
type Manifest = { id: string; label: string; kind: string; description: string; defaultOn: boolean; setup?: RawStep[] };

export type SetupField = { key: string; label: string; description: string; secret: boolean; kind: string; values?: string[] };
export type SetupStepView = Omit<RawStep, "fields" | "paste" | "ownerOnly"> & { paste: { label: string; value: string }[]; fields: SetupField[] };
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

function stepView(raw: RawStep, values: Record<string, string>): SetupStepView {
  const s = { ...raw };
  delete s.ownerOnly; // which installs see a step is decided before this; the page does not carry it
  return {
    ...s,
    paste: s.paste.map((p) => ({ label: p.label, value: fillTemplate(p.value, values) })),
    fields: s.fields.map(field),
  };
}

/** The product's modules (owner plugins are never offered), in manifest order. */
export function productModules(): ProductModule[] {
  return manifests.filter((m) => m.kind === "module").map((m) => ({
    id: m.id, label: m.label, description: m.description, defaultOn: m.defaultOn, hasSetup: Array.isArray(m.setup) && m.setup.length > 0,
  }));
}

/** Which installs see a step: an ownerOnly step only an install with an owner plugin. */
type Audience = { ownerPlugin?: boolean };
const stepsFor = (m: Manifest, { ownerPlugin = false }: Audience): RawStep[] =>
  (m.setup ?? []).filter((s) => ownerPlugin || s.ownerOnly !== true);

/** The setup page of one product module, or null when it has none. A public install (no owner
 *  plugin — the default) never sees an ownerOnly step. */
export function moduleSetupPage(id: string, addresses: SetupAddresses, audience: Audience = {}): SetupPage | null {
  const m = manifests.find((x) => x.id === id && x.kind === "module");
  const steps = m ? stepsFor(m, audience) : [];
  if (!m || !steps.length) return null;
  const values = placeholderValues(addresses);
  return { id: m.id, label: m.label, description: m.description, steps: steps.map((s) => stepView(s, values)) };
}

type CoreList = { id: string; label: string; description: string; release: string; steps: RawStep[] };
const coreLists = SETUP_CORE as unknown as CoreList[];

/** The product's non-module setup lists (Twitch, Kick, Streamplace, the donation services); a
 *  list released 'later' carries no steps yet. */
export function coreSetupLists(): { id: string; label: string; description: string; later: boolean }[] {
  return coreLists.map((c) => ({ id: c.id, label: c.label, description: c.description, later: c.release === "later" }));
}

/** The setup page of one of the product's own lists, or null (unknown, or released later). */
export function coreSetupPage(id: string, addresses: SetupAddresses): SetupPage | null {
  const c = coreLists.find((x) => x.id === id && x.release === "now");
  if (!c?.steps.length) return null;
  const values = placeholderValues(addresses);
  return { id: c.id, label: c.label, description: c.description, steps: c.steps.map((s) => stepView(s, values)) };
}

/** Every key one of the product's lists may write. */
export function coreSetupKeys(id: string): Set<string> {
  const c = coreLists.find((x) => x.id === id && x.release === "now");
  return new Set((c?.steps ?? []).flatMap((s) => s.fields));
}

/** Every key a module's setup page may write — the step save accepts these and nothing else. */
export function moduleSetupKeys(id: string, audience: Audience = {}): Set<string> {
  const m = manifests.find((x) => x.id === id && x.kind === "module");
  return new Set((m ? stepsFor(m, audience) : []).flatMap((s) => s.fields));
}
