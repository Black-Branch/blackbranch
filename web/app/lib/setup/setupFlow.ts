// The setup pages' order and where a returning browser lands. Pure.
//
//   admin → recovery → site → points → modules → module:<id>… → core:<id>… → community → finish
//
// One step per module that is switched on and has setup steps in its manifest, then one per
// product list chosen on the modules page (where you stream, other donation services). The saved step is
// `setup.state.step`; it is written as each page is saved, so a closed browser comes back to it.
// The first two are one-way: the account exists once made, and the recovery sheet is shown once —
// Back never reaches them.

const FIXED_BEFORE = ["admin", "recovery", "site", "points", "modules"] as const;
const FIXED_AFTER = ["community", "finish"] as const;
const ONE_WAY = new Set<string>(["admin", "recovery"]);

export function stepOrder(moduleSteps: readonly string[], coreSteps: readonly string[] = []): string[] {
  return [...FIXED_BEFORE, ...moduleSteps.map((id) => `module:${id}`), ...coreSteps.map((id) => `core:${id}`), ...FIXED_AFTER];
}

/**
 * The step to show. No admin yet → the first step, whatever was saved. Otherwise the saved step
 * when it is still in the order; a saved module step whose module was switched off since → the
 * modules page; nothing saved → the recovery sheet (the step after the account).
 */
export function resumeStep(saved: string | null | undefined, order: readonly string[], adminExists: boolean): string {
  if (!adminExists) return "admin";
  if (saved && saved !== "admin" && order.includes(saved)) return saved;
  if (saved?.startsWith("module:") || saved?.startsWith("core:")) return "modules";
  return "recovery";
}

/** The pages the operator has opened, with `page` added: the Doctor counts a module whose
 *  keys were never set as failing only once its page was visited. In order of first visit, each
 *  once; the record's own bound (50) keeps the oldest. */
export function recordVisit(visited: readonly string[] | undefined, page: string): string[] {
  const out = [...(visited ?? [])];
  if (!out.includes(page) && out.length < 50) out.push(page);
  return out;
}

export function nextStep(current: string, order: readonly string[]): string | null {
  const i = order.indexOf(current);
  return i >= 0 && i < order.length - 1 ? order[i + 1]! : null;
}

/** The step Back goes to, or null where Back is not offered. */
export function previousStep(current: string, order: readonly string[]): string | null {
  const i = order.indexOf(current);
  if (i <= 0) return null;
  const prev = order[i - 1]!;
  return ONE_WAY.has(prev) ? null : prev;
}

/** May a page save this step now? Only the step the browser is on, or one already passed
 *  (Back) — never a step ahead, and never one of the one-way steps once passed. */
export function maySave(step: string, current: string, order: readonly string[]): boolean {
  const s = order.indexOf(step), c = order.indexOf(current);
  if (s < 0 || c < 0) return false;
  if (s === c) return true;
  return s < c && !ONE_WAY.has(step);
}
