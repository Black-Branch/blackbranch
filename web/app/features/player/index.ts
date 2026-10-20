// The player feature's PUBLIC API.
//
// StreamPlayerArea is the only entry point — StreamView composes it alongside
// the chat sidebar. The WHEP/HLS machinery inside StreamplaceThinPlayer is
// internal and free to be reshaped without touching a caller, which is the
// precondition for decomposing it (it is one large component, not a
// set of sections like the mod panel, so that is a real refactor rather
// than a slice-by-divider job).
//
// NOT decomposed ON PURPOSE: the connection logic cannot be exercised
// offline — WebRTC will not handshake against a dead stream — so a refactor of
// it can only be verified live, and a break would surface mid-stream with no
// way to tell the refactor from an original bug. Its policy is pulled into
// pure modules (whepEscalation, playerStats) precisely so the parts that CAN be
// tested are.
//
// StreamView deliberately stays OUT of this feature: it imports ChatSidebar, so
// it is the page's composition root (player + chat + meta), not part of the
// player. Moving it here would seal that coupling inside the feature.

export { StreamPlayerArea } from "./StreamPlayerArea";
