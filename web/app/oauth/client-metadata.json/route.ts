// Serves the AT Protocol OAuth client metadata document. Its URL is the client_id.
import { clientMetadata } from "@/app/lib/atprotoClient";

// Request time: the document names this install's origin (nothing is prerendered).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(clientMetadata());
}
