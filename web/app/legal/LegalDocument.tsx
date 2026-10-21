import Link from "next/link";
import {
  OPERATOR,
  SITE_NAME,
  CONTACT_EMAIL,
  CONTACT_UNSET,
  GOVERNING_LAW,
  EFFECTIVE_DATE,
  MIN_AGE,
  MIN_PAYMENT_AGE,
} from "@/app/lib/legal";
import { anyAi, type LegalFacts } from "./legalFacts";
import { AUTOMOD_HELD_RETENTION_DAYS } from "./automodRetention";

// Terms of Service, Privacy Policy and Refund Policy in one scrollable document with anchor
// navigation (#terms / #privacy / #refunds). Operator/contact/date strings come from
// app/lib/legal.ts; everything that depends on what this install runs comes from `facts`
// (legalFacts.ts), so the page never describes a feature, a provider or a number the install does
// not have. A plugin's own data practices are its own sentences (PluginPrivacy), shown only with it.

/** The contact address as a mail link, or the "not set" marker when the install has none. */
function Contact({ className = "text-sky-400 hover:text-sky-300" }: { className?: string }) {
  return CONTACT_EMAIL ? <a href={`mailto:${CONTACT_EMAIL}`} className={className}>{CONTACT_EMAIL}</a> : <>{CONTACT_UNSET}</>;
}

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="scroll-mt-20 mt-12 mb-4 text-2xl font-bold text-heading first:mt-0"
    >
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-6 mb-2 text-base font-semibold text-body">{children}</h3>;
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

function B({ children }: { children: React.ReactNode }) {
  return <strong className="text-body-dim">{children}</strong>;
}

const and = (items: readonly string[]) => new Intl.ListFormat("en", { type: "conjunction" }).format(items);
const or = (items: readonly string[]) => new Intl.ListFormat("en", { type: "disjunction" }).format(items);

/** The payment processors this install takes money through (card and PayPal checkout). */
function processors(p: LegalFacts["payments"]): string[] {
  return [...(p.stripe ? ["Stripe"] : []), ...(p.paypal ? ["PayPal"] : [])];
}

/** The outside services supporters may pay through, which then tell this site about it. */
function supportServices(p: LegalFacts["payments"]): string[] {
  return [...(p.kofi ? ["Ko-fi"] : []), ...(p.patreon ? ["Patreon"] : []), ...(p.streamlabs ? ["Streamlabs"] : [])];
}

/** The AI features this install runs, as one phrase each. */
function aiFeatureList(ai: LegalFacts["ai"], botName: string | null): string[] {
  return [
    ...(ai.bot ? [botName ? `a chat participant (“${botName}”) that answers in chat` : "a chat participant that answers in chat"] : []),
    ...(ai.helpdesk ? ["answers to questions asked in the help pop-up"] : []),
    ...(ai.automod ? ["automod, which checks chat messages and holds or flags risky ones for a moderator — it never removes anything by itself"] : []),
    ...(ai.memory ? ["memory, so the AI can recall earlier chat"] : []),
    ...(ai.plugin && !ai.bot ? ["further AI features of this install's own"] : []),
  ];
}

/** What automod keeps (stream-api/automod.js): the held row in site.automod_held carries the text
 *  and the verdict and is deleted AUTOMOD_HELD_RETENTION_DAYS after it was held, whatever its
 *  status; markIfDue's site.user_marks row holds no text, and while it is open the same daily job
 *  deletes it once none of its evidence rows is left. A cleared mark is the
 *  moderator's record: nothing deletes it, and an account deletion keeps it (accountDeletion.ts
 *  `kept`). The render test holds every part to the code. */
const AUTOMOD_KEEPS =
  `keeps a record of each chat message it judges risky: the message’s text, who sent it, the kind of risk it saw, how sure it was and the reason it gave, for moderators to review. That record, the message’s text with it, is deleted ${AUTOMOD_HELD_RETENTION_DAYS} days after the message was held, whatever a moderator decided. Someone with several such messages in a short time gets a “suspicious” mark that moderators see; the mark holds no message text. Automatic marks are removed when their last supporting evidence is deleted (at the next daily run); a mark a moderator has cleared is kept as a moderation record with no time limit, also after an account is deleted.`;

