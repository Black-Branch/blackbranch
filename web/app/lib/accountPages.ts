// The account card's page table.
//
// One place naming every page the card can show, so the keys, the header
// titles and the per-page width floors can't drift apart across the files
// that navigate between them. Pure data — no React, no feature imports — so
// core may hold it (check-structure rules 1 and 4).

import { currencyTitle } from "./currency";
import { type CardPage } from "./cardStack";

export type PageKey =
  | "profile"
  | "edit"
  | "security"
  | "accounts"
  | "privacy"
  | "appearance"
  | "support"
  | "store";

export const PAGES: Record<PageKey, CardPage> = {
  profile: { key: "profile", title: "" },
  edit: { key: "edit", title: "Edit profile" },
  security: { key: "security", title: "Devices & Security" },
  accounts: { key: "accounts", title: "Linked accounts" },
  privacy: { key: "privacy", title: "Privacy" },
  appearance: { key: "appearance", title: "Chat appearance" },
  support: { key: "support", title: "Support" },
  store: { key: "store", title: currencyTitle() },
};

/** Width floors, applied on navigation — the card only ever grows to meet one
 *  (Window.minWidth). The mod panel is its own Window (its 720 floor lives in
 *  ModWindow), and the appearance rail is the big page here. A user who has
 *  sized the card wider than a floor keeps their width. */
export const PAGE_MIN_W: Partial<Record<PageKey, number>> = {
  // 436 (the content width every settings row was designed at: the old 460
  // floor minus the p-3 padding) + 160 rail column + 12 grid gap + 24 padding.
  // The rail must not shrink the controls below the width they already had.
  appearance: 632,
  store: 420,
  support: 420,
};

export const isPageKey = (k: string): k is PageKey => k in PAGES;
