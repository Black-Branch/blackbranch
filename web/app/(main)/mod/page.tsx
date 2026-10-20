import { redirect } from "next/navigation";
import { isModUser } from "@/app/lib/admin";
import { siteName } from "@/app/lib/siteName";
import { isModPlace } from "@/app/features/moderation";
import ModPopout from "./ModPopout";

export const metadata = { title: `Mod panel · ${siteName()}` };

// The mod window's pop-out (and direct URL; `?place=` opens a place). Mods only — checked here on
// the server, and again by every /api/mod/* route the panel calls.
export default async function ModPage({ searchParams }: { searchParams: Promise<{ place?: string | string[] }> }) {
  if (!(await isModUser())) redirect("/");
  const { place } = await searchParams;
  return <ModPopout place={typeof place === "string" && isModPlace(place) ? place : undefined} />;
}
