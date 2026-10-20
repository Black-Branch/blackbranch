// The pinned-message shape.
//
// Lives in core: lib/useChatPin.ts owns pin state and must not import the banner
// that renders it (dependency direction). PinnedBanner re-exports it so existing
// `import PinnedBanner, { type PinnedMessage } from "./PinnedBanner"` works.

import type { EquippedStyle } from "./usernameStyles";

export type PinnedMessage = {
  id: number;
  platform: string;
  messageId: number;
  username: string;
  message: string;
  emotes: Record<string, string> | null;
  auto: boolean;
  pinnedBy: string | null;
  ts: number;
  /** The author, resolved live by the server (lib/pinAuthor.ts) so the banner
   *  wears the same style and badges as the author's chat rows. Optional:
   *  a frame from before this shipped, or an unlinked chatter, has none. */
  matrixId?: string | null;
  usernameColor?: string | null;
  usernameStyle?: EquippedStyle | null;
};
