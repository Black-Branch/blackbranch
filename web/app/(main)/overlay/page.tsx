import { redirect } from "next/navigation";
import Link from "next/link";
import { isModUser } from "@/app/lib/admin";
import OverlayDirectory from "@/app/components/OverlayDirectory";
import ModPageShell from "../mod/ModPageShell";
import { siteName } from "@/app/lib/siteName";

export const metadata = { title: `Overlay directory · ${siteName()}`, robots: { index: false, follow: false } };

// The overlay directory: every OBS
// browser source and the exact string OBS is given for it. Mod-gated like /mod
// — it names the API host and the rig's file paths. Lives in the (main) group
// so it wears the site chrome; the sources themselves live under app/overlay/
// with the transparent OBS layout.
export default async function OverlayDirectoryPage() {
  if (!(await isModUser())) redirect("/");

  return (
    <ModPageShell>
      <div className="w-full max-w-3xl mx-auto">
        <div className="mb-6">
          <Link href="/mod" className="text-muted hover:text-body-dim text-sm transition-colors">
            ← Mod panel
          </Link>
          <h1 className="mt-3 text-xl font-semibold text-heading">Overlay directory</h1>
          <p className="mt-1 text-sm text-secondary">
            Every OBS browser source, and the URL or file to point it at. Copy, paste into the source&apos;s
            URL or Local file field, set the size.
          </p>
        </div>
        <OverlayDirectory />
      </div>
    </ModPageShell>
  );
}
