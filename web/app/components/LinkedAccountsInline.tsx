"use client";

import { useEffect, useState } from "react";
import AccountLinkPanel from "./AccountLinkPanel";
import { LoadingState } from "./Spinner";

type Data = {
  linked: { platform: string; displayName: string | null; linkedAt: string; missingScopes: string[]; expired: boolean }[];
  configuredPlatforms: string[];
  showLinks: boolean;
};

// Renders the Linked Accounts panel inside the user-menu overlay (instead of
// navigating to /settings/accounts) by fetching the same data the server page
// computes. Linking still redirects out for OAuth; unlink stays in place.
export default function LinkedAccountsInline() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account-links", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { accounts?: { platform: string; displayName: string | null; linkedAt: string; missingScopes?: string[]; expired?: boolean }[]; configuredPlatforms?: string[]; showLinks?: boolean }) => {
        if (cancelled) return;
        setData({
          linked: (d.accounts ?? []).map((a) => ({
            platform: a.platform,
            displayName: a.displayName,
            linkedAt: a.linkedAt,
            missingScopes: a.missingScopes ?? [],
            expired: a.expired === true,
          })),
          configuredPlatforms: d.configuredPlatforms ?? [],
          showLinks: d.showLinks === true,
        });
      })
      .catch(() => !cancelled && setErr(true));
    return () => {
      cancelled = true;
    };
  }, []);

  if (err) return <p className="px-3 py-4 text-xs text-muted">Couldn’t load linked accounts.</p>;
  if (!data) return <LoadingState className="px-3 py-4" />;

  return (
    <div className="p-3">
      <AccountLinkPanel
        linked={data.linked}
        configuredPlatforms={data.configuredPlatforms}
        showLinks={data.showLinks}
      />
    </div>
  );
}
