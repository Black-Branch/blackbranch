// Shared loading indicators (audit G). The ring existed only as copy-pasted
// markup in the Matrix settings sections; everywhere else a data-fetch wait
// showed bare "Loading…" text with no visual indicator at all. `Spinner` is
// the bare ring (compose into custom rows); `LoadingState` is the standard
// "ring + label" line for view-level waits — pass spacing/positioning via
// className, keep the text/color standard.

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block w-3 h-3 rounded-full border border-edge-strong border-t-zinc-300 animate-spin shrink-0 ${className}`}
    />
  );
}

export function LoadingState({
  label = "Loading…",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <p className={`flex items-center gap-2 text-xs text-muted ${className}`}>
      <Spinner />
      {label}
    </p>
  );
}
