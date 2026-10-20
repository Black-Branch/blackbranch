// The chat feature's PUBLIC API.
//
// Three entry points, each a real one:
//   ChatSidebar  — the live chat panel (StreamView, PopoutView)
//   ChatOverlay  — the /overlay/chat page (OBS browser source: always follows)
//   ChatWindow   — the /chat page (the broadcaster's own chat window: pauses, keeps history)
//
// Internal: ChatTabBar, ChatInput, ChatMessage, SpendChip, StickerBoostPopover.
//
// ChatSettings is NOT here, and the structure guard is why. Putting it in the
// feature would create a real runtime cycle:
//   chat/index -> ChatSidebar -> ChatInput -> UserMenu -> chat/index
// because ChatInput renders UserMenu (the avatar lives in the input bar) and
// UserMenu opens the settings panel. ChatSettings is app CHROME reached from
// the user menu, not a chat internal — so it stays in components/ as shared
// UI. Same call as UserCard and EmoteCompletionList below.
//
// WHAT STAYS OUT, and why the line is there. Several chat-looking
// components are used by things that are NOT chat, so they are shared UI, not
// chat internals — pulling them in would make this feature undeletable:
//   ChatComposerField, EmotePicker  — also used by MatrixInput / ComposerTools
//   EmoteCompletionList             — also used by MatrixInput and SupportContent
//   UserCard                        — also used by ProfileCard and the
//                                     MODERATION feature's ChatHistorySection
//   PinnedBanner, PollCard          — paired with core types in app/lib/
// Same call as lib/coins.ts vs the store and lib/platformMod vs the mod panel:
// the widely-shared thing stays shared, and only the single-consumer pieces move.
//
// Chat DATA is core and stays core: useChatMessages, useChatSocket, chatMsg,
// wsFrames. This feature is the UI over that data, not the data itself.

export { default as ChatSidebar } from "./ChatSidebar";
export { default as ChatOverlay } from "./ChatOverlay";
export { default as ChatWindow } from "./ChatWindow";
