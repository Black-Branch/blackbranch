// Community › Privacy ("send read receipts" and "send typing", both ON by default).
//
// One place decides what leaves this browser; every sender asks it AT SEND TIME,
// so a switch flipped mid-conversation counts from the next send on:
//  • Typing off — no m.typing "true" is sent at all (a live announcement is still
//    withdrawn with "false": that tells the room nothing new). useTyping.ts.
//  • Read receipts off — no PUBLIC m.read receipt. The PRIVATE one (m.read.private,
//    MSC2285, stable since Matrix 1.4) and the m.fully_read marker are still sent:
//    they are visible to this account only, and they are what clears the server's
//    unread counts, so the channel dots keep working. Threads the same way.
//
// The values are the registry's keys (mxReceipts / mxTyping, behavior: true), read
// straight from localStorage: the Community never renders on the "ov:" pages, so
// there is no scope to honour. Anything but a stored "0" means ON (the default).
// Type-only SDK import on purpose: matrixDm.ts (the lazy terminal's DM reads) calls
// this and must not pull matrix-js-sdk into its chunk; the two strings below are the
// SDK's own ReceiptType values.
import type { MatrixClient, MatrixEvent, ReceiptType } from "matrix-js-sdk";
import { lsGet } from "./safeLocalStorage.ts";

const PUBLIC_RECEIPT = "m.read" as ReceiptType;
const PRIVATE_RECEIPT = "m.read.private" as ReceiptType;

const RECEIPTS_LS = "chatStyle_mxReceipts";
const TYPING_LS = "chatStyle_mxTyping";

/** Send public read receipts? (Community › Privacy › Send read receipts.) */
export function sendsReadReceipts(): boolean {
  return lsGet(RECEIPTS_LS) !== "0";
}

/** Send typing notifications? (Community › Privacy › Send typing.) */
export function sendsTyping(): boolean {
  return lsGet(TYPING_LS) !== "0";
}

type ReceiptClient = Pick<MatrixClient, "sendReadReceipt" | "setRoomReadMarkers">;

/**
 * Mark `ev` read the way the switch says. Main timeline: the fully-read marker +
 * the private receipt always, the public receipt only when allowed (one
 * /read_markers request either way). `single` — a thread's receipt, or the DM
 * reads' one-off — is one /receipt request, of the public or the private type.
 */
export function sendReadMarker(
  client: ReceiptClient,
  roomId: string,
  ev: MatrixEvent,
  opts: { single?: boolean; publicReceipt?: boolean } = {},
): Promise<unknown> {
  const pub = opts.publicReceipt ?? sendsReadReceipts();
  if (opts.single) return client.sendReadReceipt(ev, pub ? PUBLIC_RECEIPT : PRIVATE_RECEIPT);
  return client.setRoomReadMarkers(roomId, ev.getId() ?? "", pub ? ev : undefined, ev);
}
