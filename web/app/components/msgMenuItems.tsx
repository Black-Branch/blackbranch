import type { ReactNode } from "react";
import {
  ArrowBendUpLeft, ArrowClockwise, At, Chats, Copy, Link, PencilSimple, PushPin, PushPinSlash, Smiley, Trash,
} from "@phosphor-icons/react/dist/ssr";
import type { EchoState } from "@/app/lib/localEcho";

/** What a message offers its viewer. An absent handler = the action is not offered. One list for
 *  the desktop ⋯ menu (MsgContextMenu) and the phone's long-press sheet (MessageSheet). */
export type MsgMenuCtx = {
  onReact?: () => void;
  onReply?: () => void;
  onThread?: () => void;
  /** Insert "@name" into the composer (the row's tap target is the member card). */
  onMention?: () => void;
  onEdit?: () => void;
  onCopy: () => void;
  onCopyLink?: () => void;
  onPin?: () => void;
  pinned?: boolean;
  onDelete?: () => void;
  /** An unsent echo: send it again / take it off the timeline (localEcho.ts). */
  onRetry?: () => void;
  onDrop?: () => void;
};

export type MsgMenuItem = {
  id: string;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  /** Shown in place of the label after the first tap; the second tap runs. */
  confirm?: string;
  run: () => void;
};

const ICON = { size: 18, weight: "bold" } as const;

export function msgMenuItems(ctx: MsgMenuCtx, echo: EchoState): MsgMenuItem[] {
  const out: MsgMenuItem[] = [];
  const add = (cond: unknown, item: MsgMenuItem) => { if (cond) out.push(item); };
  const copy: MsgMenuItem = { id: "copy", label: "Copy text", icon: <Copy {...ICON} />, run: ctx.onCopy };
  if (echo !== "sent") {
    // Nobody received it: no reactions, replies or links — only what the sender can do with it.
    add(ctx.onRetry, { id: "retry", label: "Retry", icon: <ArrowClockwise {...ICON} />, run: () => ctx.onRetry?.() });
    add(ctx.onDrop, { id: "delete", label: "Delete", icon: <Trash {...ICON} />, danger: true, run: () => ctx.onDrop?.() });
    out.push(copy);
    return out;
  }
  add(ctx.onReact, { id: "react", label: "React", icon: <Smiley {...ICON} />, run: () => ctx.onReact?.() });
  add(ctx.onReply, { id: "reply", label: "Reply", icon: <ArrowBendUpLeft {...ICON} />, run: () => ctx.onReply?.() });
  add(ctx.onThread, { id: "thread", label: "Reply in thread", icon: <Chats {...ICON} />, run: () => ctx.onThread?.() });
  add(ctx.onMention, { id: "mention", label: "Mention", icon: <At {...ICON} />, run: () => ctx.onMention?.() });
  add(ctx.onEdit, { id: "edit", label: "Edit", icon: <PencilSimple {...ICON} />, run: () => ctx.onEdit?.() });
  out.push(copy);
  add(ctx.onCopyLink, { id: "copylink", label: "Copy link", icon: <Link {...ICON} />, run: () => ctx.onCopyLink?.() });
  add(ctx.onPin, {
    id: "pin", label: ctx.pinned ? "Unpin message" : "Pin message",
    icon: ctx.pinned ? <PushPinSlash {...ICON} /> : <PushPin {...ICON} />, run: () => ctx.onPin?.(),
  });
  // Two taps, the second one informed: no native confirm() (it would freeze the automation path).
  add(ctx.onDelete, {
    id: "delete", label: "Delete", icon: <Trash {...ICON} />, danger: true, confirm: "Delete message?",
    run: () => ctx.onDelete?.(),
  });
  return out;
}
