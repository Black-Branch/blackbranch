// Pure: which steps setup skipped are still open, in words. setup.state.skipped is written only by
// setup (`<page>:<step>` records), so the Doctor judges each record when it reads it: a step whose
// values are all set now (the setup page's own isSet test) is done, and a step with no values (add
// the rig page to OBS) is never "done", so neither is listed.

import { MODULES } from "../instanceSchema.generated.mjs";
import { moduleSetupPage, wizardLists, wizardListPage, wizardSkipPrefix, type SetupPage } from "../setup/setupPages.ts";
import { SETUP_GUIDES } from "../setup/setupGuideMap.ts";

// The pages are built only for their titles and fields; a paste line's address is never read here.
const NO_ADDRESSES = { origin: "https://site.invalid", apiOrigin: "https://site.invalid", matrixOrigin: "https://site.invalid", serverName: "site.invalid" };

/** Every setup page a skip record can name: its record prefix, its list (`module:<id>` /
 *  `core:<id>`) and the page as setup showed it. */
export function skipPages(ownerPlugin: boolean): { prefix: string; list: string; page: SetupPage }[] {
  const out: { prefix: string; list: string; page: SetupPage }[] = [];
  for (const m of MODULES as readonly { id: string }[]) {
    const page = moduleSetupPage(m.id, NO_ADDRESSES, { ownerPlugin, wizard: true });
    if (page) out.push({ prefix: m.id, list: `module:${m.id}`, page });
  }
  for (const w of wizardLists()) {
    const page = wizardListPage(w.id, NO_ADDRESSES);
    const prefix = wizardSkipPrefix(w.id);
    if (page) out.push({ prefix, list: `core:${prefix}`, page });
  }
  return out;
}

/** The skipped steps still open, as "<page>: <step> (Admin Panel → <place>)". */
export function openSkips(records: readonly string[], pages: ReturnType<typeof skipPages>, isSet: (key: string) => boolean): string[] {
  const out: string[] = [];
  for (const r of records) {
    const at = r.lastIndexOf(":");
    const p = pages.find((x) => x.prefix === r.slice(0, at));
    const step = p?.page.steps.find((s) => s.id === r.slice(at + 1));
    if (!p || !step || !step.fields.length || step.fields.every((f) => isSet(f.key))) continue;
    const place = SETUP_GUIDES.find((g) => g.list === p.list)?.place;
    out.push(`${p.page.label}: ${step.title}${place ? ` (Admin Panel → ${place})` : ""}`);
  }
  return out;
}
