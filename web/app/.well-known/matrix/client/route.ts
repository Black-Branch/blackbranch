// GET /.well-known/matrix/client — built from config (app/lib/matrixWellKnown.ts says what and why).
// Dynamic: `account` comes from the homeserver's auth_metadata, cached in-process.
import { clientWellKnown, WELL_KNOWN_HEADERS } from "@/app/lib/matrixWellKnown";
import { matrixBaseUrl, matrixOAuthIssuer } from "@/app/lib/matrixConfig";
import { authMetadataOrNull } from "@/app/lib/matrixAuthMetadata";

export const dynamic = "force-dynamic";

export async function GET() {
  const md = await authMetadataOrNull();
  const doc = clientWellKnown(matrixBaseUrl(), matrixOAuthIssuer(), md?.accountManagementUri ?? null);
  return Response.json(doc, { headers: { ...WELL_KNOWN_HEADERS, "Cache-Control": "public, max-age=0" } });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: WELL_KNOWN_HEADERS });
}
