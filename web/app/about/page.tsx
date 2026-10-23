import type { Metadata } from "next";
import Link from "next/link";
import { SITE_NAME, OPERATOR, CONTACT_EMAIL, CONTACT_UNSET } from "@/app/lib/legal";
import { installValue } from "@/app/lib/installValues";
import { modulesShown } from "@/app/lib/moduleRunningServer";
import { stripeConfigured } from "@/app/lib/stripe";
import { paypalConfigured } from "@/app/lib/paypalClient";
import { subscriptionsSetUp } from "@/app/lib/supporterPrice";
import { chatPlatformsSetUp } from "@/app/lib/streamPlatformsServer";
import { youtubeUse } from "@/app/legal/legalFactsServer";
import { AboutFeatures, YoutubeUses } from "./AboutFeatures";

// Public "what is this" page — accessible without sign-in, hosted on our own
// domain, and it names the app, describes what it does, and explains why it
// connects to Google/YouTube with a visible privacy-policy link. This is the
// page configured as the Application home page on the Google OAuth consent
// screen (verification requires all of the above on that URL); it doubles as
// a human-friendly About for anyone curious. Styled after /legal.
// It names only what this install runs: the feature list by the module rule, the platforms set up
// and the payments configured (AboutFeatures.tsx), the Google section only where viewers can link
// YouTube, and its public-data use only with an API key. Rendered per request, like /legal.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `About — ${SITE_NAME}`,
  description: `What ${SITE_NAME} is, how it works, and how it uses connected platform accounts.`,
};

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-12 mb-4 text-2xl font-bold text-heading first:mt-0">{children}</h2>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="my-3 text-base leading-relaxed text-secondary">{children}</p>;
}

function UL({ children }: { children: React.ReactNode }) {
  return (
    <ul className="my-3 ml-5 list-disc space-y-1.5 text-base leading-relaxed text-secondary marker:text-muted">
      {children}
    </ul>
  );
}

export default async function AboutPage() {
  const [shown, youtube] = await Promise.all([modulesShown(), youtubeUse()]);
  return (
    <div className="h-dvh overflow-y-auto bg-canvas text-strong">
      <div className="mx-auto w-full max-w-3xl px-5 py-12 sm:px-8">
        <Link href="/" className="text-sm text-muted transition-colors hover:text-body-dim">
          ← Back to {SITE_NAME}
        </Link>
        <h1 className="mt-5 text-3xl font-bold tracking-tight text-strong">About {SITE_NAME}</h1>
        <p className="mt-2 text-sm text-muted">
          {installValue("site.description") || `The home of ${SITE_NAME}'s live stream and its community.`}
        </p>

        <div className="mt-10 border-t border-raised pt-2" />

        <H2>What {SITE_NAME} is</H2>
        <P>
          {SITE_NAME} is an independent streaming-community platform built and operated by{" "}
          {OPERATOR}. It is the single place to watch the live stream and take part in the
          community around it:
        </P>
        <AboutFeatures
          siteName={SITE_NAME}
          facts={{
            shown,
            stripe: stripeConfigured(),
            subscriptions: subscriptionsSetUp(),
            paypal: paypalConfigured(),
            platforms: chatPlatformsSetUp(),
          }}
        />

        {/* Only where viewers can link YouTube: this is the Google sign-in's home page. */}
        {youtube.linking && (<>
        <H2>Why {SITE_NAME} connects to Google / YouTube</H2>
        <YoutubeUses siteName={SITE_NAME} publicData={youtube.publicData} linking={
          <li>
            <strong className="text-body-dim">Optional account linking</strong> — if you
            choose to link your own YouTube account, {SITE_NAME} uses that connection to
            connect it to your account here (your own stats and badges follow you; moderators
            can see the link) and to <em className="not-italic text-body-dim">send your chat
            messages to the YouTube live chat on your behalf</em>. Linking an account is
            private: the link itself is shown only where you choose to show it. Posting is
            separate: while an account is linked, your messages here are also posted to that
            platform unless you pick a different destination in the chat box, and a message
            posted there carries your name there. The destination is the Send-to button in the
            chat box. We request only the YouTube scopes account linking needs.
          </li>
        } />
        <P>
          Linking is never required to use the site. The OAuth tokens for linked accounts are
          stored encrypted, and we never see or store your Google password. You can disconnect
          at any time from <span className="text-body-dim">Settings → Linked accounts</span>{" "}
          on {SITE_NAME}, or revoke the app&apos;s access from your{" "}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-400 hover:text-sky-300"
          >
            Google account security settings
          </a>
          . Details of what we store and for how long are in our{" "}
          <Link href="/legal#privacy" className="text-sky-400 hover:text-sky-300">
            Privacy Policy
          </Link>
          .
        </P>
        </>)}

        <H2>Policies &amp; contact</H2>
        <UL>
          <li>
            <Link href="/legal#terms" className="text-sky-400 hover:text-sky-300">Terms of Service</Link>
          </li>
          <li>
            <Link href="/legal#privacy" className="text-sky-400 hover:text-sky-300">Privacy Policy</Link>
          </li>
          <li>
            <Link href="/legal#refunds" className="text-sky-400 hover:text-sky-300">Refund Policy</Link>
          </li>
          <li>
            {"Questions: "}
            {CONTACT_EMAIL
              ? <a href={`mailto:${CONTACT_EMAIL}`} className="text-sky-400 hover:text-sky-300">{CONTACT_EMAIL}</a>
              : CONTACT_UNSET}
          </li>
        </UL>
      </div>
    </div>
  );
}
