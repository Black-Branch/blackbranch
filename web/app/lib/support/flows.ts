// The support panel's prefigured structure — a web customer-service
// assistant. Deterministic by design: every button below resolves without a
// model call; only the free-text leaf hands off to the LLM. Copy is in the
// bot's voice but front-desk register — dry, warm, no bits.

export type SupportAction =
  | { kind: "answer"; text: string }
  | { kind: "report-user" }
  | { kind: "report-bug" }
  | { kind: "free-text" };

export type FlowNode = {
  key: string;
  label: string;
  children?: FlowNode[];
  action?: SupportAction;
  /** The module (config/modules.mjs) this answer is about: offered only while it is shown. */
  module?: string;
};

import { currencyName, currencyTitle, currencyIsMass, scoreName } from "../currency.ts";

// The currency's own word (currency.ts). A mass noun takes is / it; a counted plural ("points")
// takes are / them.
const MASS = currencyIsMass();
const IT = MASS ? "it" : "them";

// Fixed copy, verbatim — do not reword.
export const FIRST_VISIT = "If you need anything, I'm here to help!";
export const CLOSE_HINT = "If you need me again, use /support in chat!";

// Load-time link-account reminder. Delivered as the bot's opener; the chips
// below it are linkNudgeOptions().
export const LINK_NUDGE_LINE =
  "Quick one — link your Twitch/Kick/etc. account and your messages cross-post and your support gets credited. It's in your profile card under Linked accounts. Want the walkthrough?";

// One answer, two homes: the FAQ leaf and the reminder's walkthrough chip must
// never drift apart — same feature, same instructions.
const LINKING_ANSWER =
  "Open your profile card and hit Linked accounts. Linking does two things: your chat can cross-post to that platform, and anything you've supported over there gets credited to the same you over here.";

export const GREETINGS = [
  "What can I help you with today?",
  "How can I help?",
  "What seems to be the issue?",
  "Front desk's open. What do you need?",
];

/** What this install runs, as the help desk needs to know it. The server reads it
 *  (supportFactsServer.ts) and the page hands it over (SupportModulesOff.tsx). */
export type SupportFacts = {
  /** The modules this install does not show (config/modules.mjs "ONE RULE"). */
  off: readonly string[];
  /** Points can be bought here (`currency.purchasable` and a payment provider). */
  purchasable: boolean;
  /** The Supporter subscription is offered (a usable Supporter price at Stripe). */
  subscriptions: boolean;
  /** Paid messages and big cheers are read out on stream. */
  tts: boolean;
  /** A typed question gets an AI answer. Off = no "Something else" and no question box. */
  freeText: boolean;
};

/** Before the page says: nothing that depends on the install is offered or promised. */
const UNKNOWN: SupportFacts = { off: [], purchasable: false, subscriptions: false, tts: false, freeText: false };

// Every answer, worded for THIS install's facts. A leaf with `module` is offered only while that
// module is shown; one that needs a fact is left out without it. Front-desk register, no persona
// lines — the desk ships to every install.
function allNodes(f: SupportFacts): FlowNode[] {
  return keep(
    {
      key: "faq", label: "Quick answers",
      children: keep(
        {
          key: "faq-points", label: MASS ? `What's ${currencyName()}?` : `What are ${currencyName()}?`,
          action: { kind: "answer", text:
            `${currencyTitle()} ${MASS ? "is" : "are"} the site currency. You earn ${IT} by watching and chatting while the stream is live`
            + (f.purchasable ? `, or buy ${IT} in the Store (the coin button under the player)` : "")
            + `, and spend ${IT} in the Store and on cheers.` },
        },
        f.subscriptions && {
          key: "faq-supporter", label: "What does Supporter get me?",
          action: { kind: "answer", text:
            "Supporter is the monthly subscription: a Supporter badge in chat, a faster chat rate limit, and redacted messages (/r for a whole message, or ||hide part|| of one). Subscribe from the button under the player or from your profile card. A gifted month counts the same." },
        },
        {
          key: "faq-linking", label: "Linking my Twitch/Kick/etc.",
          action: { kind: "answer", text: LINKING_ANSWER },
        },
        {
          key: "faq-votes", label: "Voting on messages",
          action: { kind: "answer", text:
            `Hover over a message in chat (on a phone, tap it) and the ▲ ▼ buttons show at its top right. Votes add to the writer's ${scoreName()}; you can't vote on your own messages.` },
        },
        {
          key: "faq-radio", label: "The radio", module: "radio",
          action: { kind: "answer", text:
            "The Radio tab plays the station. The Library shows the whole catalogue by album: download songs or whole albums, and heart the ones you like so you can find them again (sign in to use hearts)." },
        },
        f.subscriptions && {
          key: "faq-encrypted", label: "Redacted messages",
          action: { kind: "answer", text:
            "Supporter-only. Wrap part of a message in two bars — like ||this|| — and that part shows as a blacked-out bar; only Supporters can tap it open. The platforms it is posted to see [REDACTED] there instead. To redact a whole message, type /r before it; to keep redacting, pick Redacted message in the + menu, which stays on until you turn it off. Whole redacted messages stay on the site." },
        },
      ),
    },
    { key: "report-user", label: "Report a user", action: { kind: "report-user" } },
    { key: "report-bug", label: "Report a bug", action: { kind: "report-bug" } },
    {
      key: "howto", label: "How do I…?",
      children: keep(
        {
          key: "howto-namestyle", label: "Change my name style",
          action: { kind: "answer", text:
            "Open your profile card → Appearance. Colours, fonts and effects live there"
            + (f.subscriptions ? "; some of them are Supporter perks" : "")
            + ". Changes show up in chat at once." },
        },
        {
          key: "howto-cheer", label: "Send a cheer",
          action: { kind: "answer", text:
            `Tap the coin chip above the composer, pick an amount, type your message, send. It posts highlighted and spends ${currencyName()}.`
            + (f.tts ? " Big cheers are read out on stream — there's a toggle on the chip if you'd rather yours weren't." : "") },
        },
        {
          key: "howto-music", label: "Download the music", module: "radio",
          action: { kind: "answer", text:
            "Radio tab → Library. Every song has a download button, and each album has one that zips the whole thing." },
        },
        {
          key: "howto-popout", label: "Pop out the chat",
          action: { kind: "answer", text:
            "The popout button sits in the chat header — it opens chat in its own window, handy for a second monitor or OBS. The popout is plain chat: this help desk lives only on the main page." },
        },
      ),
    },
    f.freeText && { key: "other", label: "Something else", action: { kind: "free-text" } },
  );
}

