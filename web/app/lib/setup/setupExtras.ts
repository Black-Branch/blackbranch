// What the setup pages add to the setup lists (config/modules.mjs `setup`, config/setup-core.mjs)
// before a person reads them. Pure. The lists themselves are generated into every package, so a
// page-only change — help that folds, a value's format, a step only the setup pages show — lives
// here, beside the pages that draw it:
//
//   STEP_HELP       per step: foldable explainers, a one-line note, paste lines that are shown for
//                   reference (nothing to paste, so no Copy button), and the scopes an app needs.
//   WIZARD_STEPS    steps only the setup pages show, appended to a list (the Stripe price, Kick's
//                   ids) — the Admin Panel draws its own cards for those keys.
//   WIZARD_LISTS    the "where you stream, and other services" choices: the product's lists, with
//                   Ko-fi, Patreon and Streamlabs as three separate choices, and the read-aloud voice.
//   FIELD_FORMATS   the shape of every value a page takes, checked before it is saved.
//
// Every key named here is a settings key (setupExtras.test.ts holds each to the schema).

export type RawStep = {
  id: string; title: string; need: "required" | "optional"; explain: string;
  links: { label: string; url: string }[]; paste: { label: string; value: string }[];
  fields: string[]; test: string | null;
  /** Shown only on an install with a site plugin (config/setup-core.mjs). */
  ownerOnly?: boolean;
};

export type StepHelp = {
  /** One plain line under the explanation. */
  note?: string;
  /** A line only the setup pages show (it points at the Admin Panel, where a guide would read it). */
  later?: string;
  /** Foldable explainers: closed until opened. */
  more?: { title: string; body: string[] }[];
  /** Paste lines that are for reference only — shown without a Copy button, under a new label. */
  info?: Record<string, string>;
  /** Lines shown like paste values (with Copy) after the step's own. */
  extraPaste?: { label: string; value: string }[];
};

const LATER = (where: string) => `Not ready yet? Skip it and add it later in Admin Panel → ${where} — saving it there is enough, no restart.`;
const EMOTES = (id: string) => `Your channel's 7TV emotes are looked up by the ${id}: once it is saved they reach chat within half an hour. Without it chat has the global emote sets only.`;

/** The scopes the site asks for when someone links an account (web/app/lib/platformOAuth.ts):
 *  everyone, and moderators on top.
 *  @test-only exported so setupPages.test.ts can hold both lists equal to platformOAuth.ts (the pages use them here). */
export const TWITCH_SCOPES = { everyone: ["user:read:email", "chat:read", "user:write:chat", "user:read:emotes"],
  moderators: ["moderator:manage:banned_users", "moderator:manage:chat_messages", "moderator:manage:chat_settings", "moderator:manage:automod"] } as const;
/** @test-only exported so setupPages.test.ts can hold it equal to platformOAuth.ts (the pages use it here). */
export const KICK_SCOPES ={ everyone: ["user:read", "chat:write"], moderators: ["moderation:ban", "moderation:chat_message:manage"] } as const;

