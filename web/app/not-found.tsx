import Link from "next/link";
import { SITE_NAME } from "@/app/lib/legal";

// Styled 404. Renders inside the root layout (dark shell), so it only needs its
// own centered card. Server component — no interactivity needed.
export default function NotFound() {
  return (
    <div className="h-dvh overflow-y-auto bg-canvas text-strong flex items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <p className="text-sm font-semibold text-accent">404</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-strong">
          Page not found
        </h1>
        <p className="mt-3 text-base leading-relaxed text-secondary">
          This page doesn&apos;t exist, or it moved. The stream and the community
          are still where you left them.
        </p>
        <Link
          href="/"
          className="mt-8 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-opacity hover:opacity-90"
        >
          Back to {SITE_NAME}
        </Link>
      </div>
    </div>
  );
}