/** The nodes a fact did not leave out (`fact && node` is false without it). */
function keep(...nodes: (FlowNode | false)[]): FlowNode[] {
  return nodes.filter((n): n is FlowNode => n !== false);
}

function without(nodes: FlowNode[], off: (m: string) => boolean): FlowNode[] {
  return nodes
    .filter((n) => !n.module || !off(n.module))
    .map((n) => (n.children ? { ...n, children: without(n.children, off) } : n));
}

/** The answers offered for these facts. Pure. */
function supportRootFor(f: SupportFacts): FlowNode[] {
  return without(allNodes(f), (m) => f.off.includes(m));
}

/**
 * What the support panel offers. Until the page says what this install runs (setSupportFacts,
 * from the stream page's server render), an answer about a module or a paid part is NOT offered
 * and there is no free-text question: the desk must never describe a part this install does not
 * run. A live binding — readers see the current value.
 */
export let SUPPORT_ROOT: FlowNode[] = without(allNodes(UNKNOWN), () => true);
let FREE_TEXT = false;

/** Set what this install runs. */
export function setSupportFacts(f: SupportFacts): void {
  SUPPORT_ROOT = supportRootFor(f);
  FREE_TEXT = f.freeText;
}

/** Whether a typed question goes to the AI. Off = the desk answers with NO_FREE_TEXT instead. */
export function supportFreeText(): boolean {
  return FREE_TEXT;
}

/** The desk's line for a typed question while nothing can answer one — instead of holding
 *  it 30 s and then saying it can't reach its brain. */
export const NO_FREE_TEXT =
  "I can only help with the topics in the menu here. For anything else, use Report a bug and a person will follow up.";

/**
 * Synthetic quick-reply offered under every free-text answer: files the
 * user's LAST typed message as the bug body, no retyping ("do you want me to
 * send this as a report?"). NOT part of SUPPORT_ROOT — the hook special-cases
 * the key before the reducer sees it.
 */
export const FILE_LAST_BUG: FlowNode = {
  key: "file-last-bug",
  label: "File that as a bug report",
};

/**
 * The reminder's quick-replies. "Walk me through it" is a normal answer leaf
 * the reducer resolves from the OFFERED options; the dismissal chips carry no
 * action on purpose — ChatSidebar intercepts their keys before the reducer
 * (same pattern as FILE_LAST_BUG) because dismissing is a panel-level act:
 * close + POST /api/nudges, which the conversation knows nothing about.
 */
export const NUDGE_LATER_KEY = "nudge-later";
export const NUDGE_NEVER_KEY = "nudge-never";

export function linkNudgeOptions(offerNever: boolean): FlowNode[] {
  const opts: FlowNode[] = [
    { key: "nudge-walkthrough", label: "Walk me through it", action: { kind: "answer", text: LINKING_ANSWER } },
    { key: NUDGE_LATER_KEY, label: "Not now" },
  ];
  if (offerNever) opts.push({ key: NUDGE_NEVER_KEY, label: "Never ask again" });
  return opts;
}

export function findNode(key: string, nodes: FlowNode[] = SUPPORT_ROOT): FlowNode | null {
  for (const n of nodes) {
    if (n.key === key) return n;
    const hit = n.children ? findNode(key, n.children) : null;
    if (hit) return hit;
  }
  return null;
}
