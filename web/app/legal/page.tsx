import type { Metadata } from "next";
import { SITE_NAME } from "@/app/lib/legal";
import { LegalDocument } from "./LegalDocument";
import { legalFacts } from "./legalFactsServer";

// Public legal page — Terms of Service, Privacy Policy, and Refund Policy (LegalDocument.tsx).
// Lives OUTSIDE the (main) app chrome so it renders as a clean standalone page; the root <body>
// is overflow-hidden, so the document owns its own scroll container.
//
// Rendered per request: what the page says depends on what this install runs right now (the AI
// features, the payment providers, YouTube, the front door — legalFactsServer.ts), all of which
// can change without a rebuild. The operator values are install values.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Terms & Privacy — ${SITE_NAME}`,
  description: `Terms of Service, Privacy Policy and Refund Policy for ${SITE_NAME}.`,
};

export default async function LegalPage() {
  return <LegalDocument facts={await legalFacts()} />;
}
