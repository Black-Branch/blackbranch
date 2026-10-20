// Serves the public JWKS for the confidential ATProto OAuth client (private_key_jwt).
import { getAtprotoClient } from "@/app/lib/atprotoClient";

export async function GET() {
  const client = await getAtprotoClient();
  return Response.json(client.jwks);
}