/** Help per step, by `<list>/<step>` (list = `module:<id>` or `core:<id>`). */
export const STEP_HELP: Record<string, StepHelp> = {
  "module:youtube/channel": {
    later: LATER("Platforms → YouTube"),
    note: "Posting site chat into YouTube chat is not in this release, and your viewers are never asked to sign in with Google.",
  },
  "core:twitch/channel": { later: LATER("Platforms → Twitch") },
  "core:twitch/app": {
    note: EMOTES("broadcaster id"),
    extraPaste: [
      { label: "Scopes the site asks every viewer for (nothing to tick at Twitch)", value: TWITCH_SCOPES.everyone.join(" ") },
      { label: "…and moderators, on top", value: TWITCH_SCOPES.moderators.join(" ") },
    ],
    more: [{ title: "Which value goes where", body: [
      "Client ID (on the app's Manage page) → Twitch app client id.",
      "New Secret → Twitch app client secret. Twitch shows it once; a new one replaces the old.",
      "Client type: Confidential. Twitch asks for no scopes when you register: the site asks for them when someone links an account, and the person sees them on Twitch's consent screen.",
      "Press Check on the secret: it signs the app in and finds your channel, then shows its numeric id — paste that as the broadcaster id.",
    ] }],
  },
  "core:kick/channel": { later: LATER("Platforms → Kick") },
  "core:kick/app": {
    note: EMOTES("Kick user id"),
    extraPaste: [
      { label: "Scopes to tick on the Kick app — for everyone", value: KICK_SCOPES.everyone.join(" ") },
      { label: "…and for moderation from the site", value: KICK_SCOPES.moderators.join(" ") },
    ],
    more: [{ title: "Which value goes where", body: [
      "Client ID → Kick app client id. Client Secret → Kick app client secret.",
      "Kick asks which scopes the app may use when you create it: tick the ones above. A scope the app lacks is refused when someone links.",
      "Press Check on the secret: it signs the app in and finds your channel, then shows its numeric id — paste that as the Kick user id.",
    ] }],
  },
  "core:streamplace/account": {
    info: {
      "Client id (nothing to paste anywhere)": "This site's app description — Streamplace reads it itself",
      "Redirect URL": "Where Streamplace sends people back — nothing to paste",
    },
    more: [{ title: "What the two addresses are for", body: [
      "Streamplace has no developer console. When a viewer links their account, Streamplace opens the first address to learn which site is asking, then sends the viewer back to the second.",
      "They are shown so you can open them yourself if linking ever fails: the first must show a page of text starting with {\"client_id\".",
    ] }],
  },
  "module:stripe/keys": {
    more: [
      { title: "Which key goes where", body: [
        "Restricted key (rk_live_… or rk_test_…) → Stripe secret key. Make it under Developers → API keys → Create restricted key, with the permissions listed here.",
        "Publishable key (pk_live_… or pk_test_…) → Stripe publishable key. It is meant to be public: the card form in the viewer's browser uses it.",
        "The webhook signing secret (whsec_…) goes on the next step.",
        "Never paste the full secret key (sk_…) unless a restricted key cannot work for you: it can do anything on your account.",
      ] },
      { title: "Test keys or live keys?", body: [
        "Test keys take only Stripe's test cards and move no money: use them first. Every key on this page must be from the same mode.",
        "Switching to live later means a new restricted key, the live publishable key and a live webhook (it has its own signing secret).",
      ] },
    ],
  },
  "module:stripe/webhook": {
    more: [{ title: "Are the API version and the event list really needed?", body: [
      "Yes, both. Stripe writes every event in the shape of the destination's API version, and this release reads the version shown — another version sends fields where the site does not look.",
      "Stripe sends only the events you tick. The Check counts any that are missing. Ticking \"all events\" also works.",
    ] }],
  },
  "module:paypal/app": {
    more: [{ title: "Sandbox or live: two different sets of keys", body: [
      "PayPal gives every app two separate sets: Sandbox (pretend money, for trying it out) and Live. A sandbox client id never works live, and the other way round.",
      "Pick Sandbox or Live at the top of PayPal's Apps & Credentials page, copy that set's client id and secret, and choose the same one in PayPal environment here.",
      "Moving from sandbox to live later: paste the live client id and secret, and make the webhook again on the live app — its id is different too.",
    ] }],
  },
  "module:paypal/webhook": { note: "The webhook belongs to one app in one mode: a sandbox app's webhook id does not work with live keys." },
};

/** Modules whose setup is not a setup page: switched on during setup, set up in the Admin Panel. */
export const ADMIN_ONLY_SETUP: Record<string, string> = {
  obs: "Its setup — the rig page in OBS and the overlays — is in the Admin Panel once setup is finished (Utility → OBS).",
};

/** Steps only the setup pages show, appended to a list (after `after`, else at the end). */
export const WIZARD_STEPS: Record<string, { after?: string; step: RawStep }[]> = {
  "module:stripe": [{ after: "webhook", step: {
    id: "price", title: "The supporter subscription's price", need: "optional",
    explain: "Subscriptions need a monthly Price in Stripe. Product catalogue → Add product: a name (Supporter), Recurring, Monthly, your amount and currency → Save. Open the price and copy its id (price_…). Leave it empty and the site offers no subscriptions or gift subs; tips and points still work. Check asks Stripe that the price is active, recurring and monthly — the key needs Read on Prices for that.",
    links: [{ label: "Stripe: product catalogue", url: "https://dashboard.stripe.com/products" }],
    paste: [], fields: ["stripe.supporterPriceId"], test: "stripe.supporterPriceId",
  } }],
  "core:kick": [{ step: {
    id: "ids", title: "Kick's chatroom and channel ids (only if needed)", need: "optional",
    explain: "Leave these empty. Only if the Doctor says the Kick reader cannot find your chatroom (Kick's bot protection can block the lookup): open kick.com/api/v2/channels/<your name> in your own browser, and copy the number after \"chatroom\":{\"id\": as the chatroom id and the first \"id\" as the channel id.",
    links: [], paste: [], fields: ["kick.chatroomId", "kick.channelId"], test: null,
  } }],
};

