// GET /.well-known/matrix/server — federation delegation, built from config at request time (every
// input is an install value, read when the server starts; app/lib/matrixWellKnown.ts says what and why).
import { serverWellKnown, WELL_KNOWN_HEADERS } from "@/app/lib/matrixWellKnown";
import { matrixFederationServer } from "@/app/lib/matrixConfig";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(serverWellKnown(matrixFederationServer()), {
    headers: { ...WELL_KNOWN_HEADERS, "Cache-Control": "public, max-age=0" },
  });
}
