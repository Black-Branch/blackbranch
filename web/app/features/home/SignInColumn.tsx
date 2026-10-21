import PlatformIcon from "@/app/components/PlatformIcon";

// The left column when signed out: the button, the list, the marks of the platforms this install
// has set up under the integration line, and the About · Privacy links. Never "Your card" /
// "this could be you", never an explainer line, never the retired phrases (homeView.render.test.ts
// lists them — "Ad free" is false beside embedded players, "Private data" promised nothing
// checkable). The sign-up steps replace this column after sign-in.
//
// The marks come from the server (the Home body's `platforms`): a mark for a platform the install
// has not set up would promise an integration that is not there. No platform set up = no line.
const MARKS: { key: string; name: string }[] = [
  { key: "twitch", name: "Twitch" },
  { key: "youtube", name: "YouTube" },
  { key: "kick", name: "Kick" },
  { key: "streamplace", name: "Streamplace" },
  { key: "discord", name: "Discord" },
  { key: "patreon", name: "Patreon" },
  { key: "element", name: "Element" },
];

export function SignInColumn({ platforms }: {
  /** The platforms this install has set up (PlatformIcon ids); null = the server did not say. */
  platforms: readonly string[] | null;
}) {
  const marks = MARKS.filter((m) => platforms?.includes(m.key));
  return (
    <aside className="rounded-lg border border-edge bg-surface-2 p-4 flex flex-col gap-3">
      <a
        href="/auth/signin"
        className="block text-center rounded-md bg-surface-3 hover:bg-surface-5 text-strong font-semibold px-3 py-2"
      >
        Sign in or create an account
      </a>
      <ul className="text-sm text-secondary flex flex-col gap-1.5">
        <li>End-to-end encrypted DMs and private channels</li>
        {marks.length > 0 && (
          <li data-home-marks>
            Full cross-platform integration
            <span className="mt-1 flex flex-wrap items-center gap-2 text-strong">
              {marks.map((m) => (
                <span key={m.key} title={m.name} className="inline-flex">
                  <PlatformIcon platform={m.key} size={16} />
                </span>
              ))}
            </span>
          </li>
        )}
        <li>Fully customizable</li>
      </ul>
      <p className="text-xs text-muted">
        <a href="/about" className="hover:text-strong">About</a> · <a href="/legal" className="hover:text-strong">Privacy</a>
      </p>
    </aside>
  );
}