type WizardList = { id: string; label: string; description: string; source: string | null; steps?: string[]; own?: RawStep[] };

/** The setup pages' choices of what else to set up, in order. `source` is the config list a page is
 *  drawn from (`steps`: only those of its steps); `own` is a list only the setup pages have. */
export const WIZARD_LISTS: WizardList[] = [
  { id: "twitch", label: "", description: "", source: "twitch" },
  { id: "kick", label: "", description: "", source: "kick" },
  { id: "streamplace", label: "", description: "", source: "streamplace" },
  { id: "kofi", label: "Ko-fi", description: "Ko-fi tips and memberships shown as alerts and counted on the support bar.", source: "donations", steps: ["kofi"] },
  { id: "patreon", label: "Patreon", description: "New Patreon members shown as alerts and counted on the support bar.", source: "donations", steps: ["patreon"] },
  { id: "streamlabs", label: "Streamlabs", description: "Streamlabs tips shown as alerts and counted on the support bar.", source: "donations", steps: ["streamlabs"] },
  { id: "voice", label: "Read-aloud voice (ElevenLabs)", source: null,
    description: "Alerts, paid messages and the bot spoken on stream with an ElevenLabs voice. The sound reaches your stream through the rig page in OBS.",
    own: [{
      id: "voice", title: "Your ElevenLabs key and voice", need: "optional",
      explain: "ElevenLabs → Developers → API keys → Create key, with access to Text to Speech, Models and Voices. Paste it, then pick a voice in ElevenLabs' Voices page and copy its voice id. Speaking stays off until you switch it on here.",
      links: [{ label: "ElevenLabs: API keys", url: "https://elevenlabs.io/app/settings/api-keys" }, { label: "ElevenLabs: voices", url: "https://elevenlabs.io/app/voice-library" }],
      paste: [], fields: ["elevenlabs.apiKey", "tts.voiceCasual", "tts.voiceLoud", "tts.enabled"], test: "elevenlabs.apiKey",
    }],
  },
];

/** An older setup's choice of the one combined donations page → the three it became. */
export function expandChosen(chosen: readonly string[]): string[] {
  return [...new Set(chosen.flatMap((c) => (c === "donations" ? ["kofi", "patreon", "streamlabs"] : [c])))];
}

// ── the shape of a value ────────────────────────────────────────────────────────────────────

const https = (v: string) => { try { const u = new URL(v); return u.protocol === "https:" && !!u.hostname && !u.username && !u.password; } catch { return false; } };

/** Per key: what a value must look like, and how to say what is wrong. Lenient where a provider
 *  does not document its format: a shape that refuses a real value is worse than none.
 *  @test-only exported so setupExtras.test.ts can hold every key to the schema and every page field to a check (the pages read it through formatProblem). */
