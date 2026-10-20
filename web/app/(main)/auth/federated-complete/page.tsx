"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { LoadingState } from "@/app/components/Spinner";

function FederatedCompleteInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!token) {
      // `replace`, not `push` — arriving here without a token means the link was
      // malformed or already consumed, and Back should not return to a dead page.
      router.replace("/auth/signin?error=missing_token");
      return;
    }
    signIn("federated-completion", { token, callbackUrl: "/", redirect: false }).then((res) => {
      if (!res || res.error) {
        setFailed(true);
      } else {
        // Deliberately a HARD navigation, unlike the soft `replace` above: the
        // session cookie was only just set by `signIn(..., redirect: false)`, and a
        // full load is what guarantees every server component re-reads it. Do not
        // "make this consistent" with a router call.
        window.location.href = res.url ?? "/";
      }
    });
  }, [token, router]);

  if (failed) {
    return (
      <div className="text-center space-y-3">
        <p className="text-sm text-red-400">Sign-in link expired, already used, or opened in another browser.</p>
        <p className="text-xs text-muted">Links work for 2 minutes, in the browser you signed in with.</p>
        <a href="/auth/signin" className="block text-sm text-secondary hover:text-strong underline transition-colors">
          Back to sign in
        </a>
      </div>
    );
  }

  return <p className="text-sm text-secondary">Completing sign in…</p>;
}

export default function FederatedCompletePage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Suspense fallback={<LoadingState />}>
        <FederatedCompleteInner />
      </Suspense>
    </div>
  );
}
