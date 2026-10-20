// The install values' SERVER half: resolved from this process's environment at
// boot, published for every module of the process, and handed to the browser in the page.
// SERVER ONLY — it imports the generated schema, which is not for the client bundle.
//
// installValues.ts says why nothing is built in. What this file adds:
//   • resolveInstallValues(env) — the schema's own resolver over every install key web reads; a
//     REQUIRED one missing or any one malformed is a problem, and instrumentation.ts EXITS on a
//     problem (a site cannot run without knowing its own name and addresses);
//   • publishInstallValues() — the resolved values into process.env.INSTALL_VALUES, once, before
//     the first request (instrumentation.ts);
//   • installValuesAttribute() — the JSON the root layout writes on <html> (data-bb-install), so
//     the browser reads the same values (only `scope: 'public'` keys — every install key web reads
//     is public, and a server-scope one could never leave the server by this path).

import { INSTANCE_KEYS, resolveInstanceValue } from "./instanceSchema.generated.mjs";
import { INSTALL_HOLDER, installValues, type InstallHolder, type InstallValues } from "./installValues.ts";

const WEB_INSTALL_KEYS = INSTANCE_KEYS.filter((e) => e.tier === "install" && e.packages.includes("web"));

/** Every install key web reads, resolved from `env`. Unset optional keys are left out.
 *  @test-only exported so the boot's rules are tested directly; publishInstallValues is its caller. */
export function resolveInstallValues(env: Record<string, string | undefined>): { values: InstallValues; problems: string[] } {
  const values: Record<string, string> = {};
  const problems: string[] = [];
  for (const e of WEB_INSTALL_KEYS) {
    const r = resolveInstanceValue(e, env, null);
    if (r.error) problems.push(`${e.key}: ${r.error}`);
    else if (typeof r.value === "string" && r.value) values[e.key] = r.value;
    else if (e.required) problems.push(`${e.key} is required — set ${e.env[0]} in this site's environment`);
  }
  return { values: values as InstallValues, problems };
}

/** Boot: resolve and publish. Returns the problems — the caller exits on any.
 *  Publishing into THIS process's env also fills the process-wide holder (installValues.ts says why:
 *  `next dev` can reset process.env and delete the key) and leaves it a resolver over the then-current
 *  environment, so a reader never answers blank while the environment still holds the values. */
export function publishInstallValues(env: Record<string, string | undefined> = process.env): string[] {
  const { values, problems } = resolveInstallValues(env);
  env.INSTALL_VALUES = JSON.stringify(values);
  if (env === process.env) {
    const h: InstallHolder = { raw: env.INSTALL_VALUES, resolve: () => JSON.stringify(resolveInstallValues(process.env).values) };
    (globalThis as Record<symbol, InstallHolder | undefined>)[INSTALL_HOLDER] = h;
  }
  return problems;
}

const PUBLIC_KEYS = new Set<string>(WEB_INSTALL_KEYS.filter((e) => e.scope === "public").map((e) => e.key));

/** The public install values as JSON for the <html> element's attribute (React escapes it as an
 *  attribute value, so no value can break out of it). */
export function installValuesAttribute(values: InstallValues = installValues()): string {
  const pub: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (PUBLIC_KEYS.has(k) && typeof v === "string") pub[k] = v;
  return JSON.stringify(pub);
}
