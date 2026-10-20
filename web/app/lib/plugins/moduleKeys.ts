import type { WebPlugin } from "./types.ts";

type ModuleKind = { id: string; kind: string };

/**
 * A key is installed unless it belongs to an owner-only module no plugin implements. Product
 * modules (and core keys, `module` null or not a module id) are always installed.
 */
export function moduleKeyInstalled(module: string | null, modules: readonly ModuleKind[], plugin: WebPlugin | null): boolean {
  const m = modules.find((x) => x.id === module);
  if (!m || m.kind !== "owner") return true;
  return !!plugin?.ownerModules?.includes(m.id);
}
