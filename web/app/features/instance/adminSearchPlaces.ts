// The Admin Panel's places for another panel's search, with this install's
// plugin places included. Kept apart from adminLayout.ts so that file stays free of the plugin seam.
import { ADMIN_PLUGIN_PANELS } from "@/app/lib/plugins/admin";
import type { PanelPlace } from "@/app/lib/panelSearch";
import { adminPlacesFor } from "./adminLayout";

export function searchAdminPlaces(query: string): PanelPlace[] {
  return adminPlacesFor(query, ADMIN_PLUGIN_PANELS);
}
