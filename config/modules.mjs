// The module manifests — one entry per part of the platform that can be switched off.
//
// Each manifest names what the module owns, so one switch can turn it off and a test can prove
// the switch works.
//
// Imports nothing. config/instance-schema.mjs derives one settings key per manifest
// (`modules.<id>`, a restart-applied switch) from this list, and tools/gen-instance-schema.mjs
// copies the list into the packages that read it — never import this file from a package.
//
// Fields:
//   id          the switch is `modules.<id>`; env `MODULE_<ID>` overrides it.
//   kind        'module' = part of the product · 'owner' = an owner-only plugin: started by the
//               owner plugin (stream-api/owner/), and "not installed" when there is none.
//   defaultOn   the value on a fresh install. Off ≠ uninstalled: off means not started, its routes
//               not mounted (404), its tables kept.
//   packages    the processes that read the switch.
//   api.files   the stream-api files the module owns, by base name (top level, or stream-api/owner/
//               for an owner module) — route-surface.test.js reads the routes in them as
//               this module's routes.
//   settings    the settings keys that configure the module.
//   doneTest    what proves the switch works: 'boot:off' = stream-api boots with it off, its routes
//               answer 404 and it logs nothing (modules-boot.db.test.js).
//   setup       (product modules only, optional) the setup pages' steps for this module — shown when
//               the module is switched on during setup. The step shape and its check are in
//               config/setup-core.mjs; a bad shape fails check:instance-schema.
//   servesMedia (optional) true when the module hands out large audio or video files. The doctor
//               fails such a module switched on in tunnel mode.
//   legacyOn    (optional) the part existed, always on, before it had a switch (youtube, stripe,
//               paypal). On a database built by the migration chain (no schema_migrations row
//               noted 'baseline') an ABSENT switch reads ON, loudly — so a deploy that runs before
//               the migration writing the switch rows cannot silently switch off a payment provider. A baseline-built database reads the
//               default (off). An explicit row or MODULE_<ID> always wins.
//   helpdesk    (optional) what the help desk tells a viewer: `on` while the module is switched on;
//               `off` (optional) while it is off, so it never says the part exists. A module with
//               no `off` is not mentioned at all while off. stream-ingest/lib/helpdesk builds its
//               facts from these and the switches, never from a hand list.
//
// A module whose `packages` does not include stream-api owns no stream-api files: stream-api's
// modules.js starts only the manifests it reads.
//
// ONE RULE for a switch more than one package reads: the module is ON where, and when, the process
// that SERVES it runs it — stream-api when `packages` includes it, else the other server process
// that reads the switch. That process applies the switch at its start (`reload: 'restart'`); every
// other package shows the module's part from what that process RUNS (its own report: stream-api's
// GET /config `self`, or `reports[<package>]`), never from the saved switch. So a saved change
// reaches every package at the same moment — that process's restart — and the website never shows
// a part whose routes answer 404, nor hides one that is still running. A switch only the website
// reads (stripe, paypal) is the website's own and applies at once. Web: app/lib/moduleRunning.ts.

