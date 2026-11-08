"use client";
// A jump from the Stream tab into the Admin Panel at one place. The tab is a streamer's live tool,
// so the jump opens the Admin WINDOW over the stream (the claimable bb:open-adminpanel event, with
// the place — the user-menu hub hosts it) and the stream keeps playing. With no host mounted the
// link does what any link does: the /admin/<section>?sub=<place> page, the same deep link the
// Admin window's pop-out uses. No new routing.
import type { ReactNode } from "react";
import Link from "next/link";
import { dispatchClaimable } from "@/app/lib/claimableEvent";
import { adminHref, adminPlaceParts } from "@/app/features/instance";

/** `place` is an Admin Panel place id: `<section>/<sub>`, or a section alone (`doctor`). */
function adminPlaceHref(place: string): string {
  const p = adminPlaceParts(place);
  return p ? adminHref(p) : "/admin";
}

/** The place an `/admin/<section>?sub=<sub>` link names (a server-built setup link). */
export function placeFromAdminHref(href: string): string {
  const u = new URL(href, "http://site.invalid");
  const section = u.pathname.split("/")[2] ?? "";
  const sub = u.searchParams.get("sub");
  return sub ? `${section}/${sub}` : section;
}

export function AdminJump({ place, className, children }: { place: string; className?: string; children: ReactNode }) {
  return (
    <Link
      href={adminPlaceHref(place)}
      data-admin-jump={place}
      className={className ?? "underline hover:text-strong"}
      onClick={(e) => {
        // A modified click (new tab, new window) keeps the link's own meaning.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        if (dispatchClaimable("bb:open-adminpanel", { place })) e.preventDefault();
      }}
    >
      {children}
    </Link>
  );
}
