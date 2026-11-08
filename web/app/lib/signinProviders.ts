// Sign-in providers (ADR 0154): the address each provider sends a person back to after they sign in
// there — the sign-in service's own callback for that provider's id (signinProviderId in the schema:
// fixed for Google, Discord and Twitch, derived from the issuer for the OpenID slot). MAS serves it
// under its public base, which the bundle renders as the issuer (install/matrix/render.sh), as
// `<issuer>/upstream/callback/<id>`.

/** The redirect URL an owner pastes at the provider for one provider id; null without an issuer. */
export function signinRedirectUrl(issuer: string | null | undefined, providerId: string): string | null {
  const base = (issuer ?? "").trim();
  if (!/^https?:\/\/[^\s/]+/.test(base)) return null;
  return `${base.endsWith("/") ? base : `${base}/`}upstream/callback/${providerId}`;
}
