import { redirect } from "next/navigation";

// Linked-accounts management moved onto the profile card (avatar → card →
// Linked accounts tab — AccountLinkPanel via LinkedAccountsInline). This route
// only survives so old bookmarks land somewhere sensible; the card is one
// click from home.
export default function AccountsPage() {
  redirect("/");
}
