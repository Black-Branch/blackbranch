// The two Matrix delegation documents this site serves at its apex — built from the install's
// `matrix.*` config, not static files. Pure builders, so `node --test` pins the
// exact JSON; the route handlers in app/.well-known/matrix/ only add the transport.
//
// `.well-known/matrix/client` tells every Matrix client (and the federated sign-in of other
// sites) where this server name's homeserver is, and which OAuth issuer it signs in with — both
// the stable `m.authentication` key and the unstable MSC2965 one, which older clients still read.
// `account` is the DISCOVERED account page; when discovery is down it is
// omitted rather than guessed — the homeserver half of this document must never depend on the
// auth server being up. `.well-known/matrix/server` is federation delegation (`m.server`).

export type ClientWellKnown = {
  "m.homeserver": { base_url: string };
  "m.authentication"?: { issuer: string; account?: string };
  "org.matrix.msc2965.authentication"?: { issuer: string; account?: string };
};

export function clientWellKnown(baseUrl: string, issuer: string, account: string | null): ClientWellKnown {
  const doc: ClientWellKnown = { "m.homeserver": { base_url: baseUrl } };
  if (issuer) {
    const auth = account ? { issuer, account } : { issuer };
    doc["m.authentication"] = auth;
    doc["org.matrix.msc2965.authentication"] = { ...auth };
  }
  return doc;
}

export function serverWellKnown(federationServer: string): { "m.server": string } {
  return { "m.server": federationServer };
}

/** The headers both documents carry: JSON, readable from any origin (Matrix web clients fetch
 *  them cross-origin — the spec requires CORS here). */
export const WELL_KNOWN_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "X-Requested-With, Content-Type, Authorization",
};
