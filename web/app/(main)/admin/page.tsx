import { redirect } from "next/navigation";

// /admin opens the first section; the section page checks admin on the server.
export default function AdminIndex() {
  redirect("/admin/ai");
}
