"use client";

import { usePathname } from "next/navigation";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { usePresenceBeat } from "@/app/lib/usePresenceBeat";

// Mounted once under MatrixClientProvider (app/(main)/layout.tsx). Renders
// nothing. `community` is "the Matrix client is running on this tab" — the
// only state in which a message can reach the viewer live.
export default function PresenceBeat() {
  const { status } = useMatrixClient();
  const pathname = usePathname() ?? "/";
  usePresenceBeat({ community: status === "ready", pathname });
  return null;
}
