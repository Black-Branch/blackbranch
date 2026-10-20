// The instance key cards' VIEW — pure enough to test under `node --test` (no auth import).
// Built from STATUS ONLY: sources, the winning env NAME, `…abcd`, check results as fixed codes —
// never a secret value. The routes are in instanceAdminServer.ts.

import { installValue, installValues, type InstallKey } from "./installValues.ts";
import { instanceState, instanceStatusReport } from "./instanceConfigServer.ts";
import { INSTANCE_KEYS } from "./instanceSchema.generated.mjs";
import { isHostRendered, type HostResult } from "./hostRequests.ts";

type Pkg = "web" | "stream-api" | "stream-ingest";
const PACKAGES: Pkg[] = ["web", "stream-api", "stream-ingest"];

/** True when a mutating request came from this site's own pages. */
export function sameOriginRequest(headers: Headers, siteOrigin: string = installValue("site.origin")): boolean {
  const sfs = headers.get("sec-fetch-site");
  if (sfs !== null) return sfs === "same-origin";
  const origin = headers.get("origin");
  return origin !== null && !!siteOrigin && origin === siteOrigin;
}

export type StreamApiSnapshot = {
  state?: { loaded: boolean; loadedAt: string | null; failingSince: string | null; masterKey?: string };
  values?: Record<string, unknown>;
  meta?: Record<string, { updatedBy: string; updatedAt: string }>;
  secrets?: Record<string, { last4: string; updatedBy: string; updatedAt: string; readable: boolean; error: string | null }>;
  self?: Record<string, PkgStatus>;
  reports?: Record<string, { at: string; state: { loaded: boolean; loadedAt: string | null; failingSince: string | null } | null; keys: Record<string, PkgStatus> }>;
  tests?: { key: string; package: string; testedAt: string; ok: boolean; detail: string; source: string | null; last4: string | null }[];
};
type PkgStatus = { source: string; envName: string | null; display: unknown; error: string | null };

export type InstanceView = {
  processes: { package: Pkg; reachable: boolean; loaded: boolean; loadedAt: string | null; failingSince: string | null; reportedAt?: string | null; masterKey?: string }[];
  keys: {
    key: string; label: string; description: string; tier: string; kind: string; secret: boolean; reload: string;
    module: string; values?: string[]; defaultValue: unknown; testable: boolean; envNames: string[];
    /** Applied by the host re-rendering the homeserver's config, not read by a service. */
    hostApplied: boolean;
    stored: null | { display: unknown; updatedBy: string; updatedAt: string; readable?: boolean; error?: string | null };
    packages: { package: Pkg; known: boolean; source: string | null; envName: string | null; display: unknown; error: string | null; envOverrides: boolean }[];
    tests: { package: string; testedAt: string; ok: boolean; detail: string }[];
    disagree: boolean;
  }[];
  /** bot.name as stream-ingest (which runs the bot and the help desk) resolves it — edited on
   *  the AI page, shown read-only here beside the bot's account. null = unset ("Bot"). */
  botName: string | null;
  /** Where the chat bot can speak, from stream-ingest's report (null = not reported). */
  botSpeakOn: { site: boolean; twitch: string | null } | null;
  /** The setup guides shown above their keys' cards (loadInstanceView adds them). */
  guides?: { list: string; page: import("./setup/setupPages").SetupPage | null; on: boolean | null }[];
  /** This install can ask its host to restart a service (the bundle's request folder exists) —
   *  the Modules card then offers a Restart button. */
  canRestart?: boolean;
  /** A bundle install: its host renders the homeserver (the request folder exists — the same fact
   *  as canRestart). Not one: the homeserver's settings are managed outside Blackbranch. */
  bundle?: boolean;
  /** The host's last answer to a render (a bundle only; null = none yet). */
  render?: HostResult | null;
  /** This build carries the owner plugin: cards marked ownerOnly (adminLayout.ts) are shown. */
  ownerPlugin?: boolean;
};

/** The page's whole view from stream-api's /config snapshot (null = unreachable) and this
 *  process's own status. Built from STATUS ONLY — see the file header. */
export function buildInstanceView(s: StreamApiSnapshot | null, botSpeakOn: InstanceView["botSpeakOn"] = null): InstanceView {
  const webStatus = instanceStatusReport();
  const webState = instanceState();
  const ingest = s?.reports?.["stream-ingest"];
  const processes: InstanceView["processes"] = [
    { package: "web", reachable: true, ...webState },
    { package: "stream-api", reachable: !!s, loaded: !!s?.state?.loaded, loadedAt: s?.state?.loadedAt ?? null, failingSince: s?.state?.failingSince ?? null, masterKey: s?.state?.masterKey },
    { package: "stream-ingest", reachable: !!ingest, loaded: !!ingest?.state?.loaded, loadedAt: ingest?.state?.loadedAt ?? null, failingSince: ingest?.state?.failingSince ?? null, reportedAt: ingest?.at ?? null },
  ];
  // Install keys: the values web read from its environment at boot (installValuesServer.ts).
  const installed = installValues();
  // `surface: 'ai'` keys belong to the AI section; `surface: 'setup'` ones are the setup
  // pages' own progress — neither is a row here.
  const keys = INSTANCE_KEYS.filter((e) => !e.surface).map((e) => {
    const perPkg = (p: Pkg): PkgStatus | null => {
      if (!e.packages.includes(p)) return null;
      if (p === "web") {
        if (e.tier === "install") return { source: "env", envName: e.env[0] ?? null, display: installed[e.key as InstallKey] ?? null, error: null };
        return webStatus[e.key] ?? null;
      }
      if (p === "stream-api") return s?.self?.[e.key] ?? null;
      return ingest?.keys?.[e.key] ?? null;
    };
    const packages = PACKAGES.filter((p) => e.packages.includes(p)).map((p) => {
      const st = perPkg(p);
      return {
        package: p, known: !!st, source: st?.source ?? null, envName: st?.envName ?? null,
        display: st?.display ?? null, error: st?.error ?? null, envOverrides: st?.source === "env" && e.tier !== "install",
      };
    });
    const sec = s?.secrets?.[e.key];
    const plainMeta = s?.meta?.[e.key];
    const stored = e.secret
      ? (sec ? { display: sec.last4 ? `…${sec.last4}` : "(set)", updatedBy: sec.updatedBy, updatedAt: sec.updatedAt, readable: sec.readable, error: sec.error } : null)
      : (plainMeta && s?.values && e.key in s.values ? { display: s.values[e.key], updatedBy: plainMeta.updatedBy, updatedAt: plainMeta.updatedAt } : null);
    const shown = packages.filter((p) => p.display !== null).map((p) => JSON.stringify(p.display));
    return {
      key: e.key, label: e.label, description: e.description, tier: e.tier, kind: e.kind, secret: e.secret,
      reload: e.reload, module: e.module, values: e.values, defaultValue: e.default, testable: !!e.test, envNames: e.env,
      hostApplied: isHostRendered(e.key),
      stored, packages,
      tests: (s?.tests ?? []).filter((t) => t.key === e.key).map((t) => ({ package: t.package, testedAt: t.testedAt, ok: t.ok, detail: t.detail })),
      disagree: new Set(shown).size > 1,
    };
  });
  const ingestName = ingest?.keys?.["bot.name"]?.display;
  const storedName = s?.values?.["bot.name"];
  const botName = typeof ingestName === "string" ? ingestName : typeof storedName === "string" ? storedName : null;
  return { processes, keys, botName, botSpeakOn };
}

