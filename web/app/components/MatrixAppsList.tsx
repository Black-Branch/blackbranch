"use client";

import { useState } from "react";
import { useMatrixIdentity } from "@/app/lib/MatrixClientContext";
import { copyText } from "@/app/lib/clipboard";
import { matrixServerName } from "@/app/lib/matrixConfig";
import { siteName } from "@/app/lib/siteName";

// The Matrix-app instructions + app list + Matrix ID, shown when steering a
// mobile user toward a dedicated Matrix client. Our homeserver is MAS/OIDC-only,
// so the app copy steers to OIDC-capable clients and away from FluffyChat (which
// can't sign in here). Rendered by MatrixAppsHint's contextual nudge.


const APPS: { name: string; tag?: string; href: string; note: string }[] = [
  { name: "Element", tag: "recommended", href: "https://element.io/download", note: "Full-featured — mobile, desktop & web" },
  { name: "Element X", href: "https://element.io/download", note: "Newer, faster Element — iOS & Android" },
  { name: "Cinny", href: "https://app.cinny.in", note: "Clean web client — works in any browser" },
  { name: "SchildiChat", href: "https://schildi.chat", note: "Element fork with a chat-app feel" },
];

function ExtLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}

export function MatrixAppsList() {
  const { matrixId } = useMatrixIdentity();
  const [copied, setCopied] = useState(false);

  async function copyId() {
    if (!matrixId) return;
    if (await copyText(matrixId)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-secondary leading-relaxed">
        Your account works in any Matrix app. Install one, choose
        <span className="text-body font-medium"> “Other” / “Edit homeserver”</span>, and enter
        <span className="text-body font-mono"> {matrixServerName()}</span> — you’ll sign in with your normal {siteName()} login.
      </p>

      <div className="space-y-1.5">
        {APPS.map((a) => (
          <ExtLink
            key={a.name}
            href={a.href}
            className="flex items-center justify-between gap-2 rounded-lg bg-surface-1 hover:bg-surface-2 border border-edge px-3 py-2 transition-colors"
          >
            <span className="min-w-0">
              <span className="text-sm text-strong font-medium">{a.name}</span>
              {a.tag && (
                <span className="ml-1.5 text-3xs uppercase tracking-wide px-1 py-px rounded bg-emerald-400/15 border border-emerald-400/30 text-emerald-300 font-semibold">
                  {a.tag}
                </span>
              )}
              <span className="block text-2xs text-muted truncate">{a.note}</span>
            </span>
            <span className="text-muted text-xs shrink-0">↗</span>
          </ExtLink>
        ))}
      </div>

      <p className="text-2xs text-muted">
        More options in the{" "}
        <ExtLink href="https://matrix.org/ecosystem/clients/" className="text-accent hover:underline">
          Matrix client directory
        </ExtLink>
        . Avoid FluffyChat — it can’t sign in on our server.
      </p>

      {matrixId && (
        <button
          onClick={copyId}
          title="Copy"
          className="w-full flex items-center justify-between gap-2 text-left rounded-lg bg-surface-1 hover:bg-surface-2 border border-edge px-3 py-2 transition-colors"
        >
          <span className="min-w-0">
            <span className="block text-3xs uppercase tracking-wide text-muted">Your Matrix ID</span>
            <span className="text-xs text-body font-mono break-all">{matrixId}</span>
          </span>
          <span className="text-2xs text-secondary shrink-0">{copied ? "Copied ✓" : "Copy"}</span>
        </button>
      )}
    </div>
  );
}
