// The community feature's PUBLIC API — the embedded Matrix client.
//
// WHY THIS IS A FEATURE AND NOT CORE, since "Matrix" sounds like core:
// Matrix is two different things in this app, and only one of them is core.
//   • Matrix SESSION / AUTH / IDENTITY — the ~19 app/lib/matrix*.ts modules
//     (matrixSession, MatrixClientContext, matrixCrypto, token minting). The
//     login system genuinely depends on these. They stay in core, importable by
//     anything, and nothing here replaces them.
//   • This folder — the Discord-like COMMUNITY CLIENT UI. Many viewers never
//     open it, and it is the surface slated to grow the most.
//
// The cut is real, not nominal: NOTHING in auth imports this folder. The one
// core module that mentions MatrixView (lib/contentSuggest.ts) reaches it by
// DISPATCHING AN EVENT, not by importing — the decoupled pattern was already
// here. So putting a boundary around the client cannot weaken login.
//
// Same distinction that held three times before it: lib/coins.ts (shared price
// table) vs the store feature, lib/platformMod (shared adapters) vs the mod
// panel, StreamView (composition root) vs the player. Each time the real
// boundary sat one layer in from where the folder name suggested.
//
// Everything else in here — Timeline, ThreadPanel, ForumView, SpacesRail,
// MemberList, the modals — is internal and free to be reshaped. MatrixView.tsx
// is still 734 lines and wants decomposing; this boundary is what makes that a
// zero-caller-change job.

export { default } from "./MatrixView";

// The Forums tab (features/forums) reaches the booted client for its actions
// through this ONE named export, loaded with next/dynamic — reading never
// touches the SDK.
export { ForumActionHost } from "./ForumActionHost";
