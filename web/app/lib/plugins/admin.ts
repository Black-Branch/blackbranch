// The Admin Panel's plugin places — read from the install's plugin through `@owner/admin`
// (app/(owner)/admin.ts, or ./absent/admin.ts with no owner folder). The pure layout
// (features/instance/adminLayout.ts) takes them as a parameter so node --test can load it.
import { adminPanels } from "@owner/admin";
import type { AdminPanelEntry } from "./types.ts";

/** The plugin's Admin Panel places, in order (none without a plugin). */
export const ADMIN_PLUGIN_PANELS: readonly AdminPanelEntry[] = adminPanels;
