// The platform ids the site finds itself from a channel name: Twitch's broadcaster id, Kick's user
// id, a Streamplace account's DID. The Admin Panel shows them read-only beside the channel and
// finds them again whenever the channel (or the app keys that let the site ask) changes. Pure, so
// the finding is tested without a network: the caller passes the provider check and fetch.

/** Each derived id: the setting it comes from, and the settings a change to which finds it again. */
export const DERIVED_IDS: Readonly<Record<string, { from: string; via: readonly string[] }>> = {
  "platform.twitch.broadcasterId": { from: "platform.twitch.channel", via: ["platform.twitch.channel", "twitch.clientId", "twitch.clientSecret"] },
  "platform.kick.userId": { from: "platform.kick.slug", via: ["platform.kick.slug", "kick.clientId", "kick.clientSecret"] },
  "platform.streamplace.did": { from: "platform.streamplace.channel", via: ["platform.streamplace.channel"] },
};

/** The derived ids a saved setting should find again. */
export function idsFoundFrom(saved: string): string[] {
  return Object.entries(DERIVED_IDS).filter(([, d]) => d.via.includes(saved)).map(([id]) => id);
}

type Check = (test: string, get: (k: string) => unknown, fetchImpl: typeof fetch) => Promise<unknown>;
export type Found = { ok: true; id: string } | { ok: false; why: string };

const PROVIDER_TEST: Record<string, string> = { "platform.twitch.broadcasterId": "twitch", "platform.kick.userId": "kick" };

/** Find one derived id. `get` reads the saved settings; the id's own saved value is ignored, so a
 *  changed channel replaces it rather than being reported as a mismatch. */
export async function findDerivedId(idKey: string, get: (k: string) => unknown, check: Check, fetchImpl: typeof fetch): Promise<Found> {
  const d = DERIVED_IDS[idKey];
  if (!d) return { ok: false, why: "not an id the site finds" };
  const from = String(get(d.from) ?? "").trim();
  if (!from) return { ok: false, why: "set the channel first" };
  const test = PROVIDER_TEST[idKey];
  if (test) {
    const r = (await check(test, (k) => (k === idKey ? "" : get(k)), fetchImpl).catch(() => null)) as { ok?: boolean; code?: string; id?: unknown } | null;
    if (r?.ok && typeof r.id === "string" && /^\d{1,20}$/.test(r.id)) return { ok: true, id: r.id };
    if (r?.code === "not_set") return { ok: false, why: "it is found once the app keys are set" };
    if (r?.code === "not_found") return { ok: false, why: "no channel by that name" };
    return { ok: false, why: "the platform did not answer; try again later" };
  }
  // Streamplace: a Bluesky handle resolves to its DID through the public directory.
  try {
    const res = await fetchImpl(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(from.replace(/^@/, "").toLowerCase())}`,
      { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (res.status === 400) return { ok: false, why: "no account by that handle" };
    const did = res.ok ? ((await res.json().catch(() => null)) as { did?: unknown } | null)?.did : null;
    if (typeof did === "string" && /^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]{1,253})$/.test(did)) return { ok: true, id: did };
    return { ok: false, why: "the directory did not answer; try again later" };
  } catch {
    return { ok: false, why: "the directory did not answer; try again later" };
  }
}
