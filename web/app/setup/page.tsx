// /setup — the first-boot setup pages. While setup is unfinished proxy.ts sends every page here;
// the server decides what this browser sees (app/lib/setup/setupServer.ts `setupView`) and every
// value is checked again there.
import type { Metadata } from "next";
import { auth } from "@/auth";
import { installValue } from "@/app/lib/installValues";
import { setupView } from "@/app/lib/setup/setupServer";
import { SetupWizard } from "@/app/features/setup";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Setup",
  robots: { index: false, follow: false },
  // The setup link carries its token in the address: never hand it to another site.
  referrer: "no-referrer",
};

export default async function SetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : null;
  const session = await auth().catch(() => null);
  const view = await setupView(session?.user?.id ?? null, token);
  const origin = installValue("site.origin");
  return (
    <SetupWizard view={view} token={token} siteName={installValue("site.name")}
      serverName={installValue("matrix.serverName")} domain={origin.replace(/^https?:\/\//, "")} />
  );
}
