"use client";

import ProfileCardBody from "@/app/components/ProfileCardBody";
import { useMatrixIdentity } from "@/app/lib/MatrixClientContext";
import { dispatchClaimable } from "@/app/lib/claimableEvent";
import type { PageKey } from "@/app/lib/accountPages";

// The signed-in left column: the account card's own root page,
// mounted here — one card, never a second implementation. Its rows open the
// account card on that page through the user-menu hub (useUserMenuEvents.ts),
// exactly as the chat-bar avatar would; Edit opens the sign-up steps in place.
const OPEN: Partial<Record<PageKey, string>> = {
  security: "bb:open-account-settings",
  accounts: "bb:open-linked-accounts",
  appearance: "bb:open-chat-appearance",
  support: "bb:open-support",
  store: "bb:open-store",
};

export function OwnCard({ onEdit }: { onEdit: () => void }) {
  const { matrixId } = useMatrixIdentity();
  if (!matrixId) return null;
  const navigate = (key: PageKey) => {
    if (key === "edit") return onEdit();
    const event = OPEN[key];
    if (event) dispatchClaimable(event);
  };
  return (
    <div className="rounded-lg bg-surface-1 overflow-hidden">
      <ProfileCardBody
        matrixId={matrixId}
        onNavigate={navigate}
        onOpenMod={() => { dispatchClaimable("bb:open-modpanel"); }}
        foldRows
      />
    </div>
  );
}
