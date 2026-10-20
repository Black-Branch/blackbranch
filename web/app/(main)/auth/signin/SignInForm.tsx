"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { deviceIdForSignIn, clearDeviceId } from "@/app/lib/deviceId";
import { clearAllMatrixDatabases } from "@/app/lib/MatrixClientContext";
import { runSignOutHooks } from "@/app/lib/plugins/session";
import { useEffect, useState } from "react";
import { siteName } from "@/app/lib/siteName";
import { federatedLine, signupLine, type SignInOptions } from "./signInOptions";

// The sign-in page's form. The page (page.tsx) reads the install's settings and passes what this
// shows: whether the "another server" box is offered, and what can be said about new accounts.

// What the federated routes answer (and the callback sends back as ?error=) when the site's
// sign-in policy does not admit the server (federatedSignInSwitch.ts).
const SERVER_NOT_ENABLED = "Sign-in from this server isn't enabled on this site.";
const CALLBACK_ERRORS: Record<string, string> = {
  federated_signin_disabled: SERVER_NOT_ENABLED,
  server_mismatch: "That sign-in finished as an account on a different server. Try again with the account you entered.",
};

export default function SignInForm({ options }: { options: SignInOptions }) {
  const fedLine = federatedLine(options.federated);
  const [mxid, setMxid] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [signinError, setSigninError] = useState<string | null>(null);
  const [federatedError, setFederatedError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);

  // A federated sign-in that the callback refused comes back here as ?error=<code>.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    const msg = code ? CALLBACK_ERRORS[code] : undefined;
    if (msg) Promise.resolve().then(() => setFederatedError(msg));
  }, []);

  async function handleSignIn() {
    setSigningIn(true);
    setSigninError(null);
    try {
      // Reuses the stored device ID only when its crypto store is intact —
      // verification then survives re-login. Otherwise mints a fresh device.
      const deviceId = await deviceIdForSignIn();
      const res = await fetch("/api/auth/mas-initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      if (!res.ok) {
        // 503 = the homeserver's sign-in discovery is down (mas-initiate) — say so, rather
        // than inviting a retry loop against a server that is not answering.
        setSigninError(res.status === 503
          ? "Sign-in is unavailable right now — the account server is not answering. Try again in a few minutes."
          : "Failed to start sign in. Try again.");
        return;
      }
      const { authorizationUrl } = await res.json();
      window.location.href = authorizationUrl;
    } catch {
      setSigninError("Something went wrong. Try again.");
    } finally {
      setSigningIn(false);
    }
  }

  async function handleFederatedSignIn() {
    const trimmed = mxid.trim();
    if (!trimmed.match(/^@[^:]+:.+$/)) {
      setFederatedError("Enter a full Matrix ID, e.g. @you:matrix.org");
      return;
    }
    setFederatedError(null);
    setDiscovering(true);

    try {
      // Step 1: discover homeserver OIDC config — BEFORE signing anyone out, so a server this site
      // does not admit (or cannot reach) leaves the current sign-in alone.
      const discoverRes = await fetch(`/api/auth/matrix-discover?mxid=${encodeURIComponent(trimmed)}`);
      const discovered = await discoverRes.json();

      if (!discoverRes.ok) {
        const msgs: Record<string, string> = {
          federated_signin_disabled: SERVER_NOT_ENABLED,
          no_oidc: "That server doesn't support OIDC login yet.",
          well_known_unreachable: "Couldn't reach that Matrix server.",
          well_known_failed: "That server's .well-known returned an error.",
          oidc_discovery_unreachable: "Couldn't reach that server's OIDC provider.",
        };
        setFederatedError(msgs[discovered.error] ?? "Discovery failed. Try again.");
        return;
      }

      if (!discovered.registrationEndpoint) {
        setFederatedError("That server doesn't support dynamic client registration.");
        return;
      }

      // Sign out of any existing session first so the new session cookie always
      // wins. Switching accounts invalidates the local crypto identity, so the
      // store and device ID are discarded together (deviceId.ts invariant).
      const sessionRes = await fetch("/api/auth/session");
      const sessionData = await sessionRes.json().catch(() => null);
      if (sessionData?.user) {
        await fetch("/api/matrix/logout", { method: "POST" }).catch(() => {});
        await clearAllMatrixDatabases();
        clearDeviceId();
        runSignOutHooks();
        await signOut({ redirect: false });
      }

      // Step 2: register + get PKCE authorization URL
      // Forward the browser's per-device ID so the federated token is scoped to this device.
      const deviceId = await deviceIdForSignIn();
      const initiateRes = await fetch("/api/auth/matrix-initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...discovered, deviceId }),
      });
      const initiated = await initiateRes.json();

      if (!initiateRes.ok) {
        setFederatedError(initiated?.error === "federated_signin_disabled" ? SERVER_NOT_ENABLED : "Failed to start login with that server. Try again.");
        return;
      }

      // Step 3: redirect to external homeserver authorization page
      window.location.href = initiated.authorizationUrl;
    } catch {
      setFederatedError("Something went wrong. Try again.");
    } finally {
      setDiscovering(false);
    }
  }

  return (
    // h-full + overflow-y-auto, NOT min-h-screen: the app shell disables
    // document scroll (body is h-dvh overflow-hidden), so this wrapper must be
    // the scroll container or a short viewport just clips the form — the rule
    // mod/page.tsx documents. min-h-full on the inner flex keeps the card
    // centered when there IS room.
    <div className="h-full overflow-y-auto">
      <div className="min-h-full flex items-center justify-center py-10">
      <div className="flex flex-col gap-8 items-center w-full max-w-sm px-4">
        <Link href="/" className="self-start text-muted hover:text-body-dim text-sm transition-colors">
          ← Back
        </Link>
        <h1 className="text-2xl font-bold">Sign in to {siteName()}</h1>

        {/* this site's own account */}
        <div className="flex flex-col gap-3 items-center w-full">
          <button
            type="button"
            onClick={handleSignIn}
            disabled={signingIn}
            // Theme tokens (bg-strong/text-on-accent), not bg-white/text-black,
            // so the primary button follows the active theme.
            className="w-full px-6 py-3 bg-strong text-on-accent rounded font-semibold hover:bg-body transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {signingIn ? "Connecting…" : "Sign in"}
          </button>
          {signinError && <p className="text-xs text-red-400">{signinError}</p>}
          <p className="text-xs text-muted text-center" data-signup-line={options.signup}>
            {signupLine(options.signup, siteName())}
          </p>
          {/* A refused federated sign-in coming back while the box is hidden still says why. */}
          {fedLine === null && federatedError && <p className="text-xs text-red-400">{federatedError}</p>}
        </div>

        {/* Sign-in with an account on another server: only when the site allows it. */}
        {fedLine !== null && (<>
        <div className="flex items-center gap-3 w-full">
          <div className="flex-1 h-px bg-control" />
          <span className="text-xs text-muted whitespace-nowrap">or use a Matrix account from another server</span>
          <div className="flex-1 h-px bg-control" />
        </div>

        {/* External Matrix homeserver login */}
        <div className="flex flex-col gap-3 w-full" data-federated={options.federated}>
          {fedLine && <p className="text-xs text-muted text-center">{fedLine}</p>}
          <input
            type="text"
            value={mxid}
            onChange={e => { setMxid(e.target.value); setFederatedError(null); }}
            onKeyDown={e => e.key === "Enter" && handleFederatedSignIn()}
            placeholder="@you:matrix.org"
            className="w-full px-4 py-3 rounded bg-raised text-strong placeholder-muted border border-control focus:outline-none focus:border-control-strong"
            autoComplete="username"
            spellCheck={false}
          />
          {federatedError && (
            <p className="text-xs text-red-400">{federatedError}</p>
          )}
          <button
            type="button"
            onClick={handleFederatedSignIn}
            disabled={discovering || !mxid.trim()}
            className="w-full px-6 py-3 bg-control text-strong rounded font-semibold hover:bg-control transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {discovering ? "Connecting…" : "Continue"}
          </button>
        </div>
        </>)}

        <p className="text-xs text-muted text-center">
          By signing in you agree to our{" "}
          <a href="/legal#terms" className="underline hover:text-body-dim">Terms</a>{" "}
          and{" "}
          <a href="/legal#privacy" className="underline hover:text-body-dim">Privacy Policy</a>.
        </p>
      </div>
      </div>
    </div>
  );
}
