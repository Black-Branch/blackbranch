import { MatrixClientProvider } from "@/app/lib/MatrixClientContext";
import PwaInstallNudge from "@/app/components/PwaInstallNudge";
import MatrixAppsHint from "@/app/components/MatrixAppsHint";
import SecureAccountPrompt from "@/app/components/SecureAccountPrompt";
import PresenceBeat from "@/app/components/PresenceBeat";

// No top nav — the wordmark lives on the video embed bar and the user
// settings (with the crypto traffic-light dot) live in the chat typing bar.
// App-wide nudges (PWA install, mobile Matrix-app hint, secure-account prompt)
// mount here, inside MatrixClientProvider, so they cover the whole app but not
// the /popout overlay.
export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <MatrixClientProvider>
      <div className="h-full flex flex-col">
        {/* First tab stop on every page. Little stands before <main> in DOM
            order, but the pages themselves front-load chrome (embed bar, dock)
            ahead of the content a keyboard user came for — this jumps it.
            sr-only until focused: visible it is chrome, absent it is nothing
            (iconButtonNames.test.ts). */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-(--z-top) focus:top-2 focus:left-2 focus:px-3 focus:py-1.5 focus:rounded focus:bg-panel focus:text-strong"
        >
          Skip to main content
        </a>
        {/* The one <main> landmark for the app (screen-reader bypass-block target). */}
        <main id="main-content" className="flex-1 min-h-0">{children}</main>
      </div>
      <PwaInstallNudge />
      <MatrixAppsHint />
      <SecureAccountPrompt />
      <PresenceBeat />
    </MatrixClientProvider>
  );
}
