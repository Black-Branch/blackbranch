// @test-only test infrastructure — the password sign-in the homeserver suites (*.hs.test.ts) share.
//
// MAS rate-limits password sign-ins per ADDRESS, not per account: a burst of three, then about
// one every 20 s (measured against a throwaway). Every suite signs in from the same address, so
// whether a sign-in is refused depends on how many came before it in the whole run — one suite
// signing in two accounts and the next signing in twice gets 429 on the fourth where the test
// demands 403, while each suite alone passes.
//
// MAS's 429 carries neither Retry-After nor retry_after_ms, so the wait is fixed: 10 s, at most six
// times (60 s) — past one refill, never open-ended. Any other status, including 403, is returned
// as it is: only the rate limit is waited out, never the answer.

/** POST /_matrix/client/v3/login (m.login.password) at `base` (MAS's compat API), waiting out a 429. */
export async function hsPasswordLogin(base: string, user: string, password: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base.replace(/\/+$/, "")}/_matrix/client/v3/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user }, password }),
    });
    if (res.status !== 429 || attempt >= 6) return res;
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
