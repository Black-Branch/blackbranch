"use client";

import { useRouter } from "next/navigation";
import { AdminWindow, type AdminSection } from "@/app/features/instance";
import { closePopoutPage } from "@/app/components/PopoutClose";

// /admin/<section> — the admin window as its own page, with the open place kept in the URL.
export default function AdminPopout({ section, sub }: { section: AdminSection; sub?: string }) {
  const router = useRouter();
  return (
    <AdminWindow popout section={section} sub={sub}
      // Opens a Mod Panel place that the admin search found.
      onOpenMod={(p) => router.push(`/mod?place=${encodeURIComponent(p)}`)}
      onClose={() => closePopoutPage(() => router.push("/"))} />
  );
}
