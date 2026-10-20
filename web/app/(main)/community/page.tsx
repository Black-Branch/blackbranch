"use client";
import dynamic from "next/dynamic";
import { ErrorBoundary } from "@/app/components/ErrorBoundary";
import { Skeleton } from "@/app/components/Skeleton";

// Perceived-performance fallback while the client-only MatrixView
// chunk loads + mounts. Approximates the expanded community shell: a room-list
// rail + a timeline of message rows, so the layout doesn't pop in.
function CommunitySkeleton() {
  return (
    <div role="status" className="flex h-screen bg-canvas text-strong">
      <span className="sr-only">Loading community…</span>
      <div className="hidden sm:flex w-64 shrink-0 flex-col gap-2 border-r border-edge p-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-full shrink-0" />
            <Skeleton className="h-3 flex-1 rounded" />
          </div>
        ))}
      </div>
      <div className="flex-1 flex flex-col gap-4 p-4 max-w-3xl">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton className="h-9 w-9 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-1/4 rounded" />
              <Skeleton className={`h-3 rounded ${i % 3 === 0 ? "w-3/4" : "w-1/2"}`} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const CommunityPage = dynamic(() => import("@/app/components/CommunityPage"), {
  ssr: false,
  loading: () => <CommunitySkeleton />,
});

export default function Community() {
  return (
    <ErrorBoundary>
      <CommunityPage />
    </ErrorBoundary>
  );
}
