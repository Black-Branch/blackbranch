// The command's door into the site: `blackbranch doctor` asks for the site's
// facts from inside the web container, with the STREAM_API_SECRET web already holds — so the
// secret never leaves the container. Compared as digests, in constant time. Pure: tested directly.
import { secretOk } from "../internalSecret.ts";

export function doctorKeyOk(given: string | null, secret = process.env.STREAM_API_SECRET): boolean {
  return secretOk(given, secret);
}
