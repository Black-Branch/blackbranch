// web/app/components/chrome/index.ts
// The ONLY door into the chrome module. check-chrome.mjs refuses imports of any
// file inside app/components/chrome/ from elsewhere, so the inside is free to be
// split or renamed. Consumers pass { items, value, onChange, label } — or, for a
// Bar, slot + slots — and nothing about appearance.
export { Sections, type SectionsProps } from "./Sections";
export { Bar, type BarProps } from "./Bar";
export { BarButton, type BarButtonProps } from "./BarButton";
export { Window, type WindowProps } from "./Window";
export { BootSequence, type BootSequenceProps } from "./BootSequence";
export { WindowLayerTarget } from "./WindowLayerTarget";
export { BackDebugOverlay } from "./BackDebugOverlay";
export { Panes, type PanesProps, type PaneDef } from "./Panes";
export { Segmented, type SegmentedProps } from "./Segmented";
export { Chips, type ChipsProps } from "./Chips";
export { Rail, type RailProps } from "./Rail";
export { IconRail, type IconRailProps, type IconRailItem } from "./IconRail";
export { RailLayout } from "./RailLayout";
export type { TabItem } from "@/app/lib/chrome/useTabList";
