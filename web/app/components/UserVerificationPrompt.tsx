"use client";

import nextDynamic from "next/dynamic";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";

// Mounted once under MatrixClientProvider (app/(main)/layout.tsx), so another person's verification
// request reaches the person wherever they are on the site — the DM window, the chat, the community.
// It starts nothing: it renders only once the client is running. The window half carries the
// crypto-api dependency and is its own chunk, as SecureAccountPrompt does.

const Host = nextDynamic(() => import("./UserVerificationWindow"), { ssr: false });

export default function UserVerificationPrompt() {
  // Another person's requests have their own slot (MatrixClientContext): Settings keeps yours.
  const { client, status, pendingUserVerification, clearPendingUserVerification } = useMatrixClient();
  if (status !== "ready" || !client) return null;
  return <Host client={client} pendingVerification={pendingUserVerification} clearPendingVerification={clearPendingUserVerification} />;
}
