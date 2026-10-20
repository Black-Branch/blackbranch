// The moderation feature's PUBLIC API — the only thing outside this folder imports.
//
// Two entry points: ModWindow (the floating tool window
// every interactive open goes through — profile-card row, user-card shield)
// and ModPanel bare (the /mod direct-URL fallback renders it with its own
// strip). There is no darkened-backdrop modal form.
// Everything else here (IdentitySection, sections/, shared.ts) is internal
// and free to be split, renamed or rewritten without touching a caller. A
// plugin's own tabs come in through app/lib/plugins/mod.ts, not from here.
//
// NOTE what deliberately is NOT here: `app/lib/platformMod/**` (the Twitch/Kick/
// YouTube mod-action adapters). It is imported by several API routes and core modules,
// so it is shared infrastructure, not moderation-panel internals — the same
// distinction that keeps `lib/coins.ts` out of the store feature. The panel is the
// feature; the platform adapters are core the panel happens to use.

export { default as ModPanel } from "./ModPanel";
export { default as ModWindow } from "./ModWindow";
export { default as OtherPanelHits } from "./OtherPanelHits";
export { searchModPlaces, isModPlace, type ModPlace } from "./modLayout";
// The Admin Panel's places whose sections live in this feature: the Admin Panel renders them
// through these names — one copy each, shown in one place. Payment history: Payments → Payment
// history. Timer / Support bar / Effects: Utility → OBS. Badges and Support tickets: Site.
export { default as PaymentHistory } from "./sections/PaymentsSection";
export { default as TimerControls } from "./sections/TimerSection";
export { default as SupportBarControls } from "./sections/BarSection";
export { default as EffectsControls } from "./sections/EffectsSection";
export { default as BadgesAdmin } from "./sections/BadgesSection";
export { default as SupportTickets } from "./sections/SupportSection";
export { default as ModeratorList } from "./sections/ModeratorList";
// The Chat history's own pop-out: /mod/chat renders it.
export { default as ChatHistoryWindow } from "./ChatHistoryWindow";
