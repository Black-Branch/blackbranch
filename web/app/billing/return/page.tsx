import type { Metadata } from "next";
import Link from "next/link";
import { getStripe, stripeConfigured } from "@/app/lib/stripe";
import { SITE_NAME } from "@/app/lib/legal";
import { classifyReturn } from "./classifyReturn";

// Landing page for redirect-based payment methods (Cash App Pay, Amazon Pay, …).
// Card payments never come here — they complete inside the embedded modal — but
// redirect methods leave the site and Stripe needs somewhere to send the
// customer back to. DISPLAY-ONLY: the billing webhook is the sole writer of
// subscription/donation/gift state; this page just reads the session status.

export const metadata: Metadata = {
  title: `Payment — ${SITE_NAME}`,
};

export const dynamic = "force-dynamic";

async function sessionStatus(
  sessionId: string
): Promise<{ status: "complete" | "open" | "expired" | "unknown"; paymentStatus: string | null }> {
  if (!stripeConfigured() || !/^cs_[a-zA-Z0-9_]+$/.test(sessionId)) return { status: "unknown", paymentStatus: null };
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.status === "complete") return { status: "complete", paymentStatus: session.payment_status };
    if (session.status === "open") return { status: "open", paymentStatus: null };
    if (session.status === "expired") return { status: "expired", paymentStatus: null };
    return { status: "unknown", paymentStatus: null };
  } catch {
    return { status: "unknown", paymentStatus: null };
  }
}

export default async function BillingReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id } = await searchParams;
  const { status, paymentStatus } = session_id
    ? await sessionStatus(session_id)
    : { status: "unknown" as const, paymentStatus: null };
  const { heading, body } = classifyReturn(status, paymentStatus);

  return (
    <div className="h-dvh overflow-y-auto bg-canvas text-strong">
      <div className="mx-auto w-full max-w-md px-5 py-24 text-center">
        <h1 className="text-2xl font-bold text-strong">{heading}</h1>
        <p className="mt-3 text-base leading-relaxed text-secondary">{body}</p>
        <Link
          href="/"
          className="mt-8 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-on-accent hover:brightness-110 transition-all"
          style={{ backgroundColor: "var(--accent)" }}
        >
          Back to {SITE_NAME}
        </Link>
      </div>
    </div>
  );
}
