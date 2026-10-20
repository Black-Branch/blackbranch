import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/admin";
import { isAdminSection } from "@/app/features/instance";
import { siteName } from "@/app/lib/siteName";
import AdminPopout from "./AdminPopout";

export const metadata = { title: `Admin panel · ${siteName()}` };
export const dynamic = "force-dynamic";

// The Admin Panel's page form: the same window as the floating one, as a page. ADMIN ONLY — checked
// here on the server (a non-admin is sent home before anything renders), and again by every API route
// the panel calls. Switching places inside it uses history.pushState and does not come back here.
export default async function AdminSectionPage({ params, searchParams }: {
  params: Promise<{ section: string }>;
  searchParams: Promise<{ sub?: string | string[] }>;
}) {
  if (!(await requireAdmin())) redirect("/");
  const { section } = await params;
  if (!isAdminSection(section)) notFound();
  const { sub } = await searchParams;
  return <AdminPopout section={section} sub={typeof sub === "string" ? sub : undefined} />;
}