/** The legal document for this install. */
export function LegalDocument({ facts }: { facts: LegalFacts }) {
  const { ai, payments, youtube } = facts;
  const hasAi = anyAi(ai);
  const pay = processors(payments);
  const support = supportServices(payments);
  const takesMoney = pay.length > 0 || support.length > 0;
  const providerNames = ai.providers.length ? and(ai.providers) : null;
  // Something AI-derived is kept: memory's embeddings, automod's records, or a plugin's own notes.
  const aiKeeps = ai.memory || ai.automod || !!facts.plugin?.derived;
  const cur = facts.currencyName;
  const linkPlatforms = youtube.linking ? "a Twitch, YouTube, Kick, or other account" : "a Twitch, Kick, or other account";
  const pictures = [
    facts.thirdPartyImages.vods && "thumbnails of past broadcasts from YouTube",
    facts.thirdPartyImages.news && "news-feed pictures from the site that published the item",
  ].filter((x): x is string => !!x);

  return (
    <div className="h-dvh overflow-y-auto bg-canvas text-strong">
      <div className="mx-auto w-full max-w-3xl px-5 py-12 sm:px-8">
        {/* Header */}
        <Link
          href="/"
          className="text-sm text-muted transition-colors hover:text-body-dim"
        >
          ← Back to {SITE_NAME}
        </Link>
        <h1 className="mt-5 text-3xl font-bold tracking-tight text-strong">
          Terms &amp; Privacy
        </h1>
        <p className="mt-2 text-sm text-muted">
          The rules for using {SITE_NAME}, how we handle your data, and our policy on
          payments. Last updated {EFFECTIVE_DATE}.
        </p>

        {/* Anchor nav */}
        <nav className="mt-6 flex flex-wrap gap-2">
          {[
            ["#terms", "Terms of Service"],
            ["#privacy", "Privacy Policy"],
            ["#refunds", "Refund Policy"],
          ].map(([href, label]) => (
            <a
              key={href}
              href={href}
              className="rounded-full border border-raised bg-panel px-3.5 py-1.5 text-xs font-medium text-body-dim transition-colors hover:border-control hover:text-heading"
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="mt-10 border-t border-raised pt-2" />

        {/* ─────────────────────────────── TERMS ─────────────────────────────── */}
        <H2 id="terms">Terms of Service</H2>
        <P>
          These Terms of Service (“Terms”) govern your access to and use of {SITE_NAME}{" "}
          (the “Service”), operated by {OPERATOR} (“we”, “us”, “our”). By creating an
          account, signing in, chatting, or making a payment, you agree to these Terms.
          If you do not agree, do not use the Service.
        </P>

        <H3>1. Eligibility</H3>
        <P>
          You must be at least {MIN_AGE} years old (or the minimum age of digital consent
          in your jurisdiction, if higher) to use the Service, and at least{" "}
          {MIN_PAYMENT_AGE} years old to make any payment. By using the Service you
          represent that you meet these requirements and that the information you provide
          is accurate.
        </P>

        <H3>2. Your account</H3>
        <P>
          Accounts are backed by Matrix. You are responsible for activity under your
          account and for keeping your sign-in and any recovery keys secure. We may
          suspend or terminate accounts that violate these Terms or that we reasonably
          believe are being used to harm others or the Service.
        </P>

        <H3>3. Community conduct</H3>
        <P>You agree not to use the Service to:</P>
        <UL>
          <li>harass, threaten, dox, or incite violence against any person;</li>
          <li>post unlawful content, or content that infringes someone else’s rights;</li>
          <li>spam, scam, or distribute malware;</li>
          <li>evade a ban, impersonate others, or disrupt the Service or its moderation;</li>
          <li>break the rules of any connected third-party platform (e.g. Twitch, YouTube, Kick).</li>
        </UL>
        <P>
          Moderators may remove content, time out, or ban accounts at their discretion to
          keep the community healthy. Direct messages started on {SITE_NAME} are end-to-end
          encrypted; moderation of encrypted messages relies on reports.
        </P>

        <H3>4. Your content</H3>
        <P>
          You keep ownership of what you post. By posting, you grant {OPERATOR} a
          non-exclusive, worldwide, royalty-free license to host, display, and distribute
          your content as needed to operate the Service — including relaying chat to and
          from connected streaming platforms and showing it on the stream. You are
          responsible for the content you post and represent that you have the right to
          post it.
        </P>

        <H3>{ai.bot && facts.botName ? `5. AI features (${facts.botName})` : "5. AI features"}</H3>
        {hasAi ? (
          <P>
            {`The Service uses AI: ${and(aiFeatureList(ai, facts.botName))}. `}
            AI output is generated automatically and may be inaccurate, incomplete, or
            unexpected. It does not represent the views of {OPERATOR} and should not be relied
            upon as factual, professional, or political advice. To run these features, chat
            messages are processed as described in the Privacy Policy below.
          </P>
        ) : (
          <P>{SITE_NAME} does not use AI features.</P>
        )}

        <H3>6. Paid features</H3>
        {takesMoney ? (
          <>
            <UL>
              {payments.subscriptions && (
                <li>
                  <B>Subscriptions</B> renew automatically each billing period until cancelled.
                  You can cancel at any time; access continues until the end of the paid period.
                </li>
              )}
              <li>
                <B>Donations and tips</B> are voluntary one-time payments in support of the
                stream and grant no goods, services, or entitlements.
              </li>
              {payments.stripe && (
                <li>
                  <B>Gift subscriptions</B> are paid by you and applied to the recipient’s account.
                </li>
              )}
            </UL>
            <P>
              {pay.length > 0 && <>Payments on {SITE_NAME} are processed by {and(pay)}; we do not receive or store your full card details. </>}
              {support.length > 0 && <>Support given through {or(support)} is taken by that service under its own terms, and it tells us about it so we can credit and show it. </>}
              Prices may change with notice for future billing periods. Taxes may apply depending
              on your location. See the{" "}
              <a href="#refunds" className="text-sky-400 hover:text-sky-300">
                Refund Policy
              </a>{" "}
              for details on cancellations and refunds.
            </P>
          </>
        ) : (
          <P>{SITE_NAME} does not take payments.</P>
        )}

        <H3>7. Disclaimers</H3>
        <P>
          The Service is provided “as is” and “as available,” without warranties of any
          kind, whether express or implied, including merchantability, fitness for a
          particular purpose, and non-infringement. We do not warrant that the Service
          will be uninterrupted, secure, or error-free.
        </P>

        <H3>8. Limitation of liability</H3>
        <P>
          To the maximum extent permitted by law, {OPERATOR} will not be liable for any
          indirect, incidental, special, consequential, or punitive damages, or for any
          loss of data, profits, or goodwill, arising from your use of the Service. Our
          total liability for any claim relating to the Service will not exceed the
          greater of the amount you paid us in the twelve months before the claim or
          USD ${facts.liabilityCapUsd}.
        </P>

        <H3>9. Termination</H3>
        <P>
          You may stop using the Service at any time. We may suspend or terminate your
          access if you violate these Terms or to protect the Service or its users.
          Provisions that by their nature should survive termination (e.g. content
          license, disclaimers, limitation of liability) will survive.
        </P>

        <H3>10. Changes to these Terms</H3>
        <P>
          We may update these Terms from time to time. Material changes will be reflected
          by the “last updated” date above. Continued use of the Service after changes
          take effect constitutes acceptance.
        </P>

        <H3>11. Governing law</H3>
        <P>
          These Terms are governed by the laws of {GOVERNING_LAW}, without regard to its
          conflict-of-laws rules.
        </P>

        <H3>12. Contact</H3>
        <P>
          Questions about these Terms? Email{" "}
          <Contact />
          .
        </P>

        {/* ────────────────────────────── PRIVACY ────────────────────────────── */}
        <H2 id="privacy">Privacy Policy</H2>
        <P>
          This Privacy Policy explains what {SITE_NAME} collects, how we use it, and the
          choices you have. We don’t sell your personal data. Last updated {EFFECTIVE_DATE}.
        </P>

        <H3>Information we collect</H3>
        <UL>
          <li>
            <B>Account &amp; profile:</B> your Matrix
            ID, display name, avatar, banner, pronouns, bio, status line, username color, and time zone.
          </li>
          <li>
            <B>Linked platforms:</B> when you connect
            {` ${linkPlatforms}`}, we store the platform identifier and display name to link
            your identities, and the sign-in tokens that platform gives us, stored encrypted, so the
            site can act for you there (such as posting the messages you send) — never your
            password. Unlinking the account deletes its tokens. Linking an account is private: the link itself is shown only where you choose to show it. Posting is separate: while an account is linked, your messages here are also posted to that platform unless you pick a different destination in the chat box, and a message posted there carries your name there.
            The link is private by default: other people see each of your accounts under its own name and
            are not told they belong to the same person, and public chat and profiles carry a
            separate id for each platform. A message you send from {SITE_NAME} to a platform
            is posted from your own account there, and your profile lists your linked platforms
            if you turn that on under Linked accounts. Moderators can see which accounts are
            linked, to moderate the chat. Unlinking an account, or turning the profile switch
            off, hides it again.
          </li>
          <li>
            <B>Chat &amp; activity:</B> messages you
            send in {SITE_NAME} chat, messages aggregated from connected public platform
            chats, reactions, votes, and moderation events.
          </li>
          {hasAi && (
            <li>
              <B>AI-derived data:</B>
              {ai.memory && " embeddings (numerical representations) of chat messages, so the AI can recall earlier chat."}
              {ai.automod && `${ai.memory ? " Also, automod" : " automod"} ${AUTOMOD_KEEPS}`}
              {facts.plugin?.derived ? ` ${facts.plugin.derived}` : ""}
              {!aiKeeps && " none is kept: the AI works on chat as it happens."}
            </li>
          )}
          {takesMoney && (
            <li>
              <B>Payment data:</B>
              {pay.length > 0
                ? ` handled by ${and(pay)}. We store only what we need to grant entitlements — e.g. a customer or payment identifier${payments.subscriptions ? " and your subscription status" : ""} — not your full card number.`
                : ""}
              {payments.points &&
                ` When you buy ${cur}: the amount, the date, the payment processor’s reference and the ${cur} added to your balance. Your balance and its history (${cur} earned, bought and spent) are kept with your account.`}
              {support.length > 0
                ? ` For support given through ${or(support)}: the name, amount and message that service sends us.`
                : ""}
            </li>
          )}
          <li>
            <B>Error reports:</B> when something breaks
            in your browser, the site records the error, the page address, your browser&apos;s
            description (user agent) and, if you are signed in, your account. Error reports are
            deleted once they are {facts.errorLogDays} days old.
          </li>
          <li>
            <B>Device &amp; technical:</B> Matrix
            device identifiers, and settings stored locally in your browser. Encryption
            keys for end-to-end encrypted messages are generated and held on your device.
          </li>
        </UL>

        <H3>How we use it</H3>
        <UL>
          <li>to operate chat, accounts, and the community;</li>
          <li>to moderate and keep the community safe;</li>
          {hasAi && <li>{ai.bot && facts.botName ? `to run the AI features (${facts.botName});` : "to run the AI features;"}</li>}
          {takesMoney && <li>to process payments and grant supporter entitlements;</li>}
          <li>to diagnose problems and improve the Service.</li>
        </UL>

        {hasAi && (
          <>
            <H3>AI data collection &amp; your choice</H3>
            <P>
              {providerNames
                ? `The AI features run on ${providerNames}: the chat messages they work on are sent there to be processed. `
                : "The AI features run on an outside AI service: the chat messages they work on are sent there to be processed. "}
              The AI sees recent chat while it is happening, the same way everyone in chat can.
              {ai.bot && !facts.plugin && " Its replies are chat messages like anyone else’s; it keeps no other log of them."}
            </P>
            {ai.memory ? (
              <>
                <P>
                  To recall earlier chat, the AI turns chat messages into embeddings associated with
                  the person who wrote them.{" "}
                  {ai.memoryRetentionDays !== null
                    ? `Each one is deleted automatically after ${ai.memoryRetentionDays} days.`
                    : "They are kept until the person switches memory off or asks us to delete them."}
                </P>
                <P>
                  You can switch AI memory off. With a {SITE_NAME} account: open your profile card,
                  choose <B>Privacy</B>, and turn off{" "}
                  <B>Let the bot remember my messages</B>. It is
                  stored with your account, so it applies on every device. While it is off:
                </P>
                <UL>
                  <li>
                    your new messages — here and from any platform account you have linked — are not
                    turned into AI memory;
                  </li>
                  <li>
                    what the AI already remembered about you — the embeddings of your messages — is
                    deleted straight away;
                  </li>
                  {(facts.plugin?.memoryOff ?? []).map((t) => <li key={t}>{t}</li>)}
                  {ai.automod && <li>automod’s records of your messages it judged risky stay until they are deleted {AUTOMOD_HELD_RETENTION_DAYS} days after the message was held, and an open “suspicious” mark automod placed stays until the last of those records is deleted: they are moderation records;</li>}
                  <li>
                    the AI can still see recent chat while it is happening, the same way everyone in
                    chat can. That is not memory and is not kept;
                  </li>
                  <li>your chat messages themselves are not deleted.</li>
                </UL>
                <P>
                  If you only chat on a connected platform (Twitch, YouTube, Kick and others) and have
                  no {SITE_NAME} account, email{" "}
                  <Contact />{" "}
                  and we will delete what the AI remembers about you. To stop it remembering new
                  messages too, link that platform account to a {SITE_NAME} account and turn the
                  setting off.
                </P>
              </>
            ) : (
              <P>
                {aiKeeps
                  ? "The AI does not turn chat into memory for later recall; what it does keep is listed under AI-derived data above."
                  : "The AI does not remember chat: nothing it sees is kept for later recall."}
              </P>
            )}
            {(facts.plugin?.more ?? []).map((t) => <P key={t}>{t}</P>)}
          </>
        )}

        <H3>Encryption</H3>
        <P>
          Direct messages started on {SITE_NAME} are end-to-end encrypted. The keys live on
          your devices, which means we cannot read those messages. Other rooms are encrypted
          only if encryption was switched on for them. Keep your recovery key safe — if you
          lose it, encrypted history may not be recoverable.
        </P>

        <H3>Who we share with</H3>
        <P>We share data only with service providers that help us run {SITE_NAME}:</P>
        <UL>
          {pay.map((name) => (
            <li key={name}>
              <B>{name}</B> — payment processing, under {name}’s own privacy policy;
            </li>
          ))}
          {support.length > 0 && (
            <li>
              <B>{and(support)}</B> — when you support the stream through {support.length > 1 ? "one of them" : "it"},
              under {support.length > 1 ? "its" : `${support[0]}’s`} own privacy policy;
            </li>
          )}
          {hasAi && (
            <li>
              <B>{providerNames ?? "The AI service"}</B> — the chat messages the AI features work
              on are sent there to be processed;
            </li>
          )}
          {facts.cloudflare && (
            <li>
              <B>Cloudflare</B> — every request to {SITE_NAME} passes through Cloudflare’s
              network on its way to us, so Cloudflare sees your IP address and the pages you open;
            </li>
          )}
          <li>
            <B>Connected platforms</B> — when you send
            chat that is relayed out, or when we aggregate public chat from platforms you
            or the stream connect;
          </li>
          {facts.twitch && (
            <li>
              <B>alejo.io</B> — when you chat on Twitch and
              have not set pronouns here, we look up the pronouns you chose on alejo.io’s public
              pronoun service using your Twitch username;
            </li>
          )}
          <li>
            when required by law, or to protect the rights and safety of users and the
            Service.
          </li>
        </UL>
        <P>We do not sell your personal data.</P>
        {pictures.length > 0 && (
          <P>
            Some pictures load straight from the service that hosts them: {and(pictures)}. That service sees
            your IP address when your browser fetches the picture.
          </P>
        )}

        {(youtube.publicData || youtube.linking) && (
          <>
            <H3>Google / YouTube API Services</H3>
            <P>
              {SITE_NAME} uses YouTube API Services. By using the YouTube-connected features you
              also agree to the{" "}
              <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:text-sky-300">
                YouTube Terms of Service
              </a>
              ; Google&apos;s handling of your data is described in the{" "}
              <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:text-sky-300">
                Google Privacy Policy
              </a>
              .
              {youtube.publicData && " We use the YouTube Data API to read public information about the stream's own channel (live status, subscriber count, avatar)."}
            </P>
            {youtube.linking && (
              <P>
                If you choose to link your YouTube account, we store your YouTube channel identifier
                and display name (to link your identities) and OAuth tokens — encrypted at rest — used
                only to recognise you and to post chat messages to the live chat when you send them.
                Google labels this permission &ldquo;Manage your YouTube account&rdquo;; we never
                create, edit, or delete your videos, playlists, comments, or anything else on your
                channel — posting the live-chat messages you send from {SITE_NAME} is the only write
                action we perform. We do not access your subscriptions, watch history, or private
                data. You can revoke this access at any time by unlinking the account in Settings →
                Linked accounts, or via your{" "}
                <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:text-sky-300">
                  Google security settings
                </a>
                ; revoked tokens are deleted. To request deletion of stored Google user data, email{" "}
                <Contact />.
              </P>
            )}
          </>
        )}

        <H3>Retention</H3>
        <P>
          We keep data for as long as your account is active or as needed to provide the
          Service, meet legal obligations, resolve disputes, and enforce our agreements.
          Public chat history may persist as part of the community record.
          {facts.homeserverRetention &&
            ` On our Matrix server, messages in a room without its own setting — every direct message among them — are deleted after ${facts.homeserverRetention.dms} days, and messages in #general after ${facts.homeserverRetention.general} days.`}
        </P>

        <H3>Your rights</H3>
        <P>
          {ai.memory && (
            <>
              You can switch off AI memory yourself at any time (see{" "}
              <a href="#privacy" className="text-sky-400 hover:text-sky-300">AI data collection</a>{" "}
              above); doing so deletes what the AI remembered about you at once.{" "}
            </>
          )}
          You can delete your account yourself, in your account settings under Privacy: it removes your
          profile, settings, linked platform accounts and their tokens, your messages (they stay
          in the conversation as “deleted”),{hasAi ? " what the AI remembers about you," : ""} your votes and your
          points, and deactivates your Matrix account. We keep payment records the law requires
          (amount, date and the payment processor&apos;s reference, without your name or message)
          and moderation records — deleting an account does not lift a ban, and while moderators
          have an open case about you (a report, a held message, a mark or a ban) the words of your
          messages stay, visible to moderators only and without your profile. A message held for review
          keeps its words with that moderation record until {AUTOMOD_HELD_RETENTION_DAYS} days after it was
          held, whether or not the case is still open; then the record is deleted. If you keep chatting
          in a platform&apos;s public chat after deleting your account, those messages are processed
          like anyone else&apos;s platform chat{ai.memory ? " (an AI-memory opt-out you had stays in force)" : ""}, and
          moderation records about you are kept. People who chat only
          from another platform, and anyone with another request (access, correction, or deletion
          of anything else), can email{" "}
          <Contact />
          . We will respond within a reasonable time. Some data may be retained where we
          have a legal basis or obligation to keep it.
        </P>

        <H3>Children</H3>
        <P>
          The Service is not directed to children under {MIN_AGE}. If you believe a child
          under {MIN_AGE} has provided us personal data, contact us and we will delete it.
        </P>

        <H3>Changes</H3>
        <P>
          We may update this Privacy Policy; the “last updated” date above reflects the
          latest version.
        </P>

        {/* ────────────────────────────── REFUNDS ────────────────────────────── */}
        <H2 id="refunds">Refund Policy</H2>
        <P>Last updated {EFFECTIVE_DATE}.</P>
        {takesMoney ? (
          <>
            <P>
              Payments on {SITE_NAME} support an independent creator and the community.
              Because of this, <B>all sales are final</B>{" "}
              and payments are generally non-refundable, except where required by law.
            </P>
            <UL>
              {payments.subscriptions && (
                <li>
                  <B>Subscriptions:</B> you can cancel at any
                  time and will keep access until the end of the current billing period. We do
                  not provide partial or pro-rated refunds for the remainder of a period.
                </li>
              )}
              <li>
                <B>Donations and tips:</B> one-time donations are
                voluntary and non-refundable.
              </li>
              {payments.stripe && (
                <li>
                  <B>Gift subscriptions:</B> are
                  non-refundable once redeemed by the recipient.
                </li>
              )}
            </UL>
            <P>
              We may, at our sole discretion, issue a refund in exceptional cases — for
              example a duplicate charge or a clear billing error. To request one, email{" "}
              <Contact />{" "}
              with your account and the transaction details. Initiating a chargeback instead of
              contacting us may result in suspension of your account and access.
              {support.length > 0 && ` Support given through ${or(support)} is refunded, if at all, under that service's own policy.`}
            </P>
          </>
        ) : (
          <P>{SITE_NAME} does not take payments, so there is nothing to refund.</P>
        )}

        <div className="mt-14 border-t border-raised pt-6 text-xs text-muted">
          © {new Date().getFullYear()} {OPERATOR} · {SITE_NAME} ·{" "}
          <Contact className="hover:text-secondary" />
        </div>
      </div>
    </div>
  );
}
