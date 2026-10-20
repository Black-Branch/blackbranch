import { CreditOverlay } from "@/app/components/CreditOverlay";

// Fund the Night: the credit line as an OBS browser source served from the
// web app, so names render with chat's real username-style engine rather than
// a second copy in a static page. Point OBS at <site origin>/overlay/credit
// (transparent background; size like a credit.html source). credit.html stays
// in the mirror as the fallback.
export default function CreditOverlayPage() {
  return <CreditOverlay />;
}
