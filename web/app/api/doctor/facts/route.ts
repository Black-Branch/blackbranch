import { doctorKeyOk } from "@/app/lib/doctor/doctorKey";
import { gatherSiteFacts } from "@/app/lib/doctor/doctorFacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/doctor/facts — the site's half of the doctor's facts, for `blackbranch doctor` on the
// host. It asks from inside the web container with STREAM_API_SECRET, so the
// secret never leaves the container. Facts only — numbers, booleans and fixed words; the verdicts
// are made by config/doctor.mjs on the host, from the same list the page uses.
export async function GET(req: Request) {
  if (!doctorKeyOk(req.headers.get("x-doctor-key"))) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(await gatherSiteFacts(), { headers: { "Cache-Control": "no-store" } });
}
