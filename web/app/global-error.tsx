"use client";

import { useEffect } from "react";
import { reportClientError } from "./lib/clientError";
import { siteName } from "./lib/siteName";

// Last-resort boundary: catches errors thrown by the ROOT layout itself, so it
// replaces <html>/<body> entirely and cannot assume the app stylesheet loaded —
// all styling is inlined. This is the only thing standing between a root-layout
// throw and a fully blank white page.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global] root layout error:", error);
    // This boundary REPLACES the root layout, so ClientErrorReporter — mounted
    // inside it — is not running. Nothing else can report a root-layout throw,
    // which also makes it the report we can least afford to lose: reportClientError
    // is written never to throw for exactly this call site.
    reportClientError("global-boundary", error, error.digest);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "#09090b",
          color: "#fff",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
        }}
      >
        <div style={{ width: "100%", maxWidth: "28rem", textAlign: "center" }}>
          <p style={{ fontSize: "14px", fontWeight: 600, color: "#99c1f1", margin: 0 }}>
            Something broke
          </p>
          <h1
            style={{
              margin: "12px 0 0",
              fontSize: "22px",
              fontWeight: 700,
              letterSpacing: "-0.01em",
              color: "#fafafa",
            }}
          >
            {siteName()} hit an unexpected error
          </h1>
          <p style={{ margin: "12px 0 0", fontSize: "15px", lineHeight: 1.6, color: "#a1a1aa" }}>
            Reloading usually fixes it. If it doesn&apos;t, try again in a moment.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "32px",
              border: "none",
              borderRadius: "8px",
              background: "#99c1f1",
              color: "#09090b",
              padding: "8px 16px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
          {error.digest && (
            <p style={{ marginTop: "24px", fontSize: "11px", color: "#52525b" }}>
              Reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
