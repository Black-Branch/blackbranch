import type { ReactNode } from "react";
import type { HomeWidgetDef } from "../homeLayout";

// The shell every Home widget wears: title and body. Grid placement (`full`)
// is the shell's business so the widgets are not; overflow-hidden because a
// widget's row count is its bound. A widget whose title is
// state (the Leaderboard's face name) passes `header={null}` and
// draws its own header row as its first child.
// Live and offline wear the same shell; HomeView's grid places them either way.
export function Widget({ def, header, children }: {
  def: HomeWidgetDef;
  header?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-widget={def.id}
      className={`rounded-lg border border-edge bg-surface-2 p-3 min-w-0 flex flex-col gap-2 overflow-hidden${def.full ? " col-span-full" : ""}`}
    >
      {header === undefined ? (
        <h2 className="text-sm font-semibold text-strong">
          {def.narrowTitle
            ? <><span className="md:hidden">{def.narrowTitle}</span><span className="hidden md:inline">{def.title}</span></>
            : def.title}
        </h2>
      ) : header}
      <div className="text-sm text-secondary min-h-0">{children}</div>
    </section>
  );
}
