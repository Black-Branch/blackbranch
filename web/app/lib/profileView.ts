// What the public profile card (GET /api/user/[id]) may show about the identity it was asked
// about — the one decision every field of that route follows.
//
// Owner decision 2026-10-17: a person's cross-platform link is shown only where they show it
// themselves (posting from the site to several platforms at once, or the "show my linked platforms"
// switch, site.users.show_links). Matching names are not consent. So, unless the caller is a
// moderator, is the person, or the person opted in:
//   • no linked site account, Matrix id, site name or platform list for a platform identity;
//   • no stats merged across platforms and no pronouns (they are held per person, not per
//     platform) — identical numbers on a Twitch card and a YouTube card would publish the link as
//     surely as an id. The card carries the stats of the ONE identity asked about instead, for
//     every person alike, so their presence says nothing about a link (publicProfile.ts);
//   • a SITE identity (a site line's public id, or a Matrix id) keeps what is the site account's
//     own: its banner and its Matrix id (the handle the community and DMs show).
// Pure: the route resolves the facts, this decides.

export type ProfileFacts = {
  /** The caller moderates this site. */
  isMod: boolean;
  /** The caller is the person (their session's canonicals or Matrix id cover it). */
  isSelf: boolean;
  /** The person's site account has switched show_links on. */
  showLinks: boolean;
  /** The id asked about is the site identity (a native public id or a Matrix id), not a platform's. */
  siteKey: boolean;
};

export type ProfileView = {
  /** matrixId (for a platform key), siteName, linkedPlatforms, the merged stats, pronouns. */
  links: boolean;
  /** The site account's own banner and Matrix id. */
  site: boolean;
};

export function profileView(f: ProfileFacts): ProfileView {
  const full = f.isMod || f.isSelf || f.showLinks;
  return { links: full, site: full || f.siteKey };
}
