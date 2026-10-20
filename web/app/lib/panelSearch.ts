// One search across both panels: each panel's search also lists the other panel's places that
// match, and choosing one opens that panel there. The shape a panel hands the other — the panels'
// own layouts stay in their features.

/** A place in one of the two panels. `id` is the place key (`chat`, or `ai/bot` for the Admin Panel). */
export type PanelPlace = { panel: "mod" | "admin"; id: string; label: string; group?: string };
