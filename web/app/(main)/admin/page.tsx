import { redirect } from "next/navigation";

// /admin opens on Site (the install's own name and look come first, not the AI); the section page
// checks admin on the server.
export default function AdminIndex() {
  redirect("/admin/site");
}
