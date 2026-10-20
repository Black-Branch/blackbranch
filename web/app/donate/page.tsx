import type { Metadata } from "next";
import { auth } from "@/auth";
import pool from "@/lib/db";
import { SITE_NAME } from "@/app/lib/legal";
import { parseAmountParam } from "./amountParam";
import { DonateClient } from "./DonateClient";
import { instanceString } from "@/app/lib/instanceConfigServer";
import { paypalConfigured } from "@/app/lib/paypalClient";

// The public tip page — an address you can paste in chat. Top-level, OUTSIDE
// app/(main)/, so it inherits the root layout only: no nav, no chat, no video.
// That is by construction, not by hiding anything on top of the main shell.

export const metadata: Metadata = {
  title: `Tip — ${SITE_NAME}`,
  description: `Send a one-off tip to ${SITE_NAME}.`,
};

export const dynamic = "force-dynamic";

export default async function DonatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const initialAmount = parseAmountParam(sp.amount);

  // Signed in -> prefill the name. Signed out is still the FIRST-CLASS case
  // here: no account WALL anywhere on this page — but TipForm's own
  // `signedIn` prop does show a one-line "sign in to also get N Qorm" nudge
  // for a guest (see DonateClient's header).
  const session = await auth();
  const signedIn = Boolean(session?.user?.id);
  let initialName = "";
  if (session?.user?.id) {
    const { rows } = await pool
      .query<{ display_name: string | null }>(
        `SELECT display_name FROM site.users WHERE matrix_id = $1`,
        [session.user.id],
      )
      .catch(() => ({ rows: [] as { display_name: string | null }[] }));
    initialName = rows[0]?.display_name ?? "";
  }

  // Read at request time (this page is force-dynamic) rather than a
  // NEXT_PUBLIC_* build-time var — see DonateClient's paypalClientId prop
  // docs for why.
  // paypalConfigured(): the same answer /api/billing/stripe/config gives — a
  // switched-off or half-set-up PayPal shows no button (a bare client id did).
  const paypalClientId = paypalConfigured() ? (instanceString("paypal.clientId") || null) : null;
  // Same rule as paypalApiBase(): anything but "live" is the sandbox (the SDK's buyer-country).
  const paypalSandbox = paypalClientId !== null && instanceString("paypal.env") !== "live";

  return (
    <DonateClient
      initialAmount={initialAmount}
      initialName={initialName}
      paypalClientId={paypalClientId}
      paypalSandbox={paypalSandbox}
      signedIn={signedIn}
    />
  );
}
