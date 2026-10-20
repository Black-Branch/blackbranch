import PlatformIcon from "@/app/components/PlatformIcon";

// The left column when signed out: the button, the list, the seven marks under
// the integration line, and the About · Privacy links. Never "Your card" /
// "this could be you", never an explainer line, never the retired phrases
// (homeView.render.test.ts lists them). The sign-up steps replace this column
// after sign-in.
const MARKS: { key: string; name: string }[] = [
  { key: "twitch", name: "Twitch" },
  { key: "youtube", name: "YouTube" },
  { key: "kick", name: "Kick" },
  { key: "streamplace", name: "Streamplace" },
  { key: "discord", name: "Discord" },
  { key: "patreon", name: "Patreon" },
  { key: "element", name: "Element" },
];

export function SignInColumn() {
  return (
    <aside className="rounded-lg border border-edge bg-surface-2 p-4 flex flex-col gap-3">
      <a
        href="/auth/signin"
        className="block text-center rounded-md bg-surface-3 hover:bg-surface-5 text-strong font-semibold px-3 py-2"
      >
        Sign in or create an account
      </a>
      <ul className="text-sm text-secondary flex flex-col gap-1.5">
        <li>E2EE DMs and channels</li>
        <li>Ad free</li>
        <li>Private data</li>
        <li>
          Full cross-platform integration
          <span className="mt-1 flex flex-wrap items-center gap-2 text-strong">
            {MARKS.map((m) => (
              <span key={m.key} title={m.name} className="inline-flex">
                <PlatformIcon platform={m.key} size={16} />
              </span>
            ))}
          </span>
        </li>
        <li>Fully customizable</li>
      </ul>
      <p className="text-xs text-muted">
        <a href="/about" className="hover:text-strong">About</a> · <a href="/legal" className="hover:text-strong">Privacy</a>
      </p>
    </aside>
  );
}
