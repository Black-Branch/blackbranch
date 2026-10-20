"use client";

import { useEffect } from "react";
import Link from "next/link";
import { reportClientError } from "./lib/clientError";

// Catch-all error boundary for everything below the root layout (any route's
// page, and the (main) layout/providers). Renders inside the root layout's dark
// shell. `reset()` re-renders the failed segment in place — the first thing to
// try, since most client-side throws (a transient Matrix SDK / network hiccup)
// clear on a retry without a full reload.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] render error:", error);
    // The console line above is what the user's own devtools show; this is the
    // copy WE get.
    reportClientError("boundary", error, error.digest);
  }, [error]);

  return (
    <div className="h-dvh overflow-y-auto bg-canvas text-strong flex items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <p className="text-sm font-semibold text-accent">Something broke</p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight text-strong">
          This part of the app hit an error
        </h1>
        <p className="mt-3 text-base leading-relaxed text-secondary">
          It&apos;s not you. Try again — if it keeps happening, reload the page.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-opacity hover:opacity-90"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-lg border border-control px-4 py-2 text-sm font-semibold text-body-dim transition-colors hover:bg-raised"
          >
            Home
          </Link>
        </div>
        {error.digest && (
          <p className="mt-6 text-2xs text-muted">Reference: {error.digest}</p>
        )}
      </div>
    </div>
  );
}