export const FIELD_FORMATS: Record<string, { ok: (v: string) => boolean; says: string }> = {
  "stripe.secretKey": { ok: (v) => /^(rk|sk)_(live|test)_[A-Za-z0-9]{8,}$/.test(v), says: "a Stripe key starts rk_live_ or rk_test_ (restricted) — sk_ also works" },
  "stripe.publishableKey": { ok: (v) => /^pk_(live|test)_[A-Za-z0-9]{8,}$/.test(v), says: "the publishable key starts pk_live_ or pk_test_" },
  "stripe.webhookSecret": { ok: (v) => /^whsec_[A-Za-z0-9]+$/.test(v), says: "the signing secret starts whsec_ (Webhooks → your destination → Reveal)" },
  "stripe.supporterPriceId": { ok: (v) => /^price_[A-Za-z0-9]{4,}$/.test(v), says: "a price id starts price_ (not the product id, prod_)" },
  "paypal.clientId": { ok: (v) => /^[A-Za-z0-9_-]{20,128}$/.test(v), says: "PayPal's client id: one long word of letters, digits, - and _" },
  "paypal.clientSecret": { ok: (v) => /^[A-Za-z0-9_-]{20,128}$/.test(v), says: "PayPal's secret: one long word of letters, digits, - and _" },
  "paypal.webhookId": { ok: (v) => /^[A-Z0-9]{8,40}$/.test(v), says: "the webhook id PayPal shows: capital letters and digits" },
  "twitch.clientId": { ok: (v) => /^[a-z0-9]{20,40}$/.test(v), says: "Twitch's client id: about 30 lower-case letters and digits" },
  "twitch.clientSecret": { ok: (v) => /^[a-z0-9]{20,40}$/.test(v), says: "Twitch's client secret: about 30 lower-case letters and digits" },
  "platform.twitch.channel": { ok: (v) => /^[A-Za-z0-9_]{3,25}$/.test(v), says: "the channel name only, as in twitch.tv/<name>" },
  "platform.twitch.broadcasterId": { ok: (v) => /^\d{1,20}$/.test(v), says: "digits only — the id Check shows" },
  "platform.kick.slug": { ok: (v) => /^[A-Za-z0-9_-]{2,40}$/.test(v), says: "the channel name only, as in kick.com/<name>" },
  "kick.clientId": { ok: (v) => /^[A-Za-z0-9]{10,128}$/.test(v), says: "Kick's client id: one word of letters and digits" },
  "kick.clientSecret": { ok: (v) => /^[A-Za-z0-9]{10,128}$/.test(v), says: "Kick's client secret: one word of letters and digits" },
  "platform.kick.userId": { ok: (v) => /^\d{1,20}$/.test(v), says: "digits only — the id Check shows" },
  "kick.chatroomId": { ok: (v) => /^\d{1,20}$/.test(v), says: "digits only" },
  "kick.channelId": { ok: (v) => /^\d{1,20}$/.test(v), says: "digits only" },
  "platform.youtube.channelId": { ok: (v) => /^UC[A-Za-z0-9_-]{22}$/.test(v), says: "a channel id is UC followed by 22 letters, digits, - or _ (not the @handle)" },
  "youtube.apiKey": { ok: (v) => /^AIza[A-Za-z0-9_-]{35}$/.test(v), says: "a Google API key starts AIza and is 39 characters" },
  "platform.streamplace.did": { ok: (v) => /^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]{1,253})$/.test(v), says: "a DID like did:plc:… (24 letters and digits after it)" },
  "platform.streamplace.channel": { ok: (v) => /^[A-Za-z0-9.-]{3,253}$/.test(v) && v.includes("."), says: "a handle like you.bsky.social, without the @" },
  "kofi.verificationToken": { ok: (v) => /^[A-Za-z0-9-]{16,64}$/.test(v), says: "the verification token Ko-fi shows under the webhook address" },
  "patreon.webhookSecret": { ok: (v) => /^[A-Za-z0-9_-]{16,128}$/.test(v), says: "the secret Patreon shows for the webhook" },
  "streamlabs.socketToken": { ok: (v) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v), says: "the Socket API token: three parts joined by dots (it starts eyJ)" },
  "elevenlabs.apiKey": { ok: (v) => /^[A-Za-z0-9_]{24,80}$/.test(v), says: "the ElevenLabs key: one long word (it often starts sk_)" },
  "tts.voiceCasual": { ok: (v) => /^[A-Za-z0-9]{10,40}$/.test(v), says: "a voice id: letters and digits, from the voice's ID button" },
  "tts.voiceLoud": { ok: (v) => /^[A-Za-z0-9]{10,40}$/.test(v), says: "a voice id: letters and digits, from the voice's ID button" },
  "site.donateUrl": { ok: (v) => https(v) && v.length <= 512, says: "a full https:// address" },
};

/** What is wrong with a value's shape, in words — null when it is fine or blank (blank = unset). */
export function formatProblem(key: string, value: string): string | null {
  const v = value.trim();
  const f = FIELD_FORMATS[key];
  if (!v || !f) return null;
  return f.ok(v) ? null : f.says;
}
