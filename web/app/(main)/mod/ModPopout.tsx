"use client";

import { useRouter } from "next/navigation";
import { ModWindow, type ModPlace } from "@/app/features/moderation";
import { searchAdminPlaces } from "@/app/features/instance";
import { closePopoutPage } from "@/app/components/PopoutClose";

// /mod — the mod window as its own page: the same window, band, rail and search as the floating
// one, never a bare page of links. Its Admin panel button — and an Admin Panel place its search
// found — opens /admin here.
export default function ModPopout({ place }: { place?: ModPlace }) {
  const router = useRouter();
  return (
    <ModWindow
      popout
      place={place}
      searchAdmin={searchAdminPlaces}
      onClose={() => closePopoutPage(() => router.push("/"))}
      onOpenAdmin={(p) => {
        const [section, sub] = (p ?? "ai").split("/");
        router.push(sub ? `/admin/${section}?sub=${encodeURIComponent(sub)}` : `/admin/${section}`);
      }}
    />
  );
}
