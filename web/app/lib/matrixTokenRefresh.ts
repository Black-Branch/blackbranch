// The embedded Matrix client's token refresh, done by the SITE.
//
// The refresh token never reaches the browser: /api/matrix/token refreshes server-side and answers
// the session's current access token. Without a refresh function, matrix-js-sdk answers an
// M_UNKNOWN_TOKEN on /sync by STOPPING its sync loop for good — and a token goes unknown routinely:
// it expires while a tab sleeps, and the account server revokes it the moment anything else
// refreshes this session (a media or avatar request on the server, another tab). So the client is
// built with a placeholder refresh token and this function; the SDK then retries the refused
// request with the new token and the sync loop never sees the error.

/** What the SDK stores as "the refresh token". The real one stays on the server. */
export const SERVER_HELD_REFRESH_TOKEN = "server-held";

export type FreshToken = { accessToken: string; expiresAt: number };

type Deps = {
  /** The site's token endpoint (deduped; null when it gave no token). */
  fetchFresh: () => Promise<FreshToken | null>;
  /** The token the client holds now — the one the homeserver refused. */
  current: () => string | null;
  /** A new token arrived: re-arm the proactive refresh from its expiry. */
  onFresh: (fresh: FreshToken) => void;
  /** The SDK's TokenRefreshLogoutError (passed in: the SDK is loaded lazily). */
  LogoutError: new (cause?: Error) => Error;
};

/** The client's `tokenRefreshFunction`. No expiry is returned on purpose: the SDK would then judge
 *  a refused token "not expired yet" against it and give up (refresh.js), when the account server
 *  had revoked it under a rotation. A plain throw is transient (the SDK retries the request later);
 *  a LogoutError ends it. The SDK passes the stored refresh token, which is only the placeholder. */
export function serverTokenRefresher(deps: Deps) {
  return async (): Promise<{ accessToken: string; refreshToken: string }> => {
    const fresh = await deps.fetchFresh();
    if (!fresh) throw new Error("the site gave no Matrix token");
    // The site still holds the very token the homeserver refused: the session is over upstream, and
    // retrying it would loop.
    if (fresh.accessToken === deps.current()) throw new deps.LogoutError(new Error("refused token is still the current one"));
    deps.onFresh(fresh);
    return { accessToken: fresh.accessToken, refreshToken: SERVER_HELD_REFRESH_TOKEN };
  };
}