export const MODULES = [
  {
    id: 'obs', label: 'OBS control', kind: 'module', defaultOn: false, packages: ['stream-api'],
    description: 'One browser source in OBS, the rig page, plays the bot\'s voice into your stream, draws the bot\'s avatar, switches scenes on request and pauses the timer on a scene. It connects out from OBS, so it works from any network. Off: the rig page is refused and nothing reaches OBS.',
    api: { files: ['obs.js', 'rig.js'] }, settings: ['obs.url', 'obs.password'], doneTest: ['boot:off'],
    setup: [
      {
        id: 'rig', title: 'Add the rig page to OBS', need: 'required',
        explain: 'In OBS: Sources → + → Browser. Paste the rig page address from Admin Panel → Utility → OBS (it carries this site\'s key, so keep it private), width 1920, height 1080. Tick "Control audio via OBS" so the voice reaches your stream. For scene switching, set "Page permissions" to "Advanced access to OBS". Put the source in every scene you stream from (or in a scene you nest into each). Nothing is installed on your computer.',
        links: [{ label: 'OBS: browser sources', url: 'https://obsproject.com/kb/browser-source' }],
        paste: [], fields: [], test: null,
      },
      {
        id: 'pause', title: 'Pause the timer on a scene', need: 'optional',
        explain: 'The stream timer pauses while OBS shows this scene (a break scene, say) and plays on any other. The rig page tells the site which scene is on, so its page permission must be at least "Read access to user information". Type the name exactly as OBS shows it.',
        links: [], paste: [], fields: ['timer.pauseScene'], test: null,
      },
    ],
  },
  {
    id: 'lights', label: 'Room lights', kind: 'owner', defaultOn: false, packages: ['stream-api'],
    description: 'Flashes Home Assistant lights on alerts and runs a resting colour wash. Off: Home Assistant is never called.',
    api: { files: ['lights.js'] }, settings: ['homeassistant.url', 'homeassistant.token'], doneTest: ['boot:off'],
  },
  {
    id: 'meter', label: 'Support meter', kind: 'owner', defaultOn: false, packages: ['stream-api'],
    description: 'The pace meter on the stream bar, read from a finance snapshot table outside this platform. Off: no meter, and money events are not sent to it.',
    api: { files: ['meter.js'] }, settings: [], doneTest: ['boot:off'],
  },
  {
    id: 'radio', label: 'Radio', kind: 'owner', defaultOn: false, packages: ['web', 'stream-api'],
    description: 'The music station that plays when nobody is live, with its library and generated DJ segments. Off: the player has no Radio tab and never names the station, the radio\'s addresses answer "not found", and nothing is refreshed or generated.',
    api: { files: ['radio.js', 'radio-dj.js', 'radio-art.js', 'radio-zip.js'] }, settings: [], doneTest: ['boot:off'], servesMedia: true,
    helpdesk: { on: 'Radio: when nobody is live, the player has a Radio tab that plays music.' },
  },
  // ── Platform and payment modules ─────────────────────────────────────────────────────────
  {
    id: 'youtube', label: 'YouTube', kind: 'module', defaultOn: false, packages: ['web', 'stream-ingest'], legacyOn: true,
    description: 'Reads the chat of your YouTube live streams into site chat. Off: nothing is read from YouTube and no YouTube setup page is shown.',
    api: { files: [] }, settings: ['platform.youtube.channelId', 'youtube.apiKey'], doneTest: [],
    helpdesk: {
      on: 'YouTube: messages from the live chat of the streamer\'s YouTube streams appear in the site chat.',
      off: 'YouTube chat is not read on this site: messages typed on YouTube do not appear here.',
    },
    setup: [
      {
        id: 'channel', title: 'Your YouTube channel', need: 'required',
        explain: 'Reading chat needs no Google sign-in: the site reads your live chat the way a viewer\'s browser does. Paste your channel id (it starts with UC; YouTube Studio → Settings → Channel → Advanced settings shows it). An API key is optional: it finds your live stream sooner and checks the id. Make one in a Google Cloud project with the YouTube Data API v3 switched on, and restrict it to that API.',
        links: [
          { label: 'Find your channel id', url: 'https://www.youtube.com/account_advanced' },
          { label: 'Switch on the YouTube Data API v3', url: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com' },
          { label: 'Make an API key', url: 'https://console.cloud.google.com/apis/credentials' },
        ],
        paste: [], fields: ['platform.youtube.channelId', 'youtube.apiKey'], test: 'youtube.apiKey',
      },
    ],
  },
  {
    id: 'stripe', label: 'Card payments (Stripe)', kind: 'module', defaultOn: false, packages: ['web'], legacyOn: true,
    description: 'Card payments with your own Stripe account: subscriptions, gift subs, tips and points. You are the merchant; the money goes to your Stripe balance. Off: no card checkout, Stripe\'s webhook address answers "not found" (Stripe keeps its events and retries them for about three days), and card subscribers lose their Supporter perks at once while Stripe keeps charging them. Cancel their subscriptions in Stripe first, or switch back on.',
    api: { files: [] }, settings: ['stripe.secretKey', 'stripe.publishableKey', 'stripe.webhookSecret'], doneTest: [],
    helpdesk: {
      on: 'Card payments: tips and points can be paid by card. When the site has set a subscription price, the Supporter subscription and gift subscriptions can be paid by card too.',
      off: 'Card payments are not offered on this site, so gift subscriptions cannot be bought here.',
    },
    setup: [
      {
        id: 'keys', title: 'A restricted key and the publishable key', need: 'required',
        explain: 'In the Stripe Dashboard → Developers → API keys, make a RESTRICTED key (rk_…) for this site and set exactly the permissions listed below, everything else None. Paste it here with the publishable key (pk_…). Live keys take live money; test keys (rk_test_, pk_test_) take test cards only. Check only reads: your account, then each kind of object the site reads, so a missing Read permission is named. It cannot check the Write permissions without making something, so it never tries: a passing Check does not prove that checkout, the customer record or the billing portal will work. The last step below proves them.',
        links: [{ label: 'Stripe: API keys', url: 'https://dashboard.stripe.com/apikeys' }, { label: 'Stripe: restricted keys', url: 'https://docs.stripe.com/keys/restricted-api-keys' }],
        paste: [
          { label: 'Permissions: Write', value: 'Checkout Sessions · Customers · Customer portal' },
          { label: 'Permissions: Read', value: 'Subscriptions · Invoices · PaymentIntents · Webhook Endpoints · Account · Prices' },
        ],
        fields: ['stripe.secretKey', 'stripe.publishableKey'], test: 'stripe.secretKey',
      },
      {
        id: 'webhook', title: 'The webhook', need: 'required',
        explain: 'Stripe tells the site about every payment through a webhook. Developers → Webhooks → Add destination: your account, the API version below (the one this release reads payment events in — not simply the newest), the events listed below, endpoint URL as below. Then reveal the signing secret (whsec_…) and paste it here. Check confirms that a destination for this address exists, is enabled and sends every event the site handles.',
        links: [{ label: 'Stripe: webhooks', url: 'https://dashboard.stripe.com/webhooks' }],
        paste: [
          // The version this release's Stripe SDK sends (web/app/lib/stripe.ts leaves apiVersion
          // unset, so the SDK's default is what every request uses); a webhook destination on
          // another version sends payloads in a shape the handlers were not written for.
          // web/app/lib/stripeApiVersion.test.ts holds it equal to the installed SDK's.
          { label: 'API version', value: '2026-07-29.dahlia' },
          { label: 'Endpoint URL', value: '{origin}/api/billing/webhook' },
          { label: 'Events', value: 'checkout.session.completed · checkout.session.async_payment_succeeded · checkout.session.async_payment_failed · customer.subscription.created · customer.subscription.updated · customer.subscription.deleted · invoice.paid · invoice.payment_failed · payment_intent.payment_failed · refund.created · refund.updated · charge.dispute.created · charge.dispute.closed' },
        ],
        fields: ['stripe.webhookSecret'], test: 'stripe.webhookSecret',
      },
      {
        id: 'price', title: 'The supporter subscription\'s price', need: 'optional',
        explain: 'Subscriptions need a monthly Price in Stripe. Product catalogue → Add product: a name (Supporter), Recurring, Monthly, your amount and currency → Save. Open the price and copy its id (price_…). Leave it empty and the site offers no card subscriptions or gift subs; tips and points still work. Check asks Stripe that the price is active, recurring and monthly; the key needs Read on Prices for that.',
        links: [{ label: 'Stripe: product catalogue', url: 'https://dashboard.stripe.com/products' }],
        paste: [], fields: ['stripe.supporterPriceId'], test: null,
      },
      {
        id: 'cloudflare', title: 'Behind Cloudflare: let Stripe through', need: 'optional',
        explain: 'If your site is behind Cloudflare (the tunnel is) and Bot Fight Mode is on, it blocks Stripe\'s webhooks. On the Free plan no rule can make an exception to Bot Fight Mode, so turn Bot Fight Mode off: Cloudflare dashboard → your domain → Security → Settings, filter by Bot traffic. On Pro or higher, use Super Bot Fight Mode instead and add a custom rule: when the URI path equals the path below, action Skip, and choose Super Bot Fight Mode. This site cannot check either without a Cloudflare token; the doctor reminds you.',
        links: [{ label: 'Cloudflare: Bot Fight Mode', url: 'https://developers.cloudflare.com/bots/get-started/bot-fight-mode/' }, { label: 'Cloudflare: skip rules', url: 'https://developers.cloudflare.com/waf/custom-rules/skip/' }],
        paste: [{ label: 'URI path', value: '/api/billing/webhook' }],
        fields: [], test: null,
      },
      {
        id: 'trial', title: 'Before you take real money: one test purchase of each kind', need: 'optional',
        explain: 'The Checks above only read; nothing here writes to Stripe until a viewer starts a payment. So prove the Write permissions once, with test keys (rk_test_, pk_test_) and a webhook destination made in test mode: with Stripe\'s test card, subscribe, tip, buy points and gift a subscription to a second account, then open the billing portal from your account. If one of them fails, Stripe\'s Dashboard → Developers → Logs shows the refused request and the permission it lacked: add that one permission to the key, never switch to the full secret key. Then make the live key and a live webhook destination the same way and paste those instead.',
        links: [{ label: 'Stripe: test cards', url: 'https://docs.stripe.com/testing' }],
        paste: [], fields: [], test: null,
      },
    ],
  },
  {
    id: 'paypal', label: 'PayPal and Venmo', kind: 'module', defaultOn: false, packages: ['web'], legacyOn: true,
    description: 'Tips and points purchases through your own PayPal Business account, with Venmo when PayPal offers it. Tips, points and, with a billing plan set, the Supporter subscription; gifts are card payments (Stripe). Off: no PayPal button, and PayPal\'s webhook address answers "not found", so PayPal keeps its events and retries them for about three days. PayPal subscribers (a billing plan set) lose their Supporter perks at once while PayPal keeps charging them. Cancel their subscriptions in PayPal first, or switch back on.',
    api: { files: [] }, settings: ['paypal.env', 'paypal.clientId', 'paypal.clientSecret', 'paypal.webhookId', 'paypal.plans'], doneTest: [],
    helpdesk: {
      on: 'PayPal: tips and points can be paid with PayPal, and with Venmo when PayPal offers it (mostly US buyers). When the site has set up a PayPal plan, the Supporter subscription can be paid with PayPal too, also on a site without card payments: press Subscribe under the player (or open Support from the account menu) and choose PayPal. Gift subscriptions are card payments only.',
      off: 'PayPal and Venmo are not offered on this site.',
    },
    setup: [
      {
        id: 'app', title: 'Your PayPal app', need: 'required',
        explain: 'In the PayPal Developer Dashboard → Apps & Credentials, pick Live (or Sandbox to try it first) and create an app of type Merchant. Paste its client id and secret, and say which of the two it is. PayPal decides when to offer Venmo: only to a buyer it finds eligible, which in practice means a US business account and a US buyer paying in US dollars. Everyone else sees only PayPal. Subscription plans: monthly, a fixed price, and a payment failure threshold (3) set on the plan in PayPal — any other plan is refused credit and flagged; without the threshold PayPal keeps retrying and the perks last only a month past the last payment.',
        links: [{ label: 'PayPal: Apps & Credentials', url: 'https://developer.paypal.com/dashboard/applications/live' }],
        paste: [], fields: ['paypal.env', 'paypal.clientId', 'paypal.clientSecret'], test: 'paypal.clientSecret',
      },
      {
        id: 'webhook', title: 'The webhook', need: 'required',
        explain: 'Open the app → Webhooks → Add webhook: the URL below, and tick the events below. PayPal then shows a webhook id; paste it here. Check confirms that the id exists at PayPal, points at this site and sends every event the site handles.',
        links: [{ label: 'PayPal: webhooks', url: 'https://developer.paypal.com/api/rest/webhooks/' }],
        paste: [
          { label: 'Webhook URL', value: '{origin}/api/billing/paypal/webhook' },
          { label: 'Events', value: 'PAYMENT.CAPTURE.COMPLETED · PAYMENT.CAPTURE.REFUNDED · PAYMENT.CAPTURE.REVERSED · CUSTOMER.DISPUTE.RESOLVED · BILLING.SUBSCRIPTION.CREATED · BILLING.SUBSCRIPTION.ACTIVATED · BILLING.SUBSCRIPTION.UPDATED · BILLING.SUBSCRIPTION.EXPIRED · BILLING.SUBSCRIPTION.CANCELLED · BILLING.SUBSCRIPTION.SUSPENDED · BILLING.SUBSCRIPTION.PAYMENT.FAILED · PAYMENT.SALE.COMPLETED · PAYMENT.SALE.REFUNDED · PAYMENT.SALE.REVERSED' },
        ],
        fields: ['paypal.webhookId'], test: 'paypal.webhookId',
      },
      {
        id: 'plans', title: 'Supporter subscriptions through PayPal', need: 'optional',
        explain: 'Optional: lets viewers pay the Supporter subscription with PayPal too. In PayPal, make a billing plan that bills monthly at a fixed price, with a payment failure threshold of 3. Paste it as {"supporter":"P-…"} with your plan id in place of P-…. Any other kind of plan is refused credit and flagged. Leave it empty and PayPal takes tips and points only.',
        links: [{ label: 'PayPal: subscriptions', url: 'https://www.paypal.com/billing/plans' }],
        paste: [],
        fields: ['paypal.plans'], test: null,
      },
    ],
  },
];
