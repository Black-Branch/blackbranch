import { instanceList, instanceString } from "./instanceConfigServer.ts";
// Staff accounts: the streamer, the bot, and any extras. They are comp Supporters by code —
// always entitled regardless of any Stripe state — are never gift recipients, and their chat
// badges are curated by hand (the automated badge system never touches them). Keeping this in
// its own tiny module avoids coupling the chat hot path to the Stripe SDK that billingServer
// pulls in.
//
// DERIVED, never stored: instance keys streamer.matrixId + bot.matrixId +
// staff.extraMatrixIds, read per call so an edit applies without a restart. An unset key adds
// nobody — staff is a privilege, so the empty end is the safe one.

export function staffMatrixIds(): Set<string> {
  const ids = [instanceString("streamer.matrixId"), instanceString("bot.matrixId"), ...instanceList("staff.extraMatrixIds")];
  return new Set(ids.filter((s): s is string => !!s));
}

export function isStaff(matrixId: string): boolean {
  return staffMatrixIds().has(matrixId);
}
